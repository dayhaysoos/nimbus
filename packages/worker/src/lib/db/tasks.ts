import type {
  WorkspaceTaskRecord,
  WorkspaceTaskResponse,
  WorkspaceTaskStatus,
} from '../../types.js';

interface WorkspaceTaskEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface WorkspaceTaskEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

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

export class WorkspaceTaskIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Task idempotency key conflict: ${key}`);
    this.name = 'WorkspaceTaskIdempotencyConflictError';
  }
}

function toWorkspaceTaskResponse(record: WorkspaceTaskRecord): WorkspaceTaskResponse {
  const result = parseJsonOrFallback(record.result_json, undefined);

  const response: WorkspaceTaskResponse = {
    id: record.id,
    workspaceId: record.workspace_id,
    status: record.status,
    prompt: record.prompt,
    provider: record.provider,
    model: record.model,
    idempotencyKey: record.idempotency_key,
    maxSteps: record.max_steps,
    maxRetries: record.max_retries,
    attemptCount: record.attempt_count,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    cancelRequestedAt: record.cancel_requested_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };

  if (result !== undefined) {
    response.result = result;
  }

  if (record.error_code && record.error_message) {
    response.error = {
      code: record.error_code,
      message: record.error_message,
    };
  }

  return response;
}

export async function createWorkspaceTask(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    prompt: string;
    provider: string;
    model: string;
    idempotencyKey: string;
    requestPayload: unknown;
    requestPayloadSha256: string;
    maxSteps: number;
    maxRetries: number;
    actorId?: string | null;
    toolPolicy?: Record<string, unknown>;
  }
): Promise<{ task: WorkspaceTaskResponse; reused: boolean }> {
  const now = new Date().toISOString();
  const existingIdempotency = await db
    .prepare(
      `SELECT task_id, request_payload_sha256, expires_at
       FROM workspace_task_idempotency
       WHERE workspace_id = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.idempotencyKey)
    .first<{ task_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (existingIdempotency.request_payload_sha256 !== input.requestPayloadSha256) {
      throw new WorkspaceTaskIdempotencyConflictError(input.idempotencyKey);
    }

    const existingTask = await getWorkspaceTask(db, input.workspaceId, existingIdempotency.task_id);
    if (!existingTask) {
      throw new Error(`Idempotency record references missing task ${existingIdempotency.task_id}`);
    }

    return { task: existingTask, reused: true };
  }

  if (existingIdempotency && existingIdempotency.expires_at <= now) {
    await db
      .prepare('DELETE FROM workspace_task_idempotency WHERE workspace_id = ? AND idempotency_key = ?')
      .bind(input.workspaceId, input.idempotencyKey)
      .run();
  }

  const idempotencyWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingTaskByKey = await db
    .prepare(
      `SELECT *
       FROM workspace_tasks
       WHERE workspace_id = ?
         AND idempotency_key = ?
         AND julianday(created_at) >= julianday(?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(input.workspaceId, input.idempotencyKey, idempotencyWindowStart)
    .first<WorkspaceTaskRecord>();

  if (existingTaskByKey) {
    if (existingTaskByKey.request_payload_sha256 !== input.requestPayloadSha256) {
      throw new WorkspaceTaskIdempotencyConflictError(input.idempotencyKey);
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    try {
      await db
        .prepare(
          `INSERT INTO workspace_task_idempotency (
             id,
             workspace_id,
             idempotency_key,
             task_id,
             request_payload_sha256,
             expires_at
           )
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          generatePrefixedId('wtsk'),
          input.workspaceId,
          input.idempotencyKey,
          existingTaskByKey.id,
          input.requestPayloadSha256,
          expiresAt
        )
        .run();
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    return { task: toWorkspaceTaskResponse(existingTaskByKey), reused: true };
  }

  const taskRecord = await db
    .prepare(
      `INSERT INTO workspace_tasks (
         id,
         workspace_id,
         status,
         prompt,
         provider,
         model,
         idempotency_key,
         request_payload_json,
         request_payload_sha256,
         max_steps,
         max_retries,
         actor_id,
         tool_policy_json,
         attempt_count,
         last_event_seq,
         created_at,
         updated_at
       )
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.prompt,
      input.provider,
      input.model,
      input.idempotencyKey,
      JSON.stringify(input.requestPayload),
      input.requestPayloadSha256,
      input.maxSteps,
      input.maxRetries,
      input.actorId ?? null,
      JSON.stringify(input.toolPolicy ?? {}),
      now,
      now
    )
    .first<WorkspaceTaskRecord>();

  if (!taskRecord) {
    throw new Error('Failed to create workspace task');
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO workspace_task_idempotency (
           id,
           workspace_id,
           idempotency_key,
           task_id,
           request_payload_sha256,
           expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        generatePrefixedId('wtsk'),
        input.workspaceId,
        input.idempotencyKey,
        input.id,
        input.requestPayloadSha256,
        expiresAt
      )
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
      throw error;
    }

    const concurrent = await db
      .prepare(
        `SELECT task_id, request_payload_sha256, expires_at
         FROM workspace_task_idempotency
         WHERE workspace_id = ? AND idempotency_key = ?
         LIMIT 1`
      )
      .bind(input.workspaceId, input.idempotencyKey)
      .first<{ task_id: string; request_payload_sha256: string; expires_at: string }>();

    if (!concurrent || concurrent.expires_at <= now) {
      await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
      throw new Error('Task idempotency race detected but winner record is unavailable');
    }

    if (concurrent.request_payload_sha256 !== input.requestPayloadSha256) {
      await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
      throw new WorkspaceTaskIdempotencyConflictError(input.idempotencyKey);
    }

    const existingTask = await getWorkspaceTask(db, input.workspaceId, concurrent.task_id);
    if (!existingTask) {
      await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
      throw new Error(`Idempotency record references missing task ${concurrent.task_id}`);
    }

    await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
    return { task: existingTask, reused: true };
  }

  return { task: toWorkspaceTaskResponse(taskRecord), reused: false };
}

export async function getWorkspaceTask(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<WorkspaceTaskResponse | null> {
  const record = await db
    .prepare('SELECT * FROM workspace_tasks WHERE id = ? AND workspace_id = ?')
    .bind(taskId, workspaceId)
    .first<WorkspaceTaskRecord>();

  if (!record) {
    return null;
  }

  return toWorkspaceTaskResponse(record);
}

export async function getWorkspaceTaskRequestPayload(
  db: D1Database,
  taskId: string
): Promise<Record<string, unknown> | null> {
  const record = await db
    .prepare('SELECT request_payload_json FROM workspace_tasks WHERE id = ?')
    .bind(taskId)
    .first<{ request_payload_json: string }>();

  if (!record) {
    return null;
  }

  const parsed = parseJsonOrFallback<unknown>(record.request_payload_json, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export async function getWorkspaceTaskToolPolicy(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<Record<string, unknown> | null> {
  const record = await db
    .prepare('SELECT tool_policy_json FROM workspace_tasks WHERE id = ? AND workspace_id = ?')
    .bind(taskId, workspaceId)
    .first<{ tool_policy_json: string }>();

  if (!record) {
    return null;
  }

  const parsed = parseJsonOrFallback<unknown>(record.tool_policy_json, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export async function claimWorkspaceTaskForExecution(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE workspace_tasks
       SET status = 'running',
           started_at = COALESCE(started_at, ?),
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued' AND cancel_requested_at IS NULL`
    )
    .bind(now, now, taskId, workspaceId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function updateWorkspaceTaskStatus(
  db: D1Database,
  taskId: string,
  status: WorkspaceTaskStatus,
  options?: {
    workspaceId?: string;
    result?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }
): Promise<void> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: Array<string | null> = [status, new Date().toISOString()];

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

  if (options?.errorCode !== undefined) {
    updates.push('error_code = ?');
    values.push(options.errorCode);
  }

  if (options?.errorMessage !== undefined) {
    updates.push('error_message = ?');
    values.push(options.errorMessage);
  }

  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    updates.push('finished_at = COALESCE(finished_at, ?)');
    values.push(new Date().toISOString());
  }

  values.push(taskId);
  let whereClause = 'id = ?';
  if (options?.workspaceId) {
    whereClause += ' AND workspace_id = ?';
    values.push(options.workspaceId);
  }

  await db
    .prepare(`UPDATE workspace_tasks SET ${updates.join(', ')} WHERE ${whereClause}`)
    .bind(...values)
    .run();
}

