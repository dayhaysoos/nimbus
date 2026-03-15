import type { Sandbox } from '@cloudflare/sandbox';
import type { AuthContext, Env, WorkspaceOperationType, WorkspaceResponse } from '../types.js';
import { parseCheckpointCreateRequest } from './checkpoint-jobs.js';
import type { ParsedCheckpointCreateRequest } from './checkpoint-jobs.js';
import {
  appendWorkspaceEvent,
  createWorkspaceArtifact,
  createWorkspaceOperation,
  claimWorkspaceOperationForExecution,
  createWorkspace,
  generateWorkspaceArtifactId,
  generateWorkspaceOperationId,
  generateWorkspaceId,
  getWorkspace,
  getWorkspaceAccountId,
  getWorkspaceArtifactById,
  getWorkspaceOperation,
  listWorkspaceArtifacts,
  listWorkspaceEvents,
  markWorkspaceDeleted,
  markWorkspaceFailed,
  markWorkspaceReady,
  updateWorkspaceOperationStatus,
  WorkspaceIdempotencyConflictError,
} from '../lib/db.js';
import { canAccessAccount } from '../lib/authz.js';

const WORKSPACE_ROOT = '/workspace';
const BUNDLE_BASE64_PATH = '/tmp/workspace-source.tar.gz.base64';
const BUNDLE_PATH = '/tmp/workspace-source.tar.gz';
const BUNDLE_BASE64_PART_PREFIX = '/tmp/workspace-source.tar.gz.base64.part';
const BUNDLE_BASE64_CHUNK_BYTES = 510 * 1024;
const DEFAULT_DIFF_MAX_BYTES = 128 * 1024;
const MAX_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FILE_READ_MAX_BYTES = 256 * 1024;
const MAX_FILE_READ_MAX_BYTES = 2 * 1024 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Nimbus-Api-Key',
};

interface SandboxClient {
  exec(
    command: string,
    options?: {
      timeout?: number;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, contents: string): Promise<unknown>;
  destroy(): Promise<void>;
}

interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface WorkspaceDiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
}

interface TruncatedChangedFiles {
  files: WorkspaceDiffFile[];
  truncated: boolean;
  bytes: number;
  totalBytes: number;
}

interface WorkspaceFileEntry {
  path: string;
  type: 'file' | 'directory';
}

interface GithubTargetPayload {
  owner: string;
  repo: string;
  branch?: string;
}

interface ForkGithubPayload {
  target: GithubTargetPayload;
  commit?: {
    message?: string;
  };
  installationId?: number;
}

interface GithubRequestOptions {
  method?: string;
  token: string;
  body?: unknown;
}

interface GitHubApiErrorShape {
  message?: string;
}

class OperationPreflightError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OperationPreflightError';
  }
}

async function executeSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  options?: { timeout?: number }
): Promise<SandboxCommandResult> {
  return sandbox.exec(command, options);
}

async function runSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  options?: { timeout?: number }
): Promise<void> {
  const result = await executeSandboxCommand(sandbox, command, options);
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
  }
}

async function runSandboxCommandWithOutput(
  sandbox: SandboxClient,
  command: string,
  options?: { timeout?: number }
): Promise<string> {
  const result = await executeSandboxCommand(sandbox, command, options);
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
  }

  return result.stdout;
}

function isSandboxAlreadyGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(sandbox.*not found|sandbox.*does not exist|no such sandbox|already destroyed)/i.test(message);
}

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

async function sha256Hex(input: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return toHex(new Uint8Array(digest));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function sourceBundleR2Key(workspaceId: string, commitSha: string): string {
  return `workspaces/${workspaceId}/source/${commitSha}.tar.gz`;
}

async function getWorkspaceSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;
}

async function writeBundleBase64InChunks(sandbox: SandboxClient, bundleBytes: ArrayBuffer): Promise<void> {
  const bytes = new Uint8Array(bundleBytes);

  await runSandboxCommand(sandbox, `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`);

  let partIndex = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += BUNDLE_BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + BUNDLE_BASE64_CHUNK_BYTES, bytes.byteLength));
    const chunkBase64 = toBase64(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    const partPath = `${BUNDLE_BASE64_PART_PREFIX}.${String(partIndex).padStart(4, '0')}`;
    await sandbox.writeFile(partPath, chunkBase64);
    partIndex += 1;
  }

  await runSandboxCommand(sandbox, `cat ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}.* > ${shellQuote(BUNDLE_BASE64_PATH)}`);
}

async function hydrateWorkspaceFilesystem(env: Env, sandboxId: string, sourceBytes: ArrayBuffer): Promise<void> {
  const sandbox = await getWorkspaceSandbox(env, sandboxId);

  await runSandboxCommand(sandbox, `rm -rf ${shellQuote(WORKSPACE_ROOT)} && mkdir -p ${shellQuote(WORKSPACE_ROOT)}`);
  await writeBundleBase64InChunks(sandbox, sourceBytes);
  await runSandboxCommand(
    sandbox,
    `base64 -d ${shellQuote(BUNDLE_BASE64_PATH)} > ${shellQuote(BUNDLE_PATH)} && tar -xzf ${shellQuote(BUNDLE_PATH)} -C ${shellQuote(WORKSPACE_ROOT)}`,
    { timeout: 8 * 60 * 1000 }
  );
  await runSandboxCommand(
    sandbox,
    `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function requireWorkspaceAccess(env: Env, workspaceId: string, authContext?: AuthContext): Promise<Response | null> {
  if (!authContext) {
    return null;
  }
  const accountId = await getWorkspaceAccountId(env.DB, workspaceId);
  if (!canAccessAccount(authContext, accountId)) {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  return null;
}

function buildWorkspaceCreateFallback(input: {
  workspaceId: string;
  sourceType: 'checkpoint';
  checkpointId: string | null;
  commitSha: string;
  sourceRef?: string;
  sourceProjectRoot?: string;
  sourceBundleKey: string;
  sourceBundleSha256: string;
  sourceBundleBytes: number;
  sandboxId: string;
  baselineReady: boolean;
}): WorkspaceResponse {
  const now = new Date().toISOString();
  return {
    id: input.workspaceId,
    status: 'ready',
    sourceType: input.sourceType,
    checkpointId: input.checkpointId,
    commitSha: input.commitSha,
    sourceRef: input.sourceRef ?? null,
    sourceProjectRoot: input.sourceProjectRoot ?? null,
    sourceBundleKey: input.sourceBundleKey,
    sourceBundleSha256: input.sourceBundleSha256,
    sourceBundleBytes: input.sourceBundleBytes,
    sandboxId: input.sandboxId,
    baselineReady: input.baselineReady,
    errorCode: null,
    errorMessage: null,
    lastDeploymentId: null,
    lastDeploymentStatus: null,
    lastDeployedUrl: null,
    lastDeployedAt: null,
    lastDeploymentErrorCode: null,
    lastDeploymentErrorMessage: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    eventsUrl: `/api/workspaces/${input.workspaceId}/events`,
  };
}

function parseBooleanQueryParam(url: URL, key: string): boolean {
  const value = url.searchParams.get(key);
  return value === 'true' || value === '1';
}

function parseMaxBytes(url: URL, key: string, defaultValue: number, maxValue: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return Math.min(Math.max(2, Math.floor(parsed)), maxValue);
}

function isWorkspacePathValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message === 'Invalid path' ||
    error.message === 'Path traversal is not allowed' ||
    error.message === 'Resolved path escapes workspace root' ||
    error.message === 'Query parameter "path" is required' ||
    error.message === 'Query parameter "path" must point to a file'
  );
}

function normalizeWorkspacePath(raw: string | null, forFile = false): string {
  const initial = (raw ?? '.').trim();
  if (!initial) {
    if (forFile) {
      throw new Error('Query parameter "path" is required');
    }
    return '.';
  }

  const normalizedSlashes = initial.replace(/\\/g, '/');
  if (normalizedSlashes.includes('\u0000')) {
    throw new Error('Invalid path');
  }

  const withoutLeading = normalizedSlashes.replace(/^\/+/, '');
  const parts = withoutLeading.split('/').filter((segment) => segment.length > 0 && segment !== '.');

  for (const part of parts) {
    if (part === '..') {
      throw new Error('Path traversal is not allowed');
    }
  }

  const normalized = parts.join('/');
  if (forFile && normalized.length === 0) {
    throw new Error('Query parameter "path" must point to a file');
  }

  return normalized || '.';
}

async function ensureWorkspaceGitBaseline(sandbox: SandboxClient): Promise<void> {
  const hasHead = await executeSandboxCommand(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && git rev-parse --verify HEAD >/dev/null 2>&1`
  );

  if (hasHead.exitCode === 0) {
    return;
  }

  await runSandboxCommand(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && git init -q && git config user.email ${shellQuote('nimbus@workspace.local')} && git config user.name ${shellQuote('Nimbus Workspace')} && git add -A && git commit -q --allow-empty -m ${shellQuote('workspace baseline')}`
  );
}

async function workspaceHasGitHead(sandbox: SandboxClient): Promise<boolean> {
  const result = await executeSandboxCommand(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && git rev-parse --verify HEAD >/dev/null 2>&1`
  );

  return result.exitCode === 0;
}

