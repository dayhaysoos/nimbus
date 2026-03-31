import type { WorkspaceTaskStatus } from '../../../types.js';
import { getWorkspaceTask } from './query.js';

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

  await db.prepare(`UPDATE workspace_tasks SET ${updates.join(', ')} WHERE ${whereClause}`).bind(...values).run();
}

export async function requestWorkspaceTaskCancel(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<{ task: import('../../../types.js').WorkspaceTaskResponse | null; updated: boolean }> {
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
