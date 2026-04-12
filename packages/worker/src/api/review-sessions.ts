import type { AuthContext, Env } from '../types.js';
import {
  attachReviewPassToSession,
  appendReviewEvent,
  createReviewRun,
  generateReviewRunId,
  getReviewRunByIdempotency,
  getReviewSession,
  getWorkspace,
  getWorkspaceAccountId,
  getWorkspaceDeployment,
} from '../lib/db.js';
import { captureWorkspaceEnvironmentSnapshot } from '../lib/review-runner/environment.js';
import { buildReviewRequestPayload, normalizePolicyMode, normalizeReviewBasis, sha256Hex, stripSensitiveTokenFields } from './reviews/request-shared.js';
import { enqueueReviewRunIfNeeded } from './reviews/queue.js';
import {
  isRecord,
  isReviewStatusActive,
  jsonResponse,
  readOpenrouterApiKeyHeader,
  readReviewGithubTokenHeader,
  requireReviewSessionAccess,
} from './reviews/shared.js';

export async function handleGetReviewSession(
  sessionId: string,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);

  const accessResponse = await requireReviewSessionAccess(env, sessionId, effectiveAuthContext);
  if (accessResponse) {
    return accessResponse;
  }

  const session = await getReviewSession(env.DB, sessionId);
  if (!session) {
    return jsonResponse({ error: 'Review session not found' }, 404);
  }

  return jsonResponse({ session });
}