async function exportWorkspaceZipBase64(sandbox: SandboxClient): Promise<string> {
  return runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(
      WORKSPACE_ROOT
    )} && tmp_zip=$(mktemp /tmp/nimbus-workspace-export.XXXXXX.zip) && rm -f "$tmp_zip" && if command -v zip >/dev/null 2>&1; then zip -q -r "$tmp_zip" . -x '.git/*' '*/.git/*' '*/._*' '._*'; else python3 - "$tmp_zip" <<'PY'\nimport os\nimport sys\nimport zipfile\n\nzip_path = sys.argv[1]\nroot = os.getcwd()\nwith zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:\n    for dirpath, dirnames, filenames in os.walk(root):\n        rel_dir = os.path.relpath(dirpath, root)\n        if rel_dir == '.git' or rel_dir.startswith('.git' + os.sep):\n            continue\n        dirnames[:] = [d for d in dirnames if d != '.git' and not d.startswith('._')]\n        for name in filenames:\n            if name.startswith('._'):\n                continue\n            abs_path = os.path.join(dirpath, name)\n            rel_path = os.path.relpath(abs_path, root)\n            if rel_path == '.git' or rel_path.startswith('.git' + os.sep):\n                continue\n            zf.write(abs_path, rel_path)\nPY\nfi && base64 "$tmp_zip" && rm -f "$tmp_zip"`
  );
}

function parseForkGithubPayload(payload: Record<string, unknown>): ForkGithubPayload {
  const target = payload.target;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new OperationPreflightError('invalid_request', 'Fork request requires a target object');
  }

  const owner = String((target as Record<string, unknown>).owner ?? '').trim();
  const repo = String((target as Record<string, unknown>).repo ?? '').trim();
  const branchRaw = (target as Record<string, unknown>).branch;
  const branch = typeof branchRaw === 'string' ? branchRaw.trim() : undefined;
  if (!owner || !repo) {
    throw new OperationPreflightError('invalid_request', 'Fork request target requires owner and repo');
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new OperationPreflightError('invalid_request', 'Fork request target owner is invalid');
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.includes('..') || repo.includes('/')) {
    throw new OperationPreflightError('invalid_request', 'Fork request target repo is invalid');
  }

  const commitInput = payload.commit;
  let commitMessage: string | undefined;
  if (commitInput && typeof commitInput === 'object' && !Array.isArray(commitInput)) {
    const maybeMessage = (commitInput as Record<string, unknown>).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      commitMessage = maybeMessage.trim();
    }
  }

  const installationIdRaw = payload.installationId;
  let installationId: number | undefined;
  if (typeof installationIdRaw === 'number' && Number.isFinite(installationIdRaw)) {
    const normalized = Math.floor(installationIdRaw);
    if (!Number.isSafeInteger(normalized) || normalized <= 0) {
      throw new OperationPreflightError('invalid_request', 'installationId must be a positive integer');
    }
    installationId = normalized;
  }

  return {
    target: { owner, repo, branch },
    commit: commitMessage ? { message: commitMessage } : undefined,
    installationId,
  };
}

function getAllowedForkOrgs(env: Env): Set<string> {
  return new Set(
    (env.GITHUB_FORK_ALLOWED_ORGS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  );
}

function enforceForkTargetPolicy(env: Env, owner: string): void {
  const allowedOrgs = getAllowedForkOrgs(env);
  if (allowedOrgs.size === 0) {
    return;
  }

  if (!allowedOrgs.has(owner.toLowerCase())) {
    throw new OperationPreflightError('target_repo_not_allowed', 'Target repository owner is not allowed', {
      owner,
      policy: 'org_allowlist',
    });
  }
}

function base64UrlEncodeString(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }

  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function derWrap(tag: number, body: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), encodeDerLength(body.length), body);
}

function convertPkcs1DerToPkcs8Der(pkcs1Der: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithmIdentifier = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00
  );
  const privateKeyOctetString = derWrap(0x04, pkcs1Der);
  return derWrap(0x30, concatBytes(version, rsaAlgorithmIdentifier, privateKeyOctetString));
}

function decodePemBody(pem: string): { der: Uint8Array; type: 'pkcs8' | 'pkcs1' } {
  const normalized = pem.replace(/\r/g, '').trim();
  const pkcs8Match = normalized.match(/-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/);
  if (pkcs8Match?.[1]) {
    return { der: fromBase64(pkcs8Match[1]), type: 'pkcs8' };
  }

  const pkcs1Match = normalized.match(
    /-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/
  );
  if (pkcs1Match?.[1]) {
    return { der: fromBase64(pkcs1Match[1]), type: 'pkcs1' };
  }

  throw new OperationPreflightError(
    'configuration_invalid',
    'GITHUB_APP_PRIVATE_KEY must be PKCS#8 (BEGIN PRIVATE KEY) or PKCS#1 (BEGIN RSA PRIVATE KEY) PEM'
  );
}

async function createGitHubAppJwt(env: Env): Promise<string> {
  if (env.GITHUB_APP_JWT && env.GITHUB_APP_JWT.trim()) {
    return env.GITHUB_APP_JWT.trim();
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new OperationPreflightError(
      'configuration_missing',
      'GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for GitHub fork operations'
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000) - 30;
  const payload = {
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: env.GITHUB_APP_ID,
  };

  const headerPart = base64UrlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadPart = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;

  const pem = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n').trim();
  let signaturePart: string;
  try {
    const decoded = decodePemBody(pem);
    const privateKeyDer = decoded.type === 'pkcs1' ? convertPkcs1DerToPkcs8Der(decoded.der) : decoded.der;
    const key = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyDer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
    signaturePart = base64UrlEncodeBytes(new Uint8Array(signature));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OperationPreflightError('configuration_invalid', `Invalid GitHub App private key: ${message}`);
  }

  return `${signingInput}.${signaturePart}`;
}

async function githubRequest<T>(env: Env, path: string, options: GithubRequestOptions): Promise<T> {
  const baseUrl = (env.GITHUB_API_BASE_URL ?? 'https://api.github.com').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${options.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    const apiError = json as GitHubApiErrorShape | null;
    throw new OperationPreflightError('github_api_error', apiError?.message || 'GitHub API request failed', {
      path,
      status: response.status,
    });
  }

  return json as T;
}

function formatTimestamp(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const sec = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${sec}`;
}

function sanitizeBranchName(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/_+/g, '_')
    .replace(/^[-/_.]+/, '')
    .replace(/[-/_.]+$/, '');

  const clamped = normalized.slice(0, 240);
  if (!clamped) {
    throw new OperationPreflightError('invalid_branch', 'Computed branch name is empty after sanitization');
  }

  return clamped;
}

function getDefaultForkBranch(workspaceId: string): string {
  return sanitizeBranchName(`nimbus/${workspaceId}/${formatTimestamp(new Date())}`);
}

