import { WorkspaceEventItem, WorkspaceEventRecord } from './shared.js';

/** Appends a sequenced workspace event and returns the allocated sequence number. */
export async function appendWorkspaceEvent(
  db: D1Database,
  input: {
    workspaceId: string;
    eventType: string;
    payload: unknown;
  }
): Promise<number> {
  const sequenceResult = await db
    .prepare('UPDATE workspaces SET last_event_seq = last_event_seq + 1 WHERE id = ? RETURNING last_event_seq')
    .bind(input.workspaceId)
    .first<{ last_event_seq: number }>();

  if (!sequenceResult) {
    throw new Error(`Failed to allocate event sequence for workspace ${input.workspaceId}`);
  }

  const seq = Number(sequenceResult.last_event_seq);
  await db
    .prepare(`INSERT INTO workspace_events (workspace_id, seq, event_type, payload_json) VALUES (?, ?, ?, ?)`)
    .bind(input.workspaceId, seq, input.eventType, JSON.stringify(input.payload))
    .run();

  return seq;
}

export async function listWorkspaceEvents(
  db: D1Database,
  workspaceId: string,
  fromExclusive = 0,
  limit = 500
): Promise<WorkspaceEventItem[]> {
  const result = await db
    .prepare(
      `SELECT seq, event_type, payload_json, created_at
       FROM workspace_events
       WHERE workspace_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .bind(workspaceId, fromExclusive, limit)
    .all<WorkspaceEventRecord>();

  return result.results.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = { raw: row.payload_json };
    }
    return { seq: row.seq, eventType: row.event_type, payload, createdAt: row.created_at };
  });
}