export async function handleCreateReviewSessionPass(
  sessionId: string,
  request: Request,
  env: Env,
  _ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  try {
    if (!env.REVIEWS_QUEUE || !env.ReviewRunner) {
      return jsonResponse(
        {
          error: 'Review runner is unavailable',
          code: 'review_runner_unavailable',
        },
        503
      );
    }

    const accessResponse = await requireReviewSessionAccess(env, sessionId, effectiveAuthContext);
    if (accessResponse) {
      return accessResponse;
    }

    const session = await getReviewSession(env.DB, sessionId);
    if (!session) {
      return jsonResponse({ error: 'Review session not found' }, 404);
    }
    if (session.activeReviewId && session.currentReviewStatus && isReviewStatusActive(session.currentReviewStatus)) {
      return jsonResponse(
        {
          error: 'Review session already has an active pass',
          code: 'review_session_active',
          activeReviewId: session.activeReviewId,
          currentReviewStatus: session.currentReviewStatus,
        },
        409
      );
    }

    const payloadRaw = await request.text();
    const payload = payloadRaw.trim() ? (JSON.parse(payloadRaw) as unknown) : {};
    if (!isRecord(payload)) {
      return jsonResponse({ error: 'Request body must be a JSON object' }, 400);
    }

    const rawPolicyMode = typeof payload.policyMode === 'string' ? payload.policyMode.trim() : payload.policyMode;
    const policyMode = normalizePolicyMode(payload.policyMode);
    if (payload.policyMode !== undefined && policyMode !== rawPolicyMode) {
      return jsonResponse(
        {
          error: 'Invalid policyMode',
          code: 'invalid_review_policy_mode',
          allowedPolicyModes: ['none'],
        },
        400
      );
    }
    if (policyMode !== 'none') {
      return jsonResponse(
        {
          error: 'Session re-review currently supports policyMode=none only',
          code: 'unsupported_review_policy_mode',
        },
        400
      );
    }

    const rawReviewBasis = typeof payload.reviewBasis === 'string' ? payload.reviewBasis.trim() : payload.reviewBasis;
    const reviewBasis = normalizeReviewBasis(payload.reviewBasis ?? 'environment');
    if (payload.reviewBasis !== undefined && reviewBasis !== rawReviewBasis) {
      return jsonResponse(
        {
          error: 'Invalid reviewBasis',
          code: 'invalid_review_basis',
          allowedReviewBasis: ['checkpoint', 'environment'],
        },
        400
      );
    }

    const workspace = await getWorkspace(env.DB, session.workspaceId);
    if (!workspace || workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }
    const workspaceAccountId = await getWorkspaceAccountId(env.DB, session.workspaceId);
    if (workspaceAccountId === undefined) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const deployment = await getWorkspaceDeployment(env.DB, session.workspaceId, session.anchorDeploymentId);
    if (!deployment) {
      return jsonResponse({ error: 'Anchor deployment not found' }, 404);
    }
    if (deployment.status !== 'succeeded') {
      return jsonResponse(
        {
          error: 'Review session anchor deployment must be succeeded',
          code: 'deployment_not_reviewable',
        },
        409
      );
    }

    const reviewGithubToken = readReviewGithubTokenHeader(request);
    const openrouterApiKey = readOpenrouterApiKeyHeader(request);
    const userProvenance = isRecord(payload.provenance) ? payload.provenance : {};
    const environmentSnapshot =
      reviewBasis === 'environment'
        ? await captureWorkspaceEnvironmentSnapshot(env, {
            id: workspace.id,
            status: workspace.status,
            sandboxId: workspace.sandboxId,
            baselineReady: workspace.baselineReady,
            sourceBundleKey: workspace.sourceBundleKey,
            sourceBundleSha256: workspace.sourceBundleSha256,
          })
        : null;
    const defaultIdempotencyKey =
      reviewBasis === 'environment' && environmentSnapshot
        ? `review-session-pass:${session.id}:${environmentSnapshot.revision.diffSha256.slice(0, 24)}`
        : `review-session-pass:${session.id}:${session.passCount + 1}`;
    const idempotencyKey = (request.headers.get('Idempotency-Key') ?? defaultIdempotencyKey).trim();
    if (!idempotencyKey) {
      return jsonResponse({ error: 'Missing required Idempotency-Key header' }, 400);
    }

    const { requestPayload, idempotencyPayload } = buildReviewRequestPayload({
      workspaceId: session.workspaceId,
      deploymentId: session.anchorDeploymentId,
      policyMode: 'none',
      reviewBasis,
      policy: isRecord(payload.policy) ? payload.policy : {},
      format: isRecord(payload.format) ? payload.format : {},
      provenance: {
        ...userProvenance,
        repo: session.repo,
        branch: session.branch,
        ...(environmentSnapshot ? { environmentRevision: environmentSnapshot.revision } : {}),
      },
      repo: session.repo,
      branch: session.branch,
      model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined,
    });
    const sanitizedRequestPayload = stripSensitiveTokenFields(requestPayload) as Record<string, unknown>;
    const requestPayloadSha256 = await sha256Hex(JSON.stringify(idempotencyPayload));
    const existingReview = await getReviewRunByIdempotency(
      env.DB,
      session.workspaceId,
      idempotencyKey,
      requestPayloadSha256
    );
    if (existingReview) {
      const enqueueError = await enqueueReviewRunIfNeeded(env, existingReview, {
        reused: true,
        reviewGithubToken,
        openrouterApiKey,
      });
      if (enqueueError) {
        return enqueueError;
      }

      return jsonResponse(
        {
          reviewId: existingReview.id,
          sessionId: session.id,
          status: existingReview.status,
          eventsUrl: `/api/reviews/${existingReview.id}/events`,
          resultUrl: `/api/reviews/${existingReview.id}`,
          sessionUrl: `/api/review-sessions/${session.id}`,
        },
        200
      );
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

    const enqueueError = await enqueueReviewRunIfNeeded(env, created.review, {
      reused: created.reused,
      reviewGithubToken,
      openrouterApiKey,
    });
    if (enqueueError) {
      return enqueueError;
    }

    return jsonResponse(
      {
        reviewId: created.review.id,
        sessionId: session.id,
        status: created.review.status,
        eventsUrl: `/api/reviews/${created.review.id}/events`,
        resultUrl: `/api/reviews/${created.review.id}`,
        sessionUrl: `/api/review-sessions/${session.id}`,
      },
      202
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to create review session pass: ${message}` }, 500);
  }
}
