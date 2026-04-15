import type { WorkspaceResponse } from '../../../types.js';
import { getWorkspace } from './query.js';
import {
  generatePrefixedId,
  toWorkspaceResponse,
  WorkspaceCreateIdempotencyConflictError,
  WorkspaceCreateInProgressError,
} from './shared.js';

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

async function resolveReusableWorkspace(
  db: D1Database,
  input: {
    accountScope: string;
    idempotencyKey: string;
    requestPayloadSha256: string;
  }
): Promise<WorkspaceResponse | null> {
  const now = new Date().toISOString();
  const idempotency = await db
    .prepare(
      `SELECT workspace_id, request_payload_sha256, expires_at
       FROM workspace_create_idempotency
       WHERE account_scope = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(input.accountScope, input.idempotencyKey)
    .first<{ workspace_id: string; request_payload_sha256: string; expires_at: string }>();

  if (!idempotency) {
    return null;
  }

  if (idempotency.request_payload_sha256 !== input.requestPayloadSha256) {
    throw new WorkspaceCreateIdempotencyConflictError(input.idempotencyKey);
  }

  if (idempotency.expires_at <= now) {
    await db
      .prepare(
        `DELETE FROM workspace_create_idempotency
         WHERE account_scope = ? AND idempotency_key = ?`
      )
      .bind(input.accountScope, input.idempotencyKey)
      .run();
    return null;
  }

  const workspace = await getWorkspace(db, idempotency.workspace_id);
  if (!workspace || workspace.status === 'failed' || workspace.status === 'deleted') {
    await db
      .prepare(
        `DELETE FROM workspace_create_idempotency
         WHERE account_scope = ? AND idempotency_key = ?`
      )
      .bind(input.accountScope, input.idempotencyKey)
      .run();
    return null;
  }

  if (workspace.status === 'creating') {
    throw new WorkspaceCreateInProgressError(input.idempotencyKey, workspace.id);
  }

  return workspace;
}

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
    idempotency?: {
      key: string;
      accountScope: string;
      requestPayloadSha256: string;
    };
  }
): Promise<{ workspace: WorkspaceResponse; reused: boolean }> {
  if (input.idempotency) {
    const reused = await resolveReusableWorkspace(db, {
      accountScope: input.idempotency.accountScope,
      idempotencyKey: input.idempotency.key,
      requestPayloadSha256: input.idempotency.requestPayloadSha256,
    });
    if (reused) {
      return { workspace: reused, reused: true };
    }
  }

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

  if (input.idempotency) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    try {
      await db
        .prepare(
          `INSERT INTO workspace_create_idempotency (
             id,
             account_scope,
             idempotency_key,
             workspace_id,
             request_payload_sha256,
             expires_at
           )
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          generatePrefixedId('wsci'),
          input.idempotency.accountScope,
          input.idempotency.key,
          input.id,
          input.idempotency.requestPayloadSha256,
          expiresAt
        )
        .run();
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        await db.prepare('DELETE FROM workspaces WHERE id = ?').bind(input.id).run();
        throw error;
      }

      let concurrent: WorkspaceResponse | null = null;
      try {
        concurrent = await resolveReusableWorkspace(db, {
          accountScope: input.idempotency.accountScope,
          idempotencyKey: input.idempotency.key,
          requestPayloadSha256: input.idempotency.requestPayloadSha256,
        });
      } catch (resolveError) {
        await db.prepare('DELETE FROM workspaces WHERE id = ?').bind(input.id).run();
        throw resolveError;
      }
      if (!concurrent) {
        await db.prepare('DELETE FROM workspaces WHERE id = ?').bind(input.id).run();
        throw new Error('Workspace create idempotency race detected but winner record is unavailable');
      }

      await db.prepare('DELETE FROM workspaces WHERE id = ?').bind(input.id).run();
      return { workspace: concurrent, reused: true };
    }
  }

  return { workspace: toWorkspaceResponse(result as never), reused: false };
}
