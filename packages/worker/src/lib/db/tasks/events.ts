import { parseJsonOrFallback, WorkspaceTaskEventItem, WorkspaceTaskEventRecord } from './shared.js';

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
    .prepare('UPDATE workspace_tasks SET last_event_seq = last_event_seq + 1 WHERE id = ? AND workspace_id = ? RETURNING last_event_seq')
    .bind(input.taskId, input.workspaceId)
    .first<{ last_event_seq: number }>();

  if (!seqResult) {
    throw new Error(`Failed to allocate event sequence for workspace task ${input.taskId}`);
  }

  const seq = Number(seqResult.last_event_seq);
  await db
    .prepare(`INSERT INTO workspace_task_events (workspace_id, task_id, seq, event_type, payload_json) VALUES (?, ?, ?, ?, ?)`)
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
    .prepare(`SELECT 1 FROM workspace_task_events WHERE workspace_id = ? AND task_id = ? AND event_type = ? LIMIT 1`)
    .bind(workspaceId, taskId, eventType)
    .first<{ '1': number }>();

  return Boolean(record);
}
