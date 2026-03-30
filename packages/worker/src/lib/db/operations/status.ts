import type { WorkspaceOperationStatus } from '../../../types.js';

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

  if (options?.startedAt !== undefined) { updates.push('started_at = ?'); values.push(options.startedAt); }
  if (options?.finishedAt !== undefined) { updates.push('finished_at = ?'); values.push(options.finishedAt); }
  if (options?.result !== undefined) { updates.push('result_json = ?'); values.push(JSON.stringify(options.result)); }
  if (options?.warnings !== undefined) { updates.push('warnings_json = ?'); values.push(JSON.stringify(options.warnings)); }
  if (options?.errorCode !== undefined) { updates.push('error_code = ?'); values.push(options.errorCode); }
  if (options?.errorClass !== undefined) { updates.push('error_class = ?'); values.push(options.errorClass); }
  if (options?.errorMessage !== undefined) { updates.push('error_message = ?'); values.push(options.errorMessage); }
  if (options?.errorDetails !== undefined) { updates.push('error_details_json = ?'); values.push(JSON.stringify(options.errorDetails)); }
  if (status === 'running') { updates.push('started_at = COALESCE(started_at, ?)'); values.push(new Date().toISOString()); }
  if (status === 'succeeded' || status === 'failed') {
    updates.push('finished_at = COALESCE(finished_at, ?)');
    values.push(new Date().toISOString());
    updates.push('duration_ms = CASE WHEN started_at IS NULL OR COALESCE(finished_at, ?) IS NULL THEN NULL ELSE CAST((julianday(COALESCE(finished_at, ?)) - julianday(started_at)) * 86400000 AS INTEGER) END');
    const finishedAtForDuration = new Date().toISOString();
    values.push(finishedAtForDuration, finishedAtForDuration);
  }

  values.push(operationId);
  await db.prepare(`UPDATE workspace_operations SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
}
