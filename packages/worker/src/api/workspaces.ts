import type { Sandbox } from '@cloudflare/sandbox';
import type { Env, WorkspaceResponse } from '../types.js';
import { parseCheckpointCreateRequest } from './checkpoint-jobs.js';
import type { ParsedCheckpointCreateRequest } from './checkpoint-jobs.js';
import {
  appendWorkspaceEvent,
  createWorkspace,
  generateWorkspaceId,
  getWorkspace,
  listWorkspaceEvents,
  markWorkspaceDeleted,
  markWorkspaceFailed,
  markWorkspaceReady,
} from '../lib/db.js';

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
  'Access-Control-Allow-Headers': 'Content-Type',
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
    throw new Error(`Sandbox command failed (${command}) with exit ${result.exitCode}: ${output || 'No output'}`);
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
    throw new Error(`Sandbox command failed (${command}) with exit ${result.exitCode}: ${output || 'No output'}`);
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

async function sha256Hex(input: ArrayBuffer): Promise<string> {
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

export async function handleCreateWorkspace(request: Request, env: Env): Promise<Response> {
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

export async function handleGetWorkspace(workspaceId: string, env: Env): Promise<Response> {
  try {
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
  env: Env
): Promise<Response> {
  try {
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
  env: Env
): Promise<Response> {
  try {
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
  env: Env
): Promise<Response> {
  try {
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

export async function handleGetWorkspaceEvents(
  workspaceId: string,
  request: Request,
  env: Env
): Promise<Response> {
  try {
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

export async function handleResetWorkspace(workspaceId: string, env: Env): Promise<Response> {
  if (!env.SOURCE_BUNDLES) {
    return jsonResponse({ error: 'SOURCE_BUNDLES R2 binding is not configured' }, 500);
  }

  let workspaceReadyPersisted = false;
  let originalWorkspace: WorkspaceResponse | null = null;
  let baselineReady = true;

  try {
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

export async function handleDeleteWorkspace(workspaceId: string, env: Env): Promise<Response> {
  try {
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
