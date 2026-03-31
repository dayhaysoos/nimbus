import type { AuthContext, Env } from '../../types.js';
import { getWorkspace } from '../../lib/db.js';
import {
  assertWorkspaceRootSafe,
  DEFAULT_FILE_READ_MAX_BYTES,
  MAX_FILE_READ_MAX_BYTES,
  isWorkspacePathValidationError,
  normalizeWorkspacePath,
  parseMaxBytes,
  parseWorkspaceListEntries,
} from './query-paths.js';
import {
  executeSandboxCommand,
  getWorkspaceSandbox,
  runSandboxCommandWithOutput,
  shellQuote,
  WORKSPACE_ROOT,
} from './sandbox.js';
import { resolveWorkspaceRealPath } from './sandbox-filesystem.js';
import { jsonResponse, requireWorkspaceAccess } from './shared.js';

function workspaceNotReadyResponse(status: string): Response {
  return jsonResponse(
    {
      error: `Workspace is not ready (status: ${status})`,
      status,
    },
    409
  );
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
      return workspaceNotReadyResponse(workspace.status);
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
      return workspaceNotReadyResponse(workspace.status);
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
