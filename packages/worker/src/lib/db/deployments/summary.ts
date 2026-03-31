import type { WorkspaceDeploymentStatus } from '../../../types.js';

export async function updateWorkspaceDeploymentSummary(
  db: D1Database,
  workspaceId: string,
  input: {
    deploymentId: string;
    status: WorkspaceDeploymentStatus;
    deployedUrl?: string | null;
    deployedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }
): Promise<void> {
  const updates: string[] = [
    'last_deployment_id = ?',
    'last_deployment_status = ?',
    'last_deployment_error_code = ?',
    'last_deployment_error_message = ?',
    'updated_at = ?',
  ];
  const values: Array<string | null> = [
    input.deploymentId,
    input.status,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    new Date().toISOString(),
  ];

  if (input.deployedUrl !== undefined) {
    updates.push('last_deployed_url = ?');
    values.push(input.deployedUrl);
  }
  if (input.deployedAt !== undefined) {
    updates.push('last_deployed_at = ?');
    values.push(input.deployedAt);
  }

  values.push(workspaceId);
  values.push(input.deploymentId);
  await db
    .prepare(
      `UPDATE workspaces
       SET ${updates.join(', ')}
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM workspace_deployments candidate
           LEFT JOIN workspace_deployments current ON current.id = workspaces.last_deployment_id
           WHERE candidate.id = ?
             AND candidate.workspace_id = workspaces.id
             AND (
               workspaces.last_deployment_id IS NULL
               OR current.id IS NULL
               OR workspaces.last_deployment_id = candidate.id
               OR julianday(candidate.created_at) > julianday(current.created_at)
               OR (
                 julianday(candidate.created_at) = julianday(current.created_at)
                 AND (current.id IS NULL OR candidate.rowid >= current.rowid)
               )
             )
         )`
    )
    .bind(...values)
    .run();
}
