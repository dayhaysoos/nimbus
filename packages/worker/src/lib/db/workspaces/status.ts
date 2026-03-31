import type { WorkspaceStatus } from '../../../types.js';

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

  const result = await db.prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE ${whereClause}`).bind(...values).run();
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
