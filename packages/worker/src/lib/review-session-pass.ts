import type { Env, ReviewBasis, ReviewPolicyMode, ReviewSessionResponse } from '../types.js';
import {
  attachReviewPassToSession,
  appendReviewEvent,
  createReviewRun,
  generateReviewRunId,
  getReviewRunByIdempotency,
  getWorkspace,
  getWorkspaceAccountId,
  getWorkspaceDeployment,
} from './db.js';
import { captureWorkspaceEnvironmentSnapshot, type WorkspaceEnvironmentSnapshot } from './review-runner/environment.js';
import { buildReviewRequestPayload, sha256Hex, stripSensitiveTokenFields } from '../api/reviews/request-shared.js';

export interface CreateReviewSessionPassInput {
  session: ReviewSessionResponse;
  reviewBasis: ReviewBasis;
  policyMode?: ReviewPolicyMode;
  provenance?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  format?: Record<string, unknown>;
  model?: string;
  idempotencyKey?: string;
  environmentSnapshot?: WorkspaceEnvironmentSnapshot | null;
}

export interface CreateReviewSessionPassResult {
  review: import('../types.js').ReviewRunResponse;
  reused: boolean;
  environmentSnapshot: WorkspaceEnvironmentSnapshot | null;
}

export class CreateReviewSessionPassError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'CreateReviewSessionPassError';
  }
}

export async function createReviewSessionPass(
  env: Env,
  input: CreateReviewSessionPassInput
): Promise<CreateReviewSessionPassResult> {
  const session = input.session;
  const reviewBasis = input.reviewBasis;
  const policyMode = input.policyMode ?? 'none';
  const workspace = await getWorkspace(env.DB, session.workspaceId);
  if (!workspace || workspace.status === 'deleted') {
    throw new CreateReviewSessionPassError('Workspace not found', 404, 'workspace_not_found');
  }

  const workspaceAccountId = await getWorkspaceAccountId(env.DB, session.workspaceId);
  if (workspaceAccountId === undefined) {
    throw new CreateReviewSessionPassError('Workspace not found', 404, 'workspace_not_found');
  }

  const deployment = await getWorkspaceDeployment(env.DB, session.workspaceId, session.anchorDeploymentId);
  if (!deployment) {
    throw new CreateReviewSessionPassError('Anchor deployment not found', 404, 'deployment_not_found');
  }
  if (deployment.status !== 'succeeded') {
    throw new CreateReviewSessionPassError('Review session anchor deployment must be succeeded', 409, 'deployment_not_reviewable');
  }

  const environmentSnapshot =
    reviewBasis === 'environment'
      ? (input.environmentSnapshot ??
        (await captureWorkspaceEnvironmentSnapshot(env, {
          id: workspace.id,
          status: workspace.status,
          sandboxId: workspace.sandboxId,
          baselineReady: workspace.baselineReady,
          sourceBundleKey: workspace.sourceBundleKey,
          sourceBundleSha256: workspace.sourceBundleSha256,
        })))
      : null;
  const defaultIdempotencyKey =
    reviewBasis === 'environment' && environmentSnapshot
      ? `review-session-pass:${session.id}:${environmentSnapshot.revision.diffSha256.slice(0, 24)}`
      : `review-session-pass:${session.id}:${session.passCount + 1}`;
  const idempotencyKey = (input.idempotencyKey ?? defaultIdempotencyKey).trim();
  if (!idempotencyKey) {
    throw new CreateReviewSessionPassError('Missing required Idempotency-Key value', 400, 'missing_idempotency_key');
  }

  const { requestPayload, idempotencyPayload } = buildReviewRequestPayload({
    workspaceId: session.workspaceId,
    deploymentId: session.anchorDeploymentId,
    policyMode,
    reviewBasis,
    policy: input.policy ?? {},
    format: input.format ?? {},
    provenance: {
      ...(input.provenance ?? {}),
      repo: session.repo,
      branch: session.branch,
      ...(environmentSnapshot ? { environmentRevision: environmentSnapshot.revision } : {}),
    },
    repo: session.repo,
    branch: session.branch,
    model: input.model,
  });
  const sanitizedRequestPayload = stripSensitiveTokenFields(requestPayload) as Record<string, unknown>;
  const requestPayloadSha256 = await sha256Hex(JSON.stringify(idempotencyPayload));
  const existingReview = await getReviewRunByIdempotency(env.DB, session.workspaceId, idempotencyKey, requestPayloadSha256);
  if (existingReview) {
    return {
      review: existingReview,
      reused: true,
      environmentSnapshot,
    };
  }

  const created = await createReviewRun(env.DB, {
    id: generateReviewRunId(),
    workspaceId: session.workspaceId,
    deploymentId: session.anchorDeploymentId,
    sessionId: session.id,
    targetType: 'workspace_deployment',
    mode: 'report_only',
    idempotencyKey,
    requestPayload: sanitizedRequestPayload,
    requestPayloadSha256,
    accountId: workspaceAccountId,
    provenance: {
      promptSummary:
        reviewBasis === 'environment'
          ? `Environment re-review for session ${session.id}`
          : `Checkpoint re-review for session ${session.id}`,
    },
    repo: session.repo,
    branch: session.branch,
  });

  await attachReviewPassToSession(env.DB, session.id, created.review.id);
  await appendReviewEvent(env.DB, {
    reviewId: created.review.id,
    eventType: 'review_created',
    payload: {
      workspaceId: session.workspaceId,
      deploymentId: session.anchorDeploymentId,
      mode: 'report_only',
      sessionId: session.id,
      reviewBasis,
      environmentRevision: environmentSnapshot?.revision ?? null,
    },
  });

  return {
    review: created.review,
    reused: created.reused,
    environmentSnapshot,
  };
}
