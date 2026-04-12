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
export { WorkspaceCreateIdempotencyConflictError } from './db/workspaces.js';
export { WorkspaceCreateInProgressError } from './db/workspaces.js';
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
  updateWorkspaceDeploymentSummary,
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
  attachReviewPassToSession,
  createReviewSession,
  deleteReviewSession,
  generateReviewSessionId,
  getReviewSession,
  getReviewSessionAccountId,
  getReviewSessionByReviewId,
} from './db/review-sessions.js';
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