async function resolveGitHubInstallationId(
  env: Env,
  appJwt: string,
  owner: string,
  repo: string,
  installationOverride?: number
): Promise<number> {
  if (installationOverride) {
    return installationOverride;
  }

  const installation = await githubRequest<{ id: number }>(env, `/repos/${owner}/${repo}/installation`, {
    token: appJwt,
  });
  return installation.id;
}

async function createInstallationToken(env: Env, appJwt: string, installationId: number): Promise<string> {
  const tokenResponse = await githubRequest<{ token: string }>(
    env,
    `/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      token: appJwt,
      body: {},
    }
  );
  return tokenResponse.token;
}

async function resolveBranchForFork(
  env: Env,
  token: string,
  owner: string,
  repo: string,
  requestedBranch: string | undefined,
  workspaceId: string
): Promise<{ branch: string; explicit: boolean }> {
  const explicit = Boolean(requestedBranch && requestedBranch.trim().length > 0);
  const branchBase = sanitizeBranchName(requestedBranch?.trim() || getDefaultForkBranch(workspaceId));
  if (explicit) {
    try {
      await githubRequest(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branchBase)}`, {
        token,
      });
      throw new OperationPreflightError('branch_exists', 'Requested branch already exists', {
        branch: branchBase,
      });
    } catch (error) {
      if (error instanceof OperationPreflightError && error.code === 'github_api_error') {
        const details = error.details ?? {};
        if (typeof details === 'object' && details && (details as Record<string, unknown>).status === 404) {
          return { branch: branchBase, explicit: true };
        }
      }
      if (error instanceof OperationPreflightError && error.code === 'branch_exists') {
        throw error;
      }
      throw error;
    }
  }

  let candidate = branchBase;
  for (let index = 1; index <= 50; index += 1) {
    try {
      await githubRequest(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(candidate)}`, {
        token,
      });
      candidate = `${branchBase}-${index + 1}`;
    } catch (error) {
      if (error instanceof OperationPreflightError && error.code === 'github_api_error') {
        const details = error.details ?? {};
        if (typeof details === 'object' && details && (details as Record<string, unknown>).status === 404) {
          return { branch: candidate, explicit: false };
        }
      }
      throw error;
    }
  }

  throw new OperationPreflightError('branch_exists', 'Unable to allocate non-colliding generated branch');
}

async function listOversizedWorkspaceFiles(
  sandbox: SandboxClient,
  maxBytes: number
): Promise<Array<{ path: string; size: number }>> {
  const output = await runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && python3 - ${Math.floor(maxBytes)} <<'PY'\nimport json\nimport os\nimport sys\n\nlimit = int(sys.argv[1])\nroot = os.getcwd()\noversized = []\nfor dirpath, dirnames, filenames in os.walk(root):\n    rel_dir = os.path.relpath(dirpath, root)\n    if rel_dir == '.git' or rel_dir.startswith('.git' + os.sep):\n        continue\n    dirnames[:] = [d for d in dirnames if d != '.git']\n    for name in filenames:\n        absolute = os.path.join(dirpath, name)\n        try:\n            size = os.path.getsize(absolute)\n        except OSError:\n            continue\n        if size > limit:\n            rel = os.path.relpath(absolute, root)\n            oversized.append({'path': rel, 'size': int(size)})\nprint(json.dumps(oversized))\nPY`
  );

  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter((item): item is { path: string; size: number } => {
      return Boolean(
        item &&
          typeof item === 'object' &&
          typeof (item as { path?: unknown }).path === 'string' &&
          typeof (item as { size?: unknown }).size === 'number'
      );
    })
    .slice(0, 200);
}

async function detectPotentialSecrets(sandbox: SandboxClient): Promise<string[]> {
  const output = await runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && python3 - <<'PY'\nimport json\nimport os\nimport re\n\npattern = re.compile(r'(^|/)(\\.env(\\.|$)|id_rsa|id_dsa|.*\\.pem$|.*\\.p12$|.*\\.key$)', re.IGNORECASE)\nroot = os.getcwd()\nmatches = []\nfor dirpath, dirnames, filenames in os.walk(root):\n    rel_dir = os.path.relpath(dirpath, root)\n    if rel_dir == '.git' or rel_dir.startswith('.git' + os.sep):\n        continue\n    dirnames[:] = [d for d in dirnames if d != '.git']\n    for name in filenames:\n        absolute = os.path.join(dirpath, name)\n        rel = os.path.relpath(absolute, root).replace('\\\\', '/')\n        if pattern.search(rel):\n            matches.append(rel)\nprint(json.dumps(matches))\nPY`
  );

  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((value): value is string => typeof value === 'string').slice(0, 25);
}

async function workspaceHasChanges(sandbox: SandboxClient): Promise<boolean> {
  const output = await runWorkspaceDiffAgainstHead(sandbox, '--name-only');
  return output.trim().length > 0;
}

async function executeForkCommitAndPushInSandbox(
  sandbox: SandboxClient,
  input: {
    owner: string;
    repo: string;
    token: string;
    baselineSha: string;
    branch: string;
    commitMessage: string;
  }
): Promise<string> {
  const remoteUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const suffix = Math.random().toString(36).slice(2, 10);
  const tokenPath = `/tmp/nimbus-gh-token-${suffix}`;
  const askpassPath = `/tmp/nimbus-gh-askpass-${suffix}.sh`;

  await sandbox.writeFile(tokenPath, `${input.token}\n`);
  await sandbox.writeFile(
    askpassPath,
    `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *) cat ${shellQuote(
      tokenPath
    )} ;;\nesac\n`
  );

  const output = await runSandboxCommandWithOutput(
    sandbox,
    `tmp_repo=$(mktemp -d /tmp/nimbus-fork.XXXXXX) && cleanup(){ rm -rf "$tmp_repo" ${shellQuote(
      tokenPath
    )} ${shellQuote(askpassPath)}; } && trap cleanup EXIT && chmod 700 ${shellQuote(
      askpassPath
    )} && export GIT_ASKPASS=${shellQuote(
      askpassPath
    )} GIT_TERMINAL_PROMPT=0 && git init -q "$tmp_repo" && cd "$tmp_repo" && git remote add origin ${shellQuote(
      remoteUrl
    )} && git fetch -q origin ${shellQuote(input.baselineSha)} && git checkout -q -b ${shellQuote(
      input.branch
    )} ${shellQuote(input.baselineSha)} && find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && tar -C ${shellQuote(
      WORKSPACE_ROOT
    )} --exclude='.git' -cf - . | tar -C "$tmp_repo" -xf - && git config user.email ${shellQuote(
      'nimbus@app.local'
    )} && git config user.name ${shellQuote(
      'Nimbus'
    )} && git add -A && if git diff --cached --quiet; then echo __NIMBUS_NO_CHANGES__; exit 0; fi && git commit -q -m ${shellQuote(
      input.commitMessage
    )} && git rev-parse HEAD && git push -q origin ${shellQuote(`HEAD:refs/heads/${input.branch}`)}`,
    { timeout: 10 * 60 * 1000 }
  );

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.includes('__NIMBUS_NO_CHANGES__')) {
    throw new OperationPreflightError('no_changes', 'Workspace has no changes to fork');
  }

  const commitSha = lines.find((line) => /^[0-9a-f]{40}$/i.test(line));
  if (!commitSha) {
    throw new Error('Unable to determine commit SHA after push');
  }

  return commitSha;
}

async function runWorkspaceDiffAgainstHead(
  sandbox: SandboxClient,
  diffArgs: string,
  maxOutputBytes?: number
): Promise<string> {
  const trimmedArgs = diffArgs.trim();
  const diffCommand = `GIT_INDEX_FILE="$tmp_index" git diff --cached -M HEAD${trimmedArgs ? ` ${trimmedArgs}` : ''}`;
  const readDiffCommand =
    typeof maxOutputBytes === 'number' && Number.isFinite(maxOutputBytes) && maxOutputBytes > 0
      ? `head -c ${Math.floor(maxOutputBytes)} "$tmp_diff"`
      : `cat "$tmp_diff"`;

  return runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && tmp_index=$(mktemp /tmp/nimbus-git-index.XXXXXX) && tmp_diff=$(mktemp /tmp/nimbus-git-diff.XXXXXX) && cleanup(){ rm -f "$tmp_index" "$tmp_diff"; } && trap cleanup EXIT && GIT_INDEX_FILE="$tmp_index" git read-tree HEAD && GIT_INDEX_FILE="$tmp_index" git add -A && ${diffCommand} > "$tmp_diff" && ${readDiffCommand}`
  );
}

