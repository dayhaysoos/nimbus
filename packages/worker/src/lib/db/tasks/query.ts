import type { WorkspaceTaskResponse } from '../../../types.js';
import { toWorkspaceTaskResponse, WorkspaceTaskIdempotencyConflictError } from './shared.js';

export async function getWorkspaceTask(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<WorkspaceTaskResponse | null> {
  const record = await db
    .prepare('SELECT * FROM workspace_tasks WHERE id = ? AND workspace_id = ?')
    .bind(taskId, workspaceId)
    .first();

  if (!record) {
    return null;
  }

  return toWorkspaceTaskResponse(record as never);
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

  const parsed = JSON.parse(record.request_payload_json || '{}') as unknown;
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

  const parsed = JSON.parse(record.tool_policy_json || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export async function getWorkspaceTaskByIdempotency(
  db: D1Database,
  workspaceId: string,
  idempotencyKey: string,
  requestPayloadSha256: string
): Promise<WorkspaceTaskResponse | null> {
  const now = new Date().toISOString();
  const existingIdempotency = await db
    .prepare(
      `SELECT task_id, request_payload_sha256, expires_at
       FROM workspace_task_idempotency
       WHERE workspace_id = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(workspaceId, idempotencyKey)
    .first<{ task_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (existingIdempotency.request_payload_sha256 !== requestPayloadSha256) {
      throw new WorkspaceTaskIdempotencyConflictError(idempotencyKey);
    }

    const task = await getWorkspaceTask(db, workspaceId, existingIdempotency.task_id);
    if (!task) {
      throw new Error(`Idempotency record references missing task ${existingIdempotency.task_id}`);
    }
    return task;
  }

  const idempotencyWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingTask = await db
    .prepare(
      `SELECT *
       FROM workspace_tasks
       WHERE workspace_id = ?
         AND idempotency_key = ?
         AND julianday(created_at) >= julianday(?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(workspaceId, idempotencyKey, idempotencyWindowStart)
    .first();

  if (!existingTask) {
    return null;
  }

  if ((existingTask as any).request_payload_sha256 !== requestPayloadSha256) {
    throw new WorkspaceTaskIdempotencyConflictError(idempotencyKey);
  }

  return toWorkspaceTaskResponse(existingTask as never);
}
