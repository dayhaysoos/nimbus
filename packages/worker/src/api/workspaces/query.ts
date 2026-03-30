import type { AuthContext, Env } from '../../types.js';
import { getWorkspace, listWorkspaceEvents } from '../../lib/db.js';
import {
  assertWorkspaceRootSafe,
  DEFAULT_DIFF_MAX_BYTES,
  DEFAULT_FILE_READ_MAX_BYTES,
  MAX_DIFF_MAX_BYTES,
  MAX_FILE_READ_MAX_BYTES,
  isWorkspacePathValidationError,
  normalizeWorkspacePath,
  parseBooleanQueryParam,
  parseDiffNameStatus,
  parseMaxBytes,
  parseWorkspaceListEntries,
  trimNameStatusToCompleteRecords,
  truncateChangedFilesByBytes,
  truncateUtf8,
} from './query-helpers.js';
import {
  executeSandboxCommand,
  getWorkspaceSandbox,
  resolveWorkspaceRealPath,
  runSandboxCommandWithOutput,
  runWorkspaceDiffAgainstHead,
  shellQuote,
  WORKSPACE_ROOT,
  workspaceHasGitHead,
} from './sandbox.js';
import { jsonResponse, requireWorkspaceAccess } from './shared.js';

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

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace || workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    if (workspace.status !== 'ready') {
      return jsonResponse(
        {
          error: `Workspace is not ready (status: ${workspace.status})`,
          status: workspace.status,
        },
        409
      );
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
      `cd ${shellQuote(WORKSPACE_ROOT)} && dir=${shellQuote(requestedPath)}; set -- "$dir"/* "$dir"/.[!.]* "$dir"/..?*; for entry in "$@"; do [ -e "$entry" ] || continue; name=\${entry##*/}; case "$name" in '.'|'..') continue ;; esac; if [ -d "$entry" ]; then kind='directory'; else kind='file'; fi; printf '%s\0%s\0' "$name" "$kind"; done`
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

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace || workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    if (workspace.status !== 'ready') {
      return jsonResponse(
        {
          error: `Workspace is not ready (status: ${workspace.status})`,
          status: workspace.status,
        },
        409
      );
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

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace || workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    if (workspace.status !== 'ready') {
      return jsonResponse(
        {
          error: `Workspace is not ready (status: ${workspace.status})`,
          status: workspace.status,
        },
        409
      );
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
