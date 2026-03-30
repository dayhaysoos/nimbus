import type { WorkspaceDeploymentStatus, WorkspaceRecord, WorkspaceResponse, WorkspaceStatus } from '../../types.js';

interface WorkspaceEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface WorkspaceEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

function toWorkspaceResponse(record: WorkspaceRecord): WorkspaceResponse {
  return {
    id: record.id,
    status: record.status,
    sourceType: record.source_type,
    checkpointId: record.checkpoint_id,
    commitSha: record.commit_sha,
    sourceRef: record.source_ref,
    sourceProjectRoot: record.source_project_root,
    sourceBundleKey: record.source_bundle_key,
    sourceBundleSha256: record.source_bundle_sha256,
    sourceBundleBytes: record.source_bundle_bytes,
    sandboxId: record.sandbox_id,
    baselineReady: Boolean(record.baseline_ready),
    errorCode: record.error_code,
    errorMessage: record.error_message,
    lastDeploymentId: record.last_deployment_id ?? null,
    lastDeploymentStatus: (record.last_deployment_status as WorkspaceDeploymentStatus | null) ?? null,
    lastDeployedUrl: record.last_deployed_url ?? null,
    lastDeployedAt: record.last_deployed_at ?? null,
    lastDeploymentErrorCode: record.last_deployment_error_code ?? null,
    lastDeploymentErrorMessage: record.last_deployment_error_message ?? null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    deletedAt: record.deleted_at,
    eventsUrl: `/api/workspaces/${record.id}/events`,
  };
}

/** Allocates a stable workspace identifier. */
export function generateWorkspaceId(): string {
  return generatePrefixedId('ws');
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
  }
): Promise<WorkspaceResponse> {
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
    .first<WorkspaceRecord>();

  if (!result) {
    throw new Error('Failed to create workspace');
  }

  return toWorkspaceResponse(result);
}

export async function getWorkspace(db: D1Database, id: string): Promise<WorkspaceResponse | null> {
  const result = await db.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first<WorkspaceRecord>();
  if (!result) {
    return null;
  }

  return toWorkspaceResponse(result);
}

export async function getWorkspaceAccountId(db: D1Database, id: string): Promise<string | null | undefined> {
  const result = await db
    .prepare('SELECT account_id FROM workspaces WHERE id = ?')
    .bind(id)
    .first<{ account_id: string | null }>();
  if (!result) {
    return undefined;
  }
  return result.account_id;
}

/** Updates workspace status plus selected metadata columns, optionally refusing to touch deleted rows. */
export async function updateWorkspaceStatus(
  db: D1Database,
  id: string,
  status: WorkspaceStatus,
  additionalFields?: {
    baseline_ready?: number;
    deleted_at?: string | null;
    error_code?: string | null;
    error_message?: string | null;
  },
  options?: {
    ifNotDeleted?: boolean;
  }
): Promise<boolean> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: (string | number | null)[] = [status, new Date().toISOString()];

  if (additionalFields) {
    if (additionalFields.baseline_ready !== undefined) {
      updates.push('baseline_ready = ?');
      values.push(additionalFields.baseline_ready);
    }
    if (additionalFields.deleted_at !== undefined) {
      updates.push('deleted_at = ?');
      values.push(additionalFields.deleted_at);
    }
    if (additionalFields.error_code !== undefined) {
      updates.push('error_code = ?');
      values.push(additionalFields.error_code);
    }
    if (additionalFields.error_message !== undefined) {
      updates.push('error_message = ?');
      values.push(additionalFields.error_message);
    }
  }

  values.push(id);

  let whereClause = 'id = ?';
  if (options?.ifNotDeleted) {
    whereClause += " AND status != 'deleted'";
  }

  const result = await db
    .prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE ${whereClause}`)
    .bind(...values)
    .run();

  return Number(result.meta?.changes ?? 0) > 0;
}

export async function markWorkspaceReady(db: D1Database, id: string, baselineReady = true): Promise<boolean> {
  return updateWorkspaceStatus(
    db,
    id,
    'ready',
    {
      baseline_ready: baselineReady ? 1 : 0,
      error_code: null,
      error_message: null,
    },
    { ifNotDeleted: true }
  );
}

export async function markWorkspaceFailed(
  db: D1Database,
  id: string,
  message: string,
  errorCode: string | null = null
): Promise<boolean> {
  return updateWorkspaceStatus(
    db,
    id,
    'failed',
    {
      error_code: errorCode,
      error_message: message,
    },
    { ifNotDeleted: true }
  );
}

export async function markWorkspaceDeleted(db: D1Database, id: string): Promise<boolean> {
  return updateWorkspaceStatus(db, id, 'deleted', {
    deleted_at: new Date().toISOString(),
  });
}

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
    .prepare(
      `INSERT INTO workspace_events (workspace_id, seq, event_type, payload_json)
       VALUES (?, ?, ?, ?)`
    )
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

    return {
      seq: row.seq,
      eventType: row.event_type,
      payload,
      createdAt: row.created_at,
    };
  });
}
