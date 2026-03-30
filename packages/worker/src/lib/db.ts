import type { WorkspaceDeploymentStatus } from '../types.js';

function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

export { generateJobId } from './db/jobs.js';
export { generateWorkspaceId } from './db/workspaces.js';
export { generateWorkspaceOperationId, WorkspaceIdempotencyConflictError } from './db/operations.js';
export { WorkspaceTaskIdempotencyConflictError } from './db/tasks.js';
export { WorkspaceDeploymentIdempotencyConflictError } from './db/deployments.js';
export { ReviewIdempotencyConflictError } from './db/reviews.js';

export function generateWorkspaceArtifactId(): string {
  return generatePrefixedId('art');
}

export function generateWorkspaceTaskId(): string {
  return generatePrefixedId('task');
}

export function generateWorkspaceDeploymentId(): string {
  return generatePrefixedId('dep');
}

export function generateReviewRunId(): string {
  return generatePrefixedId('review');
}

export {
  appendJobEvent,
  claimQueuedCheckpointJob,
  createCheckpointJob,
  deleteJob,
  getJob,
  listJobEvents,
  listJobs,
  markJobCancelled,
  updateJobStatus,
} from './db/jobs.js';

export {
  appendWorkspaceEvent,
  createWorkspace,
  getWorkspace,
  getWorkspaceAccountId,
  listWorkspaceEvents,
  markWorkspaceDeleted,
  markWorkspaceFailed,
  markWorkspaceReady,
  updateWorkspaceStatus,
} from './db/workspaces.js';

export {
  claimWorkspaceOperationForExecution,
  createWorkspaceOperation,
  getWorkspaceOperation,
  updateWorkspaceOperationStatus,
} from './db/operations.js';

export {
  createWorkspaceArtifact,
  getWorkspaceArtifactById,
  listWorkspaceArtifacts,
} from './db/artifacts.js';
export type { WorkspaceArtifactLookup } from './db/artifacts.js';

export {
  appendWorkspaceTaskEvent,
  claimWorkspaceTaskForExecution,
  createWorkspaceTask,
  getWorkspaceTask,
  getWorkspaceTaskRequestPayload,
  getWorkspaceTaskToolPolicy,
  hasWorkspaceTaskEvent,
  listWorkspaceTaskEvents,
  requestWorkspaceTaskCancel,
  updateWorkspaceTaskStatus,
} from './db/tasks.js';

export {
  appendWorkspaceDeploymentEvent,
  claimWorkspaceDeploymentForExecution,
  createWorkspaceDeployment,
  getWorkspaceDeployment,
  getWorkspaceDeploymentRequestPayload,
  hasWorkspaceDeploymentEvent,
  listWorkspaceDeploymentEvents,
  markWorkspaceDeploymentSucceededIfNotCancelled,
  requestWorkspaceDeploymentCancel,
  updateWorkspaceDeploymentStatus,
} from './db/deployments.js';

export {
  appendReviewEvent,
  claimReviewRunForExecution,
  createReviewRun,
  getHighestFindingNumberForBranch,
  getReviewRun,
  getReviewRunAccountId,
  getReviewRunByIdempotency,
  getReviewRunRequestPayload,
  hasReviewEvent,
  listReviewEvents,
  listReviewRuns,
  replaceReviewFindings,
  updateReviewRunPolicy,
  updateReviewRunStatus,
} from './db/reviews.js';
export {
  createReviewContextBlobReference,
  generateReviewContextId,
  getLatestSuccessfulWorkspaceDeployment,
  getReviewCochangeCache,
  getReviewCochangeCacheBatch,
  getReviewContextBlobReference,
  getWorkspaceDependencyCache,
  upsertReviewCochangeCache,
  upsertReviewCochangeCacheBatch,
  upsertWorkspaceDependencyCache,
} from './db/caches.js';

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
