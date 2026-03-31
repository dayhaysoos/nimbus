import {
  claimWorkspaceOperationForExecution,
  createWorkspaceArtifact,
  generateWorkspaceArtifactId,
  updateWorkspaceOperationStatus,
} from '../../lib/db.js';
import type { Env, WorkspaceOperationType, WorkspaceResponse } from '../../types.js';
import { runWorkspaceDiffAgainstHead, workspaceHasGitHead } from './sandbox-git.js';
import {
  getWorkspaceSandbox,
} from './sandbox.js';
import { exportWorkspaceZipBase64, fromBase64 } from './sandbox-filesystem.js';
import { sanitizeErrorMessage } from './operations-helpers.js';

function getArtifactsBucket(env: Env): R2Bucket | null {
  return env.WORKSPACE_ARTIFACTS ?? env.SOURCE_BUNDLES ?? null;
}

export async function executeWorkspaceArtifactOperation(
  env: Env,
  workspace: WorkspaceResponse,
  operationId: string,
  type: WorkspaceOperationType
): Promise<void> {
  const claimed = await claimWorkspaceOperationForExecution(env.DB, workspace.id, operationId);
  if (!claimed) {
    return;
  }

  try {
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
    const warnings: Array<Record<string, unknown>> = [];
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

    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const artifactId = generateWorkspaceArtifactId();
    const objectKey = `workspaces/${workspace.id}/artifacts/${artifactId}.${extension}`;
    await artifactsBucket.put(objectKey, bytes, {
      httpMetadata: { contentType },
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
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    await updateWorkspaceOperationStatus(env.DB, operationId, 'failed', {
      errorCode: 'operation_failed',
      errorClass: 'runtime_error',
      errorMessage: message,
      errorDetails: {
        operationType: type,
      },
    });
  }
}