export async function requestWorkspaceTaskCancel(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<{ task: WorkspaceTaskResponse | null; updated: boolean }> {
  const now = new Date().toISOString();
  const queuedResult = await db
    .prepare(
      `UPDATE workspace_tasks
       SET status = 'cancelled',
           cancel_requested_at = COALESCE(cancel_requested_at, ?),
           finished_at = COALESCE(finished_at, ?),
           error_code = NULL,
           error_message = NULL,
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued'`
    )
    .bind(now, now, now, taskId, workspaceId)
    .run();

  const runningResult = await db
    .prepare(
      `UPDATE workspace_tasks
       SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'running' AND cancel_requested_at IS NULL`
    )
    .bind(now, now, taskId, workspaceId)
    .run();

  const task = await getWorkspaceTask(db, workspaceId, taskId);
  return {
    task,
    updated: (queuedResult.meta?.changes ?? 0) > 0 || (runningResult.meta?.changes ?? 0) > 0,
  };
}

export async function appendWorkspaceTaskEvent(
  db: D1Database,
  input: {
    workspaceId: string;
    taskId: string;
    eventType: string;
    payload: unknown;
  }
): Promise<number> {
  const seqResult = await db
    .prepare(
      'UPDATE workspace_tasks SET last_event_seq = last_event_seq + 1 WHERE id = ? AND workspace_id = ? RETURNING last_event_seq'
    )
    .bind(input.taskId, input.workspaceId)
    .first<{ last_event_seq: number }>();

  if (!seqResult) {
    throw new Error(`Failed to allocate event sequence for workspace task ${input.taskId}`);
  }

  const seq = Number(seqResult.last_event_seq);

  await db
    .prepare(
      `INSERT INTO workspace_task_events (workspace_id, task_id, seq, event_type, payload_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(input.workspaceId, input.taskId, seq, input.eventType, JSON.stringify(input.payload))
    .run();

  return seq;
}

export async function listWorkspaceTaskEvents(
  db: D1Database,
  workspaceId: string,
  taskId: string,
  fromExclusive = 0,
  limit = 500
): Promise<WorkspaceTaskEventItem[]> {
  const result = await db
    .prepare(
      `SELECT seq, event_type, payload_json, created_at
       FROM workspace_task_events
       WHERE workspace_id = ? AND task_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .bind(workspaceId, taskId, fromExclusive, limit)
    .all<WorkspaceTaskEventRecord>();

  return result.results.map((row) => ({
    seq: row.seq,
    eventType: row.event_type,
    payload: parseJsonOrFallback(row.payload_json, { raw: row.payload_json }),
    createdAt: row.created_at,
  }));
}

export async function hasWorkspaceTaskEvent(
  db: D1Database,
  workspaceId: string,
  taskId: string,
  eventType: string
): Promise<boolean> {
  const record = await db
    .prepare(
      `SELECT 1
       FROM workspace_task_events
       WHERE workspace_id = ? AND task_id = ? AND event_type = ?
       LIMIT 1`
    )
    .bind(workspaceId, taskId, eventType)
    .first<{ '1': number }>();

  return Boolean(record);
}
