import type { Env } from '../../types.js';
import {
  type SandboxClient,
  runSandboxCommandWithOutput,
  shellQuote,
  WORKSPACE_ROOT,
} from './sandbox.js';

export interface GithubTargetPayload {
  owner: string;
  repo: string;
  branch?: string;
}

export interface ForkGithubPayload {
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

export class OperationPreflightError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OperationPreflightError';
  }
}

export function parseForkGithubPayload(payload: Record<string, unknown>): ForkGithubPayload {
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

export function enforceForkTargetPolicy(env: Env, owner: string): void {
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

function fromBase64(input: string): Uint8Array {
  const normalized = input.replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function convertPkcs1DerToPkcs8Der(pkcs1Der: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithmIdentifier = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7,
    0x0d, 0x01, 0x01, 0x01, 0x05, 0x00
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

  const pkcs1Match = normalized.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]*?)-----END RSA PRIVATE KEY-----/);
  if (pkcs1Match?.[1]) {
    return { der: fromBase64(pkcs1Match[1]), type: 'pkcs1' };
  }

  throw new OperationPreflightError(
    'configuration_invalid',
    'GITHUB_APP_PRIVATE_KEY must be PKCS#8 (BEGIN PRIVATE KEY) or PKCS#1 (BEGIN RSA PRIVATE KEY) PEM'
  );
}

export async function createGitHubAppJwt(env: Env): Promise<string> {
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
  const payload = { iat: issuedAt, exp: issuedAt + 9 * 60, iss: env.GITHUB_APP_ID };
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
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
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

export async function githubRequest<T>(env: Env, path: string, options: GithubRequestOptions): Promise<T> {
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
    .replace(/\/+/, '/')
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

export async function resolveGitHubInstallationId(
  env: Env,
  appJwt: string,
  owner: string,
  repo: string,
  installationOverride?: number
): Promise<number> {
  if (installationOverride) {
    return installationOverride;
  }

  const installation = await githubRequest<{ id: number }>(env, `/repos/${owner}/${repo}/installation`, { token: appJwt });
  return installation.id;
}

export async function createInstallationToken(env: Env, appJwt: string, installationId: number): Promise<string> {
  const tokenResponse = await githubRequest<{ token: string }>(env, `/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    token: appJwt,
    body: {},
  });
  return tokenResponse.token;
}

export async function resolveBranchForFork(
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
      await githubRequest(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branchBase)}`, { token });
      throw new OperationPreflightError('branch_exists', 'Requested branch already exists', { branch: branchBase });
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
      await githubRequest(env, `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(candidate)}`, { token });
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

export async function executeForkCommitAndPushInSandbox(
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
    `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s\\n' 'x-access-token' ;;\n  *) cat ${shellQuote(tokenPath)} ;;\nesac\n`
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
