import type { WorkspaceOperationType } from '../../../types.js';
import { getWorkspaceOperation } from './query.js';
import {
  generatePrefixedId,
  isUniqueConstraintError,
  toWorkspaceOperationResponse,
  WorkspaceIdempotencyConflictError,
} from './shared.js';

/** Creates or reuses a workspace operation row keyed by workspace/type/idempotency. */
export async function createWorkspaceOperation(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    type: WorkspaceOperationType;
    idempotencyKey: string;
    requestPayload: unknown;
    requestPayloadSha256: string;
    actorId?: string | null;
    authPrincipal?: Record<string, unknown>;
  }
): Promise<{ operation: import('../../../types.js').WorkspaceOperationResponse; reused: boolean }> {
  const now = new Date().toISOString();
  const existingIdempotency = await db
    .prepare(
      `SELECT operation_id, request_payload_sha256, expires_at
       FROM workspace_operation_idempotency
       WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.type, input.idempotencyKey)
    .first<{ operation_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (existingIdempotency.request_payload_sha256 !== input.requestPayloadSha256) {
      throw new WorkspaceIdempotencyConflictError(input.idempotencyKey, input.type);
    }
    const existingOperation = await getWorkspaceOperation(db, input.workspaceId, existingIdempotency.operation_id);
    if (!existingOperation) {
      throw new Error(`Idempotency record references missing operation ${existingIdempotency.operation_id}`);
    }
    return { operation: existingOperation, reused: true };
  }

  if (existingIdempotency && existingIdempotency.expires_at <= now) {
    await db
      .prepare(`DELETE FROM workspace_operation_idempotency WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?`)
      .bind(input.workspaceId, input.type, input.idempotencyKey)
      .run();
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const operationId = input.id;
  const operationRecord = await db
    .prepare(
      `INSERT INTO workspace_operations (
         id,
         workspace_id,
         type,
         status,
         actor_id,
         auth_principal_json,
         request_payload_json,
         request_payload_sha256,
         idempotency_key,
         warnings_json
       )
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, '[]')
       RETURNING *`
    )
    .bind(
      operationId,
      input.workspaceId,
      input.type,
      input.actorId ?? null,
      JSON.stringify(input.authPrincipal ?? {}),
      JSON.stringify(input.requestPayload ?? {}),
      input.requestPayloadSha256,
      input.idempotencyKey
    )
    .first();

  if (!operationRecord) {
    throw new Error('Failed to create workspace operation');
  }

  try {
    await db
      .prepare(
        `INSERT INTO workspace_operation_idempotency (
           id,
           workspace_id,
           operation_type,
           idempotency_key,
           operation_id,
           request_payload_sha256,
           expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        generatePrefixedId('wopk'),
        input.workspaceId,
        input.type,
        input.idempotencyKey,
        operationId,
        input.requestPayloadSha256,
        expiresAt
      )
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
      throw error;
    }

    const concurrentIdempotency = await db
      .prepare(
        `SELECT operation_id, request_payload_sha256, expires_at
         FROM workspace_operation_idempotency
         WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?
         LIMIT 1`
      )
      .bind(input.workspaceId, input.type, input.idempotencyKey)
      .first<{ operation_id: string; request_payload_sha256: string; expires_at: string }>();

    if (!concurrentIdempotency || concurrentIdempotency.expires_at <= now) {
      await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
      throw new Error('Idempotency race detected but winner record is unavailable');
    }
    if (concurrentIdempotency.request_payload_sha256 !== input.requestPayloadSha256) {
      await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
      throw new WorkspaceIdempotencyConflictError(input.idempotencyKey, input.type);
    }

    const existingOperation = await getWorkspaceOperation(db, input.workspaceId, concurrentIdempotency.operation_id);
    if (!existingOperation) {
      await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
      throw new Error(`Idempotency record references missing operation ${concurrentIdempotency.operation_id}`);
    }
    await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
    return { operation: existingOperation, reused: true };
  }

  return { operation: toWorkspaceOperationResponse(operationRecord as never), reused: false };
}
