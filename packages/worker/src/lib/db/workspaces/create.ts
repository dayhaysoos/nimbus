import type { WorkspaceResponse } from '../../../types.js';
import { toWorkspaceResponse } from './shared.js';

/** Persists a new workspace row in creating state. */
export async function createWorkspace(
  db: D1Database,
  input: {
    id: string;
    sourceType: 'checkpoint';
    checkpointId: string | null;
    commitSha: string;
    sourceRef?: string;
    sourceProjectRoot?: string;
    sourceBundleKey: string;
    sourceBundleSha256: string;
    sourceBundleBytes: number;
    sandboxId: string;
    accountId?: string | null;
  }
): Promise<WorkspaceResponse> {
  const result = await db
    .prepare(
      `INSERT INTO workspaces (
         id,
         status,
         source_type,
         checkpoint_id,
         commit_sha,
         source_ref,
         source_project_root,
         source_bundle_key,
         source_bundle_sha256,
         source_bundle_bytes,
         sandbox_id,
         baseline_ready,
         account_id
       )
       VALUES (?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.sourceType,
      input.checkpointId,
      input.commitSha,
      input.sourceRef ?? null,
      input.sourceProjectRoot ?? null,
      input.sourceBundleKey,
      input.sourceBundleSha256,
      input.sourceBundleBytes,
      input.sandboxId,
      input.accountId ?? null
    )
    .first();

  if (!result) {
    throw new Error('Failed to create workspace');
  }

  return toWorkspaceResponse(result as never);
}