export function parseWorkspaceListEntries(output: string, requestedPath: string): WorkspaceFileEntry[] {
  const tokens = output.split('\u0000').filter((token) => token.length > 0);
  const entries: WorkspaceFileEntry[] = [];

  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const name = tokens[i];
    const typeToken = tokens[i + 1];
    if (!name || name === '.' || name === '..') {
      continue;
    }

    const type = typeToken === 'directory' ? 'directory' : 'file';
    entries.push({
      path: requestedPath === '.' ? name : `${requestedPath}/${name}`,
      type,
    });
  }

  return entries;
}

export function parseDiffNameStatus(output: string): WorkspaceDiffFile[] {
  const tokens = output.split('\u0000').filter((token) => token.length > 0);

  const files: WorkspaceDiffFile[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let code = token;
    let firstPath: string | null = null;

    const tabIndex = token.indexOf('\t');
    if (tabIndex >= 0) {
      code = token.slice(0, tabIndex);
      const candidatePath = token.slice(tabIndex + 1);
      if (candidatePath.length > 0) {
        firstPath = candidatePath;
      }
    }

    if (firstPath === null) {
      firstPath = tokens[index + 1] ?? null;
      if (firstPath !== null) {
        index += 1;
      }
    }

    if (!firstPath) {
      continue;
    }

    if (code.startsWith('R') || code.startsWith('C')) {
      let secondPath: string | null = tokens[index + 1] ?? null;
      if (secondPath !== null) {
        index += 1;
      }

      if (!secondPath && firstPath.includes('\t')) {
        const renameSplit = firstPath.indexOf('\t');
        secondPath = firstPath.slice(renameSplit + 1);
        firstPath = firstPath.slice(0, renameSplit);
      }

      if (!secondPath) {
        continue;
      }

      files.push({ status: 'renamed', previousPath: firstPath, path: secondPath });
      continue;
    }

    if (code.startsWith('A')) {
      files.push({ status: 'added', path: firstPath });
      continue;
    }

    if (code.startsWith('D')) {
      files.push({ status: 'deleted', path: firstPath });
      continue;
    }

    files.push({ status: 'modified', path: firstPath });
  }

  return files;
}

export function trimNameStatusToCompleteRecords(output: string): string {
  if (!output) {
    return output;
  }

  const hasTrailingNull = output.endsWith('\u0000');
  const splitTokens = output.split('\u0000');
  const tokens = hasTrailingNull ? splitTokens.slice(0, -1) : splitTokens.slice(0, -1);
  const kept: string[] = [];

  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index];
    if (!statusToken) {
      index += 1;
      continue;
    }

    const tabIndex = statusToken.indexOf('\t');
    if (tabIndex >= 0) {
      const code = statusToken.slice(0, tabIndex);
      const inlinePath = statusToken.slice(tabIndex + 1);

      if (code.startsWith('R') || code.startsWith('C')) {
        if (inlinePath.includes('\t')) {
          kept.push(statusToken);
          index += 1;
          continue;
        }

        if (index + 1 < tokens.length) {
          kept.push(statusToken, tokens[index + 1]);
          index += 2;
          continue;
        }

        break;
      }

      if (inlinePath.length > 0) {
        kept.push(statusToken);
        index += 1;
        continue;
      }

      if (index + 1 < tokens.length) {
        kept.push(statusToken, tokens[index + 1]);
        index += 2;
        continue;
      }

      break;
    }

    if (statusToken.startsWith('R') || statusToken.startsWith('C')) {
      if (index + 2 < tokens.length) {
        kept.push(statusToken, tokens[index + 1], tokens[index + 2]);
        index += 3;
        continue;
      }

      break;
    }

    if (index + 1 < tokens.length) {
      kept.push(statusToken, tokens[index + 1]);
      index += 2;
      continue;
    }

    break;
  }

  if (kept.length === 0) {
    return '';
  }

  return `${kept.join('\u0000')}\u0000`;
}

export function truncateChangedFilesByBytes(changedFiles: WorkspaceDiffFile[], maxBytes: number): TruncatedChangedFiles {
  const encoder = new TextEncoder();
  const fullJson = JSON.stringify(changedFiles);
  const fullBytes = encoder.encode(fullJson).byteLength;

  if (fullBytes <= maxBytes) {
    return {
      files: changedFiles,
      truncated: false,
      bytes: fullBytes,
      totalBytes: fullBytes,
    };
  }

  const kept: WorkspaceDiffFile[] = [];
  for (const file of changedFiles) {
    kept.push(file);
    const candidateBytes = encoder.encode(JSON.stringify(kept)).byteLength;
    if (candidateBytes > maxBytes) {
      kept.pop();
      break;
    }
  }

  return {
    files: kept,
    truncated: true,
    bytes: encoder.encode(JSON.stringify(kept)).byteLength,
    totalBytes: fullBytes,
  };
}

export function truncateUtf8(
  input: string,
  maxBytes: number
): { content: string; truncated: boolean; totalBytes: number; returnedBytes: number } {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(input);

  if (bytes.byteLength <= maxBytes) {
    return { content: input, truncated: false, totalBytes: bytes.byteLength, returnedBytes: bytes.byteLength };
  }

  const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let end = maxBytes;
  while (end > 0) {
    try {
      strictDecoder.decode(bytes.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }

  return {
    content: decoder.decode(bytes.subarray(0, end)),
    truncated: true,
    totalBytes: bytes.byteLength,
    returnedBytes: end,
  };
}

async function resolveWorkspaceOr404(env: Env, workspaceId: string): Promise<WorkspaceResponse | null> {
  const workspace = await getWorkspace(env.DB, workspaceId);
  if (!workspace) {
    return null;
  }
  if (workspace.status === 'deleted') {
    return null;
  }
  return workspace;
}

async function resolveWorkspaceRealPath(sandbox: SandboxClient, requestedPath: string): Promise<string> {
  const output = await runSandboxCommandWithOutput(
    sandbox,
    `cd ${shellQuote(WORKSPACE_ROOT)} && realpath -- ${shellQuote(requestedPath)}`
  );

  return output.replace(/\r?\n$/, '');
}

export function assertWorkspaceRootSafe(realPath: string): void {
  if (realPath === WORKSPACE_ROOT || realPath.startsWith(`${WORKSPACE_ROOT}/`)) {
    return;
  }

  throw new Error('Resolved path escapes workspace root');
}

function workspaceNotReadyResponse(workspace: WorkspaceResponse): Response {
  return jsonResponse(
    {
      error: `Workspace is not ready (status: ${workspace.status})`,
      status: workspace.status,
    },
    409
  );
}

function getIdempotencyKey(request: Request): string {
  return (request.headers.get('Idempotency-Key') ?? '').trim();
}

async function sha256HexFromText(input: string): Promise<string> {
  const encoder = new TextEncoder();
  return sha256Hex(encoder.encode(input));
}

async function parseOptionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get('content-length');
  if (contentLength === '0') {
    return {};
  }

  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('Request body must be a JSON object');
  }

  return parsed as Record<string, unknown>;
}

function getArtifactsBucket(env: Env): R2Bucket | null {
  return env.WORKSPACE_ARTIFACTS ?? env.SOURCE_BUNDLES ?? null;
}

function getArtifactDownloadSecret(env: Env): string | null {
  const value = (env.WORKSPACE_ARTIFACT_DOWNLOAD_SECRET ?? '').trim();
  return value.length > 0 ? value : null;
}

