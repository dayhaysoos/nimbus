import { getWorkspaceTask } from './query.js';
import { generatePrefixedId, isUniqueConstraintError, toWorkspaceTaskResponse, WorkspaceTaskIdempotencyConflictError } from './shared.js';

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
): Promise<{ task: import('../../../types.js').WorkspaceTaskResponse; reused: boolean }> {
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
    .first();

  if (existingTaskByKey) {
    if ((existingTaskByKey as any).request_payload_sha256 !== input.requestPayloadSha256) {
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
        .bind(generatePrefixedId('wtsk'), input.workspaceId, input.idempotencyKey, (existingTaskByKey as any).id, input.requestPayloadSha256, expiresAt)
        .run();
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    return { task: toWorkspaceTaskResponse(existingTaskByKey as never), reused: true };
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
    .first();

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
      .bind(generatePrefixedId('wtsk'), input.workspaceId, input.idempotencyKey, input.id, input.requestPayloadSha256, expiresAt)
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

  return { task: toWorkspaceTaskResponse(taskRecord as never), reused: false };
}
