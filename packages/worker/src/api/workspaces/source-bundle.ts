import type { Env, WorkspaceResponse } from '../../types.js';
import type { ParsedCheckpointCreateRequest } from '../checkpoint-jobs.js';

function toHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

export async function sha256Hex(input: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return toHex(new Uint8Array(digest));
}

export function sourceBundleR2Key(workspaceId: string, commitSha: string): string {
  return `workspaces/${workspaceId}/source/${commitSha}.tar.gz`;
}

export async function uploadWorkspaceSourceBundle(
  env: Env,
  sourceBundleKey: string,
  parsed: ParsedCheckpointCreateRequest
): Promise<void> {
  await env.SOURCE_BUNDLES?.put(sourceBundleKey, parsed.bundleArrayBuffer, {
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
}

export async function loadVerifiedWorkspaceSourceBundle(
  env: Env,
  workspace: Pick<WorkspaceResponse, 'sourceBundleKey' | 'sourceBundleSha256'>
): Promise<ArrayBuffer | Response> {
  const bundle = await env.SOURCE_BUNDLES?.get(workspace.sourceBundleKey);
  if (!bundle) {
    return new Response(JSON.stringify({ error: 'Workspace source bundle not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sourceBytes = await bundle.arrayBuffer();
  const sourceHash = await sha256Hex(sourceBytes);
  if (sourceHash !== workspace.sourceBundleSha256) {
    return new Response(JSON.stringify({ error: 'Workspace source bundle checksum mismatch' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return sourceBytes;
}

export function buildWorkspaceCreateFallback(input: {
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