async function signArtifactDownload(
  workspaceId: string,
  artifactId: string,
  expiresAtEpochSec: number,
  secret: string
): Promise<string> {
  const payload = `${workspaceId}:${artifactId}:${expiresAtEpochSec}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function sanitizeErrorMessage(input: string): string {
  return input
    .replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:[REDACTED]@')
    .replace(/(authorization:\s*bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(/ghs_[a-z0-9_]+/gi, '[REDACTED_TOKEN]');
}

async function processWorkspaceOperationIfQueued(
  env: Env,
  workspace: WorkspaceResponse,
  operationId: string,
  type: WorkspaceOperationType,
  requestPayload: Record<string, unknown>
): Promise<void> {
  const claimed = await claimWorkspaceOperationForExecution(env.DB, workspace.id, operationId);
  if (!claimed) {
    return;
  }

  let partialForkContext: Record<string, unknown> | null = null;

  try {
    if (type === 'fork_github') {
      const payload = parseForkGithubPayload(requestPayload);
      enforceForkTargetPolicy(env, payload.target.owner);

      const appJwt = await createGitHubAppJwt(env);
      const installationId = await resolveGitHubInstallationId(
        env,
        appJwt,
        payload.target.owner,
        payload.target.repo,
        payload.installationId
      );
      const installationToken = await createInstallationToken(env, appJwt, installationId);

      const repoInfo = await githubRequest<{ default_branch: string }>(
        env,
        `/repos/${payload.target.owner}/${payload.target.repo}`,
        { token: installationToken }
      );

      await githubRequest(
        env,
        `/repos/${payload.target.owner}/${payload.target.repo}/git/commits/${workspace.commitSha}`,
        { token: installationToken }
      );

      const defaultRef = await githubRequest<{ object: { sha: string } }>(
        env,
        `/repos/${payload.target.owner}/${payload.target.repo}/git/ref/heads/${encodeURIComponent(repoInfo.default_branch)}`,
        { token: installationToken }
      );

      const warnings: Array<Record<string, unknown>> = [];
      if (defaultRef.object.sha !== workspace.commitSha) {
        warnings.push({
          code: 'baseline_stale',
          message: 'Forked from workspace baseline while target default branch has moved',
          details: {
            baselineSha: workspace.commitSha,
            defaultBranch: repoInfo.default_branch,
            defaultBranchHeadSha: defaultRef.object.sha,
          },
        });
      }

      const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
      if (!(await workspaceHasGitHead(sandbox))) {
        throw new OperationPreflightError('baseline_missing', 'Workspace git baseline is missing');
      }

      const oversizedFiles = await listOversizedWorkspaceFiles(sandbox, 100 * 1024 * 1024);
      if (oversizedFiles.length > 0) {
        throw new OperationPreflightError('file_too_large_for_github', 'Workspace contains files over GitHub blob limit', {
          files: oversizedFiles,
        });
      }

      const secretMatches = await detectPotentialSecrets(sandbox);
      if (secretMatches.length > 0) {
        const shouldBlock = (env.BLOCK_ON_SECRET_MATCH ?? 'false').toLowerCase() === 'true';
        if (shouldBlock) {
          throw new OperationPreflightError('secret_match_blocked', 'Potential secrets detected in workspace', {
            files: secretMatches,
          });
        }
        warnings.push({
          code: 'secret_match',
          message: `Potential secret patterns detected in ${secretMatches.length} files`,
          details: { files: secretMatches },
        });
      }

      const hasChanges = await workspaceHasChanges(sandbox);
      if (!hasChanges) {
        throw new OperationPreflightError('no_changes', 'Workspace has no changes to fork');
      }

      const resolvedBranch = await resolveBranchForFork(
        env,
        installationToken,
        payload.target.owner,
        payload.target.repo,
        payload.target.branch,
        workspace.id
      );

      partialForkContext = {
        target: {
          owner: payload.target.owner,
          repo: payload.target.repo,
          branch: resolvedBranch.branch,
        },
      };

      await githubRequest(
        env,
        `/repos/${payload.target.owner}/${payload.target.repo}/git/refs`,
        {
          method: 'POST',
          token: installationToken,
          body: {
            ref: `refs/heads/${resolvedBranch.branch}`,
            sha: workspace.commitSha,
          },
        }
      );

      partialForkContext = {
        ...partialForkContext,
        branchCreated: true,
        branchRef: `refs/heads/${resolvedBranch.branch}`,
      };

      const commitMessage =
        payload.commit?.message?.trim() || `Apply Nimbus workspace ${workspace.id} changes from ${workspace.commitSha}`;
      const commitSha = await executeForkCommitAndPushInSandbox(sandbox, {
        owner: payload.target.owner,
        repo: payload.target.repo,
        token: installationToken,
        baselineSha: workspace.commitSha,
        branch: resolvedBranch.branch,
        commitMessage,
      });

      await updateWorkspaceOperationStatus(env.DB, operationId, 'succeeded', {
        warnings,
        result: {
          target: {
            owner: payload.target.owner,
            repo: payload.target.repo,
            branch: resolvedBranch.branch,
          },
          branchRef: `refs/heads/${resolvedBranch.branch}`,
          commitSha,
          repoUrl: `https://github.com/${payload.target.owner}/${payload.target.repo}`,
          compareUrl: `https://github.com/${payload.target.owner}/${payload.target.repo}/compare/${encodeURIComponent(
            repoInfo.default_branch
          )}...${encodeURIComponent(resolvedBranch.branch)}`,
        },
      });
      return;
    }

    const artifactsBucket = getArtifactsBucket(env);
    if (!artifactsBucket) {
      throw new Error('No artifact bucket is configured (WORKSPACE_ARTIFACTS or SOURCE_BUNDLES)');
    }

    const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
    if (type === 'export_patch' && !(await workspaceHasGitHead(sandbox))) {
      throw new Error('Workspace git baseline is missing');
    }

    let contentType = 'text/plain';
    let extension = 'txt';
    let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let warnings: Array<Record<string, unknown>> = [];
    const metadata: Record<string, unknown> = {};

    if (type === 'export_patch') {
      const content = await runWorkspaceDiffAgainstHead(sandbox, '');
      bytes = new TextEncoder().encode(content);
      contentType = 'text/x-diff';
      extension = 'patch';

      const binaryNumstat = await runWorkspaceDiffAgainstHead(sandbox, '--numstat -z');
      const binaryFiles: string[] = [];
      const tokens = binaryNumstat.split('\u0000').filter((token) => token.length > 0);
      for (const token of tokens) {
        const parts = token.split('\t');
        if (parts.length === 3 && parts[0] === '-' && parts[1] === '-') {
          binaryFiles.push(parts[2]);
        }
      }
      if (binaryFiles.length > 0) {
        warnings.push({
          code: 'binary_excluded',
          message: `${binaryFiles.length} binary files excluded from patch`,
          details: { files: binaryFiles },
        });
      }
      metadata.binaryExcludedCount = binaryFiles.length;
    } else {
      const zipBase64 = await exportWorkspaceZipBase64(sandbox);
      bytes = fromBase64(zipBase64);
      contentType = 'application/zip';
      extension = 'zip';
      metadata.includesGitMetadata = false;
    }

    const sha = await sha256Hex(bytes);
    const artifactId = generateWorkspaceArtifactId();
    const objectKey = `workspaces/${workspace.id}/artifacts/${artifactId}.${extension}`;
    await artifactsBucket.put(objectKey, bytes, {
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        workspace_id: workspace.id,
        operation_id: operationId,
        artifact_type: type === 'export_patch' ? 'patch' : 'zip',
      },
    });

    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + retentionMs).toISOString();
    await createWorkspaceArtifact(env.DB, {
      id: artifactId,
      workspaceId: workspace.id,
      operationId,
      type: type === 'export_patch' ? 'patch' : 'zip',
      objectKey,
      bytes: bytes.byteLength,
      contentType,
      sha256: sha,
      sourceBaselineSha: workspace.commitSha,
      retentionExpiresAt: expiresAt,
      warnings,
      metadata,
    });

    await updateWorkspaceOperationStatus(env.DB, operationId, 'succeeded', {
      result: { artifactId },
      warnings,
    });
  } catch (error) {
    if (error instanceof OperationPreflightError) {
      await updateWorkspaceOperationStatus(env.DB, operationId, 'failed', {
        errorCode: error.code,
        errorClass: 'preflight_error',
        errorMessage: error.message,
        errorDetails: {
          ...(error.details ?? {}),
          ...(partialForkContext ? { partial: partialForkContext } : {}),
        },
      });
      return;
    }

    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    await updateWorkspaceOperationStatus(env.DB, operationId, 'failed', {
      errorCode: 'operation_failed',
      errorClass: 'runtime_error',
      errorMessage: message,
      errorDetails: {
        operationType: type,
        ...(partialForkContext ? { partial: partialForkContext } : {}),
      },
    });
  }
}

