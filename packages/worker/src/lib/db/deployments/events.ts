import { parseJsonOrFallback, WorkspaceDeploymentEventItem, WorkspaceDeploymentEventRecord } from './shared.js';

export async function appendWorkspaceDeploymentEvent(
  db: D1Database,
  input: {
    workspaceId: string;
    deploymentId: string;
    eventType: string;
    payload: unknown;
  }
): Promise<number> {
  const seqResult = await db
    .prepare('UPDATE workspace_deployments SET last_event_seq = last_event_seq + 1 WHERE id = ? AND workspace_id = ? RETURNING last_event_seq')
    .bind(input.deploymentId, input.workspaceId)
    .first<{ last_event_seq: number }>();

  if (!seqResult) {
    throw new Error(`Failed to allocate event sequence for workspace deployment ${input.deploymentId}`);
  }

  const seq = Number(seqResult.last_event_seq);
  await db
    .prepare(`INSERT INTO workspace_deployment_events (workspace_id, deployment_id, seq, event_type, payload_json) VALUES (?, ?, ?, ?, ?)`)
    .bind(input.workspaceId, input.deploymentId, seq, input.eventType, JSON.stringify(input.payload))
    .run();
  return seq;
}

export async function listWorkspaceDeploymentEvents(
  db: D1Database,
  workspaceId: string,
  deploymentId: string,
  fromExclusive = 0,
  limit = 500
): Promise<WorkspaceDeploymentEventItem[]> {
  const result = await db
    .prepare(`SELECT seq, event_type, payload_json, created_at FROM workspace_deployment_events WHERE workspace_id = ? AND deployment_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
    .bind(workspaceId, deploymentId, fromExclusive, limit)
    .all<WorkspaceDeploymentEventRecord>();
  return result.results.map((row) => ({
    seq: row.seq,
    eventType: row.event_type,
    payload: parseJsonOrFallback(row.payload_json, { raw: row.payload_json }),
    createdAt: row.created_at,
  }));
}

export async function hasWorkspaceDeploymentEvent(
  db: D1Database,
  workspaceId: string,
  deploymentId: string,
  eventType: string
): Promise<boolean> {
  const record = await db
    .prepare(`SELECT 1 FROM workspace_deployment_events WHERE workspace_id = ? AND deployment_id = ? AND event_type = ? LIMIT 1`)
    .bind(workspaceId, deploymentId, eventType)
    .first<{ '1': number }>();
  return Boolean(record);
}
