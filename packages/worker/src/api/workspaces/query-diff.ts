import type { AuthContext, Env } from '../../types.js';
import { getWorkspace } from '../../lib/db.js';
import {
  DEFAULT_DIFF_MAX_BYTES,
  MAX_DIFF_MAX_BYTES,
  parseBooleanQueryParam,
  parseDiffNameStatus,
  parseMaxBytes,
  trimNameStatusToCompleteRecords,
  truncateChangedFilesByBytes,
  truncateUtf8,
} from './query-helpers.js';
import { getWorkspaceSandbox, runWorkspaceDiffAgainstHead, workspaceHasGitHead } from './sandbox.js';
import { jsonResponse, requireWorkspaceAccess } from './shared.js';

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