async function handleCreateWorkspaceOperation(
  workspaceId: string,
  request: Request,
  env: Env,
  type: WorkspaceOperationType,
  authContext?: AuthContext,
  ctx?: ExecutionContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await resolveWorkspaceOr404(env, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    if (workspace.status !== 'ready') {
      return workspaceNotReadyResponse(workspace);
    }

    const idempotencyKey = getIdempotencyKey(request);
    if (!idempotencyKey) {
      return jsonResponse({ error: 'Missing required Idempotency-Key header' }, 400);
    }

    const payload = await parseOptionalJsonBody(request);
    const payloadHash = await sha256HexFromText(JSON.stringify(payload));
    const operationId = generateWorkspaceOperationId();

    const created = await createWorkspaceOperation(env.DB, {
      id: operationId,
      workspaceId,
      type,
      idempotencyKey,
      requestPayload: payload,
      requestPayloadSha256: payloadHash,
    });

    if (created.operation.status === 'queued') {
      const execution = processWorkspaceOperationIfQueued(env, workspace, created.operation.id, type, payload);
      if (ctx) {
        ctx.waitUntil(execution);
      } else {
        await execution;
      }
    }

    const latestOperation = await getWorkspaceOperation(env.DB, workspaceId, created.operation.id);
    const operationResponse = latestOperation ?? created.operation;

    return jsonResponse({ operation: operationResponse }, 202);
  } catch (error) {
    if (error instanceof WorkspaceIdempotencyConflictError) {
      return jsonResponse(
        {
          error: {
            code: 'idempotency_conflict',
            message: 'Idempotency key was already used with a different payload.',
          },
        },
        409
      );
    }
    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleCreateWorkspace(request: Request, env: Env, authContext?: AuthContext): Promise<Response> {
  if (!env.SOURCE_BUNDLES) {
    return jsonResponse({ error: 'SOURCE_BUNDLES R2 binding is not configured' }, 500);
  }

  let parsed: ParsedCheckpointCreateRequest;
  try {
    parsed = await parseCheckpointCreateRequest(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 400);
  }

  const workspaceId = generateWorkspaceId();
  const sandboxId = `workspace-${workspaceId}`;
  const sourceBundleKey = sourceBundleR2Key(workspaceId, parsed.metadata.source.commitSha);
  let bundleUploaded = false;
  let workspaceCreated = false;
  let workspaceReadyPersisted = false;
  let baselineReady = true;

  try {
    await env.SOURCE_BUNDLES.put(sourceBundleKey, parsed.bundleArrayBuffer, {
      httpMetadata: {
        contentType: parsed.bundle.type || 'application/gzip',
      },
      customMetadata: {
        source_type: parsed.metadata.source.type,
        checkpoint_id: parsed.metadata.source.checkpointId ?? '',
        commit_sha: parsed.metadata.source.commitSha,
        source_ref: parsed.metadata.source.ref ?? '',
        source_project_root: parsed.metadata.source.projectRoot ?? '',
      },
    });
    bundleUploaded = true;

    await createWorkspace(env.DB, {
      id: workspaceId,
      sourceType: parsed.metadata.source.type,
      checkpointId: parsed.metadata.source.checkpointId,
      commitSha: parsed.metadata.source.commitSha,
      sourceRef: parsed.metadata.source.ref,
      sourceProjectRoot: parsed.metadata.source.projectRoot,
      sourceBundleKey,
      sourceBundleSha256: parsed.bundleSha256,
      sourceBundleBytes: parsed.bundleBytes,
      sandboxId,
      accountId: authContext?.isHostedMode ? authContext.accountId : null,
    });
    workspaceCreated = true;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_created',
      payload: {
        checkpointId: parsed.metadata.source.checkpointId,
        commitSha: parsed.metadata.source.commitSha,
        sourceRef: parsed.metadata.source.ref ?? null,
      },
    });

    await hydrateWorkspaceFilesystem(env, sandboxId, parsed.bundleArrayBuffer);
    const workspaceSandbox = await getWorkspaceSandbox(env, sandboxId);
    try {
      await ensureWorkspaceGitBaseline(workspaceSandbox);
    } catch (error) {
      baselineReady = false;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await appendWorkspaceEvent(env.DB, {
          workspaceId,
          eventType: 'workspace_git_baseline_failed',
          payload: { message },
        });
      } catch {
        // Best-effort event only.
      }
    }
    const markedReady = await markWorkspaceReady(env.DB, workspaceId, baselineReady);
    if (!markedReady) {
      return jsonResponse({ error: 'Workspace can no longer transition to ready (likely deleted)' }, 409);
    }
    workspaceReadyPersisted = true;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_ready',
      payload: {
        baselineReady,
      },
    });

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace created but could not be loaded' }, 500);
    }

    return jsonResponse({ workspace }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (workspaceReadyPersisted) {
      try {
        const workspace = await getWorkspace(env.DB, workspaceId);
        if (workspace) {
          return jsonResponse({ workspace }, 201);
        }
      } catch {
        // Best-effort readback only.
      }

      const workspace = buildWorkspaceCreateFallback({
        workspaceId,
        sourceType: parsed.metadata.source.type,
        checkpointId: parsed.metadata.source.checkpointId,
        commitSha: parsed.metadata.source.commitSha,
        sourceRef: parsed.metadata.source.ref,
        sourceProjectRoot: parsed.metadata.source.projectRoot,
        sourceBundleKey,
        sourceBundleSha256: parsed.bundleSha256,
        sourceBundleBytes: parsed.bundleBytes,
        sandboxId,
        baselineReady,
      });

      return jsonResponse(
        {
          workspace,
          warning: `Workspace became ready but post-ready bookkeeping failed: ${message}`,
        },
        201
      );
    }

    if (workspaceCreated) {
      try {
        await markWorkspaceFailed(env.DB, workspaceId, message, 'workspace_create_failed');
        await appendWorkspaceEvent(env.DB, {
          workspaceId,
          eventType: 'workspace_failed',
          payload: { message },
        });
      } catch {
        // Best-effort only.
      }
    }

    if (bundleUploaded && !workspaceCreated) {
      try {
        await env.SOURCE_BUNDLES.delete(sourceBundleKey);
      } catch {
        // Best-effort cleanup.
      }
    }

    return jsonResponse({ error: `Failed to create workspace: ${message}` }, 500);
  }
}

