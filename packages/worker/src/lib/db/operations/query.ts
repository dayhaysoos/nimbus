import type { WorkspaceOperationResponse } from '../../../types.js';
import { toWorkspaceOperationResponse, WorkspaceIdempotencyConflictError } from './shared.js';

export async function getWorkspaceOperation(
  db: D1Database,
  workspaceId: string,
  operationId: string
): Promise<WorkspaceOperationResponse | null> {
  const result = await db
    .prepare('SELECT * FROM workspace_operations WHERE id = ? AND workspace_id = ?')
    .bind(operationId, workspaceId)
    .first();

  if (!result) {
    return null;
  }
  return toWorkspaceOperationResponse(result as never);
}

export async function getWorkspaceOperationByIdempotency(
  db: D1Database,
  workspaceId: string,
  type: import('../../../types.js').WorkspaceOperationType,
  idempotencyKey: string,
  requestPayloadSha256: string
): Promise<WorkspaceOperationResponse | null> {
  const now = new Date().toISOString();
  const existingIdempotency = await db
    .prepare(
      `SELECT operation_id, request_payload_sha256, expires_at
       FROM workspace_operation_idempotency
       WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(workspaceId, type, idempotencyKey)
    .first<{ operation_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (existingIdempotency.request_payload_sha256 !== requestPayloadSha256) {
      throw new WorkspaceIdempotencyConflictError(idempotencyKey, type);
    }
    const operation = await getWorkspaceOperation(db, workspaceId, existingIdempotency.operation_id);
    if (!operation) {
      throw new Error(`Idempotency record references missing operation ${existingIdempotency.operation_id}`);
    }
    return operation;
  }

  return null;
}
