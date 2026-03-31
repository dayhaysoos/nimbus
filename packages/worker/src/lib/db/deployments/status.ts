import type { WorkspaceDeploymentRemediation, WorkspaceDeploymentStatus, WorkspaceToolchainProfile } from '../../../types.js';
import { getWorkspaceDeployment } from './query.js';

export async function claimWorkspaceDeploymentForExecution(db: D1Database, workspaceId: string, deploymentId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE workspace_deployments
       SET status = 'running',
           started_at = COALESCE(started_at, ?),
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued' AND cancel_requested_at IS NULL`
    )
    .bind(now, now, deploymentId, workspaceId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function updateWorkspaceDeploymentStatus(
  db: D1Database,
  deploymentId: string,
  status: WorkspaceDeploymentStatus,
  options?: {
    workspaceId?: string;
    result?: unknown;
    toolchain?: WorkspaceToolchainProfile | null;
    dependencyCacheKey?: string | null;
    dependencyCacheHit?: boolean;
    remediations?: WorkspaceDeploymentRemediation[];
    errorCode?: string | null;
    errorMessage?: string | null;
    sourceSnapshotSha256?: string | null;
    sourceBundleKey?: string | null;
    deployedUrl?: string | null;
    providerDeploymentId?: string | null;
    cancelRequestedAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }
): Promise<void> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: Array<string | number | null> = [status, new Date().toISOString()];
  let explicitFinishedAt: string | null | undefined;
  if (options?.startedAt !== undefined) { updates.push('started_at = ?'); values.push(options.startedAt); }
  if (options?.finishedAt !== undefined) { updates.push('finished_at = ?'); values.push(options.finishedAt); explicitFinishedAt = options.finishedAt; }
  if (options?.result !== undefined) { updates.push('result_json = ?'); values.push(JSON.stringify(options.result)); }
  if (options?.toolchain !== undefined) { updates.push('toolchain_json = ?'); values.push(options.toolchain ? JSON.stringify(options.toolchain) : null); }
  if (options?.dependencyCacheKey !== undefined) { updates.push('dependency_cache_key = ?'); values.push(options.dependencyCacheKey); }
  if (options?.dependencyCacheHit !== undefined) { updates.push('dependency_cache_hit = ?'); values.push(options.dependencyCacheHit ? 1 : 0); }
  if (options?.remediations !== undefined) { updates.push('remediations_json = ?'); values.push(JSON.stringify(options.remediations)); }
  if (options?.errorCode !== undefined) { updates.push('error_code = ?'); values.push(options.errorCode); }
  if (options?.errorMessage !== undefined) { updates.push('error_message = ?'); values.push(options.errorMessage); }
  if (options?.sourceSnapshotSha256 !== undefined) { updates.push('source_snapshot_sha256 = ?'); values.push(options.sourceSnapshotSha256); }
  if (options?.sourceBundleKey !== undefined) { updates.push('source_bundle_key = ?'); values.push(options.sourceBundleKey); }
  if (options?.deployedUrl !== undefined) { updates.push('deployed_url = ?'); values.push(options.deployedUrl); }
  if (options?.providerDeploymentId !== undefined) { updates.push('provider_deployment_id = ?'); values.push(options.providerDeploymentId); }
  if (options?.cancelRequestedAt !== undefined) { updates.push('cancel_requested_at = ?'); values.push(options.cancelRequestedAt); }
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    const finishedAtForDuration = explicitFinishedAt && typeof explicitFinishedAt === 'string' ? explicitFinishedAt : new Date().toISOString();
    if (explicitFinishedAt === undefined) { updates.push('finished_at = COALESCE(finished_at, ?)'); values.push(finishedAtForDuration); }
    updates.push('duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) END');
    values.push(finishedAtForDuration);
  }
  values.push(deploymentId);
  let whereClause = 'id = ?';
  if (options?.workspaceId) { whereClause += ' AND workspace_id = ?'; values.push(options.workspaceId); }
  if (status === 'running') whereClause += " AND status IN ('queued', 'running')";
  await db.prepare(`UPDATE workspace_deployments SET ${updates.join(', ')} WHERE ${whereClause}`).bind(...values).run();
}

export async function markWorkspaceDeploymentSucceededIfNotCancelled(
  db: D1Database,
  input: {
    workspaceId: string;
    deploymentId: string;
    sourceSnapshotSha256: string;
    sourceBundleKey: string;
    deployedUrl: string | null;
    providerDeploymentId: string;
    result: unknown;
    finishedAt: string;
  }
): Promise<boolean> {
  const updatedAt = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE workspace_deployments
       SET status = 'succeeded',
           source_snapshot_sha256 = ?,
           source_bundle_key = ?,
           deployed_url = ?,
           provider_deployment_id = ?,
           result_json = ?,
           error_code = NULL,
           error_message = NULL,
           finished_at = ?,
           duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) END,
           updated_at = ?
       WHERE id = ?
         AND workspace_id = ?
         AND status = 'running'
         AND cancel_requested_at IS NULL`
    )
    .bind(input.sourceSnapshotSha256, input.sourceBundleKey, input.deployedUrl, input.providerDeploymentId, JSON.stringify(input.result), input.finishedAt, input.finishedAt, updatedAt, input.deploymentId, input.workspaceId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function requestWorkspaceDeploymentCancel(
  db: D1Database,
  workspaceId: string,
  deploymentId: string
): Promise<{ deployment: import('../../../types.js').WorkspaceDeploymentResponse | null; updated: boolean }> {
  const now = new Date().toISOString();
  const queuedResult = await db
    .prepare(
      `UPDATE workspace_deployments
       SET status = 'cancelled',
           cancel_requested_at = COALESCE(cancel_requested_at, ?),
           finished_at = COALESCE(finished_at, ?),
           error_code = NULL,
           error_message = NULL,
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued'`
    )
    .bind(now, now, now, deploymentId, workspaceId)
    .run();
  const runningResult = await db
    .prepare(
      `UPDATE workspace_deployments
       SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'running' AND cancel_requested_at IS NULL`
    )
    .bind(now, now, deploymentId, workspaceId)
    .run();
  const deployment = await getWorkspaceDeployment(db, workspaceId, deploymentId);
  return { deployment, updated: (queuedResult.meta?.changes ?? 0) > 0 || (runningResult.meta?.changes ?? 0) > 0 };
}