export async function handleGetWorkspace(workspaceId: string, env: Env, authContext?: AuthContext): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);

    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    return jsonResponse(workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleListWorkspaceFiles(
  workspaceId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await resolveWorkspaceOr404(env, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    if (workspace.status !== 'ready') {
      return workspaceNotReadyResponse(workspace);
    }

    const url = new URL(request.url);
    const requestedPath = normalizeWorkspacePath(url.searchParams.get('path'));
    const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);

    const pathCheck = await executeSandboxCommand(
      sandbox,
      `cd ${shellQuote(WORKSPACE_ROOT)} && test -d ${shellQuote(requestedPath)}`
    );

    if (pathCheck.exitCode !== 0) {
      const rootCheck = await executeSandboxCommand(sandbox, `test -d ${shellQuote(WORKSPACE_ROOT)}`);
      if (rootCheck.exitCode !== 0) {
        throw new Error('Workspace root is unavailable in sandbox');
      }

      return jsonResponse({ error: `Directory not found: ${requestedPath}` }, 404);
    }

    const resolvedPath = await resolveWorkspaceRealPath(sandbox, requestedPath);
    assertWorkspaceRootSafe(resolvedPath);

    const output = await runSandboxCommandWithOutput(
      sandbox,
      `cd ${shellQuote(WORKSPACE_ROOT)} && dir=${shellQuote(requestedPath)}; set -- "$dir"/* "$dir"/.[!.]* "$dir"/..?*; for entry in "$@"; do [ -e "$entry" ] || continue; name=\${entry##*/}; case "$name" in '.'|'..') continue ;; esac; if [ -d "$entry" ]; then kind='directory'; else kind='file'; fi; printf '%s\\0%s\\0' "$name" "$kind"; done`
    );

    const entries = parseWorkspaceListEntries(output, requestedPath);

    return jsonResponse({
      workspaceId,
      path: requestedPath,
      entries,
    });
  } catch (error) {
    if (isWorkspacePathValidationError(error)) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleGetWorkspaceFile(
  workspaceId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await resolveWorkspaceOr404(env, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    if (workspace.status !== 'ready') {
      return workspaceNotReadyResponse(workspace);
    }

    const url = new URL(request.url);
    const filePath = normalizeWorkspacePath(url.searchParams.get('path'), true);
    const maxBytes = parseMaxBytes(url, 'max_bytes', DEFAULT_FILE_READ_MAX_BYTES, MAX_FILE_READ_MAX_BYTES);
    const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);

    const exists = await executeSandboxCommand(
      sandbox,
      `cd ${shellQuote(WORKSPACE_ROOT)} && test -f ${shellQuote(filePath)}`
    );
    if (exists.exitCode !== 0) {
      const rootCheck = await executeSandboxCommand(sandbox, `test -d ${shellQuote(WORKSPACE_ROOT)}`);
      if (rootCheck.exitCode !== 0) {
        throw new Error('Workspace root is unavailable in sandbox');
      }

      return jsonResponse({ error: `File not found: ${filePath}` }, 404);
    }

    const resolvedPath = await resolveWorkspaceRealPath(sandbox, filePath);
    assertWorkspaceRootSafe(resolvedPath);

    const sizeOutput = await runSandboxCommandWithOutput(
      sandbox,
      `cd ${shellQuote(WORKSPACE_ROOT)} && wc -c -- ${shellQuote(filePath)}`
    );
    const sizeBytes = Number(sizeOutput.trim().split(/\s+/)[0]);
    const content = await runSandboxCommandWithOutput(
      sandbox,
      `cd ${shellQuote(WORKSPACE_ROOT)} && head -c ${maxBytes} -- ${shellQuote(filePath)}`
    );

    return jsonResponse({
      workspaceId,
      path: filePath,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      maxBytes,
      truncated: Number.isFinite(sizeBytes) ? sizeBytes > maxBytes : false,
      content,
    });
  } catch (error) {
    if (isWorkspacePathValidationError(error)) {
      return jsonResponse({ error: (error as Error).message }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleGetWorkspaceDiff(
  workspaceId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await resolveWorkspaceOr404(env, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    if (workspace.status !== 'ready') {
      return workspaceNotReadyResponse(workspace);
    }
    if (!workspace.baselineReady) {
      return jsonResponse(
        {
          error: 'Workspace baseline is not ready. Run workspace reset to retry baseline initialization.',
          status: workspace.status,
        },
        409
      );
    }

    const url = new URL(request.url);
    const includePatch = parseBooleanQueryParam(url, 'include_patch');
    const maxBytes = parseMaxBytes(url, 'max_bytes', DEFAULT_DIFF_MAX_BYTES, MAX_DIFF_MAX_BYTES);
    const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
    const hasHead = await workspaceHasGitHead(sandbox);
    if (!hasHead) {
      return jsonResponse(
        {
          error: 'Workspace git baseline is missing. Run workspace reset to rebuild baseline before requesting diff.',
          status: workspace.status,
        },
        409
      );
    }

    const nameStatusOutput = await runWorkspaceDiffAgainstHead(sandbox, '--name-status -z', maxBytes + 1);
    const nameStatusBytes = new TextEncoder().encode(nameStatusOutput).byteLength;
    const nameStatusLikelyTruncated = nameStatusBytes > maxBytes;
    const safeNameStatusOutput = trimNameStatusToCompleteRecords(nameStatusOutput);
    const changedFiles = parseDiffNameStatus(safeNameStatusOutput);

    const summary = {
      added: changedFiles.filter((file) => file.status === 'added').length,
      modified: changedFiles.filter((file) => file.status === 'modified').length,
      deleted: changedFiles.filter((file) => file.status === 'deleted').length,
      renamed: changedFiles.filter((file) => file.status === 'renamed').length,
      totalChanged: changedFiles.length,
    };

    const truncatedChangedFiles = truncateChangedFilesByBytes(changedFiles, maxBytes);

    const response: Record<string, unknown> = {
      workspaceId,
      includePatch,
      maxBytes,
      truncated: nameStatusLikelyTruncated || truncatedChangedFiles.truncated,
      changedFilesTruncated: nameStatusLikelyTruncated || truncatedChangedFiles.truncated,
      summary,
      summaryIsPartial: nameStatusLikelyTruncated,
      changedFiles: truncatedChangedFiles.files,
      changedFilesBytes: truncatedChangedFiles.bytes,
      changedFilesTotalBytes: truncatedChangedFiles.totalBytes,
    };

    if (includePatch) {
      const patchOutput = await runWorkspaceDiffAgainstHead(sandbox, '', maxBytes + 1);
      const truncatedPatch = truncateUtf8(patchOutput, maxBytes);
      response.patch = truncatedPatch.content;
      response.patchTruncated = truncatedPatch.truncated;
      response.truncated = Boolean(response.truncated) || truncatedPatch.truncated;
      response.patchBytes = truncatedPatch.returnedBytes;
      if (!truncatedPatch.truncated) {
        response.patchTotalBytes = truncatedPatch.totalBytes;
      }
    }

    return jsonResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleCreateWorkspaceZipExport(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  return handleCreateWorkspaceOperation(workspaceId, request, env, 'export_zip', authContext, ctx);
}

export async function handleCreateWorkspacePatchExport(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  return handleCreateWorkspaceOperation(workspaceId, request, env, 'export_patch', authContext, ctx);
}

export async function handleCreateWorkspaceGithubFork(
  workspaceId: string,
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  return handleCreateWorkspaceOperation(workspaceId, request, env, 'fork_github', authContext, ctx);
}

export async function handleGetWorkspaceOperation(
  workspaceId: string,
  operationId: string,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await resolveWorkspaceOr404(env, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const operation = await getWorkspaceOperation(env.DB, workspaceId, operationId);
    if (!operation) {
      return jsonResponse({ error: 'Operation not found' }, 404);
    }

    return jsonResponse({ operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleListWorkspaceArtifacts(
  workspaceId: string,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await resolveWorkspaceOr404(env, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const now = new Date();
    const downloadWindowMs = 15 * 60 * 1000;
    const downloadSecret = getArtifactDownloadSecret(env);
    const artifacts = await listWorkspaceArtifacts(env.DB, workspaceId, 100);
    const normalized = await Promise.all(
      artifacts.map(async (artifact) => {
        const expired = artifact.expiresAt <= now.toISOString();
        if (expired || !downloadSecret) {
          return {
            ...artifact,
            status: expired ? 'expired' : artifact.status,
            download: null,
          };
        }

        const expiresAtEpochSec = Math.floor(
          Math.min(Date.parse(artifact.expiresAt), now.getTime() + downloadWindowMs) / 1000
        );
        const signature = await signArtifactDownload(workspaceId, artifact.id, expiresAtEpochSec, downloadSecret);
        return {
          ...artifact,
          status: artifact.status,
          download: {
            url: `/api/workspaces/${workspaceId}/artifacts/${artifact.id}/download?exp=${expiresAtEpochSec}&sig=${encodeURIComponent(
              signature
            )}`,
            expiresAt: new Date(expiresAtEpochSec * 1000).toISOString(),
          },
        };
      })
    );

    return jsonResponse({ artifacts: normalized });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleDownloadWorkspaceArtifact(
  workspaceId: string,
  artifactId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await resolveWorkspaceOr404(env, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const artifact = await getWorkspaceArtifactById(env.DB, workspaceId, artifactId);
    if (!artifact) {
      return jsonResponse({ error: 'Artifact not found' }, 404);
    }

    const downloadSecret = getArtifactDownloadSecret(env);
    if (!downloadSecret) {
      return jsonResponse({ error: 'Artifact download signing is not configured' }, 500);
    }

    const url = new URL(request.url);
    const expRaw = url.searchParams.get('exp');
    const sigRaw = url.searchParams.get('sig');
    const exp = expRaw ? Number(expRaw) : NaN;
    if (!Number.isFinite(exp) || !sigRaw) {
      return jsonResponse({ error: 'Missing or invalid download signature' }, 403);
    }

    const nowEpochSec = Math.floor(Date.now() / 1000);
    if (exp < nowEpochSec) {
      return jsonResponse({ error: 'Download signature expired' }, 403);
    }

    const expectedSig = await signArtifactDownload(workspaceId, artifactId, exp, downloadSecret);
    if (sigRaw !== expectedSig) {
      return jsonResponse({ error: 'Download signature invalid' }, 403);
    }

    const nowIso = new Date().toISOString();
    if (artifact.retentionExpiresAt <= nowIso || artifact.status === 'expired') {
      return jsonResponse(
        {
          error: {
            code: 'artifact_expired',
            message: 'Artifact has expired. Regenerate using the export endpoint with a new idempotency key.',
          },
        },
        410
      );
    }

    const artifactsBucket = getArtifactsBucket(env);
    if (!artifactsBucket) {
      return jsonResponse({ error: 'Artifact bucket is not configured' }, 500);
    }

    const object = await artifactsBucket.get(artifact.objectKey);
    if (!object || !object.body) {
      return jsonResponse({ error: 'Artifact object not found' }, 404);
    }

    const extension = artifact.artifact.type === 'zip' ? 'zip' : 'patch';
    const filename = `${artifact.artifact.id}.${extension}`;
    return new Response(object.body, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': artifact.contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleGetWorkspaceEvents(
  workspaceId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const url = new URL(request.url);
    const fromRaw = Number(url.searchParams.get('from') ?? '0');
    const limitRaw = Number(url.searchParams.get('limit') ?? '500');
    const from = Number.isFinite(fromRaw) && fromRaw > 0 ? Math.floor(fromRaw) : 0;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 1000) : 500;
    const events = await listWorkspaceEvents(env.DB, workspaceId, from, limit);

    return jsonResponse({ workspaceId, events });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleResetWorkspace(workspaceId: string, env: Env, authContext?: AuthContext): Promise<Response> {
  if (!env.SOURCE_BUNDLES) {
    return jsonResponse({ error: 'SOURCE_BUNDLES R2 binding is not configured' }, 500);
  }

  let workspaceReadyPersisted = false;
  let originalWorkspace: WorkspaceResponse | null = null;
  let baselineReady = true;

  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    originalWorkspace = workspace;

    if (workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace has been deleted' }, 409);
    }

    const bundle = await env.SOURCE_BUNDLES.get(workspace.sourceBundleKey);
    if (!bundle) {
      return jsonResponse({ error: 'Workspace source bundle not found' }, 404);
    }

    const sourceBytes = await bundle.arrayBuffer();
    const sourceHash = await sha256Hex(sourceBytes);
    if (sourceHash !== workspace.sourceBundleSha256) {
      return jsonResponse({ error: 'Workspace source bundle checksum mismatch' }, 500);
    }

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_reset_started',
      payload: {},
    });

    await hydrateWorkspaceFilesystem(env, workspace.sandboxId, sourceBytes);
    const workspaceSandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
    try {
      await ensureWorkspaceGitBaseline(workspaceSandbox);
    } catch (error) {
      baselineReady = false;
      const message = error instanceof Error ? error.message : String(error);
      try {
        await appendWorkspaceEvent(env.DB, {
          workspaceId,
          eventType: 'workspace_git_baseline_failed',
          payload: { message },
        });
      } catch {
        // Best-effort event only.
      }
    }
    const markedReady = await markWorkspaceReady(env.DB, workspaceId, baselineReady);
    if (!markedReady) {
      return jsonResponse({ error: 'Workspace can no longer transition to ready (likely deleted)' }, 409);
    }
    workspaceReadyPersisted = true;

    await appendWorkspaceEvent(env.DB, {
      workspaceId,
      eventType: 'workspace_reset_completed',
      payload: {},
    });

    const refreshed = await getWorkspace(env.DB, workspaceId);
    return jsonResponse({ workspace: refreshed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (workspaceReadyPersisted) {
      try {
        const workspace = await getWorkspace(env.DB, workspaceId);
        if (workspace) {
          return jsonResponse({ workspace });
        }
      } catch {
        // Best-effort readback only.
      }

      if (originalWorkspace) {
        const fallbackWorkspace: WorkspaceResponse = {
          ...originalWorkspace,
          status: 'ready',
          baselineReady,
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date().toISOString(),
        };
        return jsonResponse({ workspace: fallbackWorkspace, warning: `Post-ready reset bookkeeping failed: ${message}` });
      }

      return jsonResponse({ error: `Reset reached ready state but result could not be loaded: ${message}` }, 500);
    }

    try {
      const markedFailed = await markWorkspaceFailed(env.DB, workspaceId, message, 'workspace_reset_failed');
      if (!markedFailed) {
        return jsonResponse({ error: 'Workspace reset failed after workspace was deleted' }, 409);
      }
      await appendWorkspaceEvent(env.DB, {
        workspaceId,
        eventType: 'workspace_reset_failed',
        payload: { message },
      });
    } catch {
      // Best-effort failure state update.
    }

    return jsonResponse({ error: `Failed to reset workspace: ${message}` }, 500);
  }
}

export async function handleDeleteWorkspace(workspaceId: string, env: Env, authContext?: AuthContext): Promise<Response> {
  try {
    const accessResponse = await requireWorkspaceAccess(env, workspaceId, authContext);
    if (accessResponse) {
      return accessResponse;
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    if (workspace.status === 'deleted') {
      return jsonResponse({ workspaceId, status: 'deleted' });
    }

    try {
      const sandbox = await getWorkspaceSandbox(env, workspace.sandboxId);
      await sandbox.destroy();
    } catch (error) {
      if (isSandboxAlreadyGoneError(error)) {
        // Treat missing/already-destroyed sandbox as idempotent success.
      } else {
      const message = error instanceof Error ? error.message : String(error);

      try {
        await markWorkspaceFailed(env.DB, workspaceId, message, 'workspace_delete_failed');
        await appendWorkspaceEvent(env.DB, {
          workspaceId,
          eventType: 'workspace_delete_failed',
          payload: { message },
        });
      } catch {
        // Best-effort failure state update.
      }

      return jsonResponse({ error: `Failed to destroy workspace sandbox: ${message}` }, 500);
      }
    }

    if (env.SOURCE_BUNDLES) {
      try {
        await env.SOURCE_BUNDLES.delete(workspace.sourceBundleKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await markWorkspaceFailed(env.DB, workspaceId, message, 'workspace_delete_partial');
          await appendWorkspaceEvent(env.DB, {
            workspaceId,
            eventType: 'workspace_delete_partial',
            payload: { message },
          });
        } catch {
          // Best-effort status/event update for partial delete.
        }
        return jsonResponse({ error: `Failed to delete workspace source bundle: ${message}` }, 503);
      }
    }

    const markedDeleted = await markWorkspaceDeleted(env.DB, workspaceId);
    if (!markedDeleted) {
      return jsonResponse({ error: 'Workspace can no longer transition to deleted' }, 409);
    }
    try {
      await appendWorkspaceEvent(env.DB, {
        workspaceId,
        eventType: 'workspace_deleted',
        payload: {},
      });
    } catch {
      // Deletion already persisted; event append is best-effort.
    }

    return jsonResponse({ workspaceId, status: 'deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to delete workspace: ${message}` }, 500);
  }
}
