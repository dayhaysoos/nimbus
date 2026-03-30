import type {
  WorkspaceOperationRecord,
  WorkspaceOperationResponse,
  WorkspaceOperationStatus,
  WorkspaceOperationType,
} from '../../types.js';

function parseJsonOrFallback<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique constraint failed/i.test(error.message);
}

export class WorkspaceIdempotencyConflictError extends Error {
  constructor(
    public readonly key: string,
    public readonly type: WorkspaceOperationType
  ) {
    super(`Idempotency key conflict for ${type}: ${key}`);
    this.name = 'WorkspaceIdempotencyConflictError';
  }
}

function toWorkspaceOperationResponse(record: WorkspaceOperationRecord): WorkspaceOperationResponse {
  const warnings = parseJsonOrFallback<unknown[]>(record.warnings_json, []);
  const result = parseJsonOrFallback<unknown>(record.result_json, undefined);
  const errorDetails = parseJsonOrFallback<unknown>(record.error_details_json, undefined);

  const response: WorkspaceOperationResponse = {
    id: record.id,
    type: record.type,
    status: record.status,
    workspaceId: record.workspace_id,
    idempotencyKey: record.idempotency_key,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };

  if (result !== undefined) {
    response.result = result;
  }
  if (Array.isArray(warnings) && warnings.length > 0) {
    response.warnings = warnings;
  }
  if (record.error_code && record.error_message) {
    response.error = {
      code: record.error_code,
      message: record.error_message,
      details: errorDetails,
    };
  }

  return response;
}

export function generateWorkspaceOperationId(): string {
  return generatePrefixedId('op');
}

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
): Promise<{ operation: WorkspaceOperationResponse; reused: boolean }> {
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
      .prepare(
        `DELETE FROM workspace_operation_idempotency
         WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?`
      )
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
    .first<WorkspaceOperationRecord>();

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

  return { operation: toWorkspaceOperationResponse(operationRecord), reused: false };
}

export async function getWorkspaceOperation(
  db: D1Database,
  workspaceId: string,
  operationId: string
): Promise<WorkspaceOperationResponse | null> {
  const result = await db
    .prepare('SELECT * FROM workspace_operations WHERE id = ? AND workspace_id = ?')
    .bind(operationId, workspaceId)
    .first<WorkspaceOperationRecord>();

  if (!result) {
    return null;
  }

  return toWorkspaceOperationResponse(result);
}

export async function claimWorkspaceOperationForExecution(
  db: D1Database,
  workspaceId: string,
  operationId: string
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE workspace_operations
       SET status = 'running',
           started_at = COALESCE(started_at, ?),
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued'`
    )
    .bind(startedAt, startedAt, operationId, workspaceId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function updateWorkspaceOperationStatus(
  db: D1Database,
  operationId: string,
  status: WorkspaceOperationStatus,
  options?: {
    result?: unknown;
    warnings?: unknown[];
    errorCode?: string | null;
    errorClass?: string | null;
    errorMessage?: string | null;
    errorDetails?: unknown;
    startedAt?: string | null;
    finishedAt?: string | null;
  }
): Promise<void> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: Array<string | number | null> = [status, new Date().toISOString()];

  if (options?.startedAt !== undefined) {
    updates.push('started_at = ?');
    values.push(options.startedAt);
  }
  if (options?.finishedAt !== undefined) {
    updates.push('finished_at = ?');
    values.push(options.finishedAt);
  }
  if (options?.result !== undefined) {
    updates.push('result_json = ?');
    values.push(JSON.stringify(options.result));
  }
  if (options?.warnings !== undefined) {
    updates.push('warnings_json = ?');
    values.push(JSON.stringify(options.warnings));
  }
  if (options?.errorCode !== undefined) {
    updates.push('error_code = ?');
    values.push(options.errorCode);
  }
  if (options?.errorClass !== undefined) {
    updates.push('error_class = ?');
    values.push(options.errorClass);
  }
  if (options?.errorMessage !== undefined) {
    updates.push('error_message = ?');
    values.push(options.errorMessage);
  }
  if (options?.errorDetails !== undefined) {
    updates.push('error_details_json = ?');
    values.push(JSON.stringify(options.errorDetails));
  }
  if (status === 'running') {
    updates.push('started_at = COALESCE(started_at, ?)');
    values.push(new Date().toISOString());
  }
  if (status === 'succeeded' || status === 'failed') {
    updates.push('finished_at = COALESCE(finished_at, ?)');
    values.push(new Date().toISOString());
    updates.push('duration_ms = CASE WHEN started_at IS NULL OR COALESCE(finished_at, ?) IS NULL THEN NULL ELSE CAST((julianday(COALESCE(finished_at, ?)) - julianday(started_at)) * 86400000 AS INTEGER) END');
    const finishedAtForDuration = new Date().toISOString();
    values.push(finishedAtForDuration, finishedAtForDuration);
  }

  values.push(operationId);

  await db
    .prepare(`UPDATE workspace_operations SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}
