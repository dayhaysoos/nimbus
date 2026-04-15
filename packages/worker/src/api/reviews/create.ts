import type { AuthContext, Env } from '../../types.js';
import {
  attachReviewPassToSession,
  ReviewIdempotencyConflictError,
  appendReviewEvent,
  createReviewSession,
  createReviewRun,
  deleteReviewSession,
  generateReviewRunId,
  generateReviewSessionId,
  getReviewRunByIdempotency,
  getReviewSession,
  getWorkspace,
  getWorkspaceAccountId,
  getWorkspaceDeployment,
} from '../../lib/db.js';
import {
  isRecord,
  isSeverityThreshold,
  jsonResponse,
  readOpenrouterApiKeyHeader,
  readReviewGithubTokenHeader,
  requireWorkspaceAccess,
} from './shared.js';
import {
  buildReviewRequestPayload,
  normalizeBranchRef,
  normalizePolicyMode,
  normalizeRepoSlug,
  normalizeReviewBasis,
  sha256Hex,
  stripSensitiveTokenFields,
} from './request-shared.js';
import { enqueueReviewRunIfNeeded } from './queue.js';

export async function handleCreateReview(
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

    const idempotencyKey = (request.headers.get('Idempotency-Key') ?? '').trim();
    if (!idempotencyKey) {
      return jsonResponse({ error: 'Missing required Idempotency-Key header' }, 400);
    }
    if (effectiveAuthContext.isHostedMode && new URL(request.url).protocol !== 'https:') {
      return jsonResponse({ error: 'Hosted review requests must use HTTPS' }, 400);
    }
    const reviewGithubToken = readReviewGithubTokenHeader(request);
    const openrouterApiKey = readOpenrouterApiKeyHeader(request);

    const payloadRaw = await request.text();
    const payload = payloadRaw.trim() ? (JSON.parse(payloadRaw) as unknown) : {};
    if (!isRecord(payload)) {
      return jsonResponse({ error: 'Request body must be a JSON object' }, 400);
    }

    const target = isRecord(payload.target) ? payload.target : null;
    if (!target) {
      return jsonResponse({ error: 'target is required' }, 400);
    }

    const targetType = typeof target.type === 'string' ? target.type.trim() : '';
    if (targetType !== 'workspace_deployment') {
      return jsonResponse(
        {
          error: 'Unsupported review target',
          code: 'unsupported_review_target',
          allowedTargets: ['workspace_deployment'],
        },
        400
      );
    }

    const workspaceId = typeof target.workspaceId === 'string' ? target.workspaceId.trim() : '';
    const deploymentId = typeof target.deploymentId === 'string' ? target.deploymentId.trim() : '';
    if (!workspaceId || !deploymentId) {
      return jsonResponse({ error: 'target.workspaceId and target.deploymentId are required' }, 400);
    }

    const workspaceAccessResponse = await requireWorkspaceAccess(env, workspaceId, effectiveAuthContext);
    if (workspaceAccessResponse) {
      return workspaceAccessResponse;
    }

    const mode = typeof payload.mode === 'string' && payload.mode.trim() ? payload.mode.trim() : 'report_only';
    if (mode !== 'report_only') {
      return jsonResponse(
        {
          error: 'Unsupported review mode',
          code: 'unsupported_review_mode',
          allowedModes: ['report_only'],
        },
        400
      );
    }

    const policy = isRecord(payload.policy) ? payload.policy : {};
    const format = isRecord(payload.format) ? payload.format : {};
    const provenance = isRecord(payload.provenance) ? payload.provenance : {};
    const policyMode = normalizePolicyMode(payload.policyMode);
    const reviewBasis = normalizeReviewBasis(payload.reviewBasis);
    const rawPolicyMode = typeof payload.policyMode === 'string' ? payload.policyMode.trim() : payload.policyMode;
    const rawReviewBasis = typeof payload.reviewBasis === 'string' ? payload.reviewBasis.trim() : payload.reviewBasis;
    if (payload.policyMode !== undefined && policyMode !== rawPolicyMode) {
      return jsonResponse(
        {
          error: 'Invalid policyMode',
          code: 'invalid_review_policy_mode',
          allowedPolicyModes: ['none', 'auto', 'review'],
        },
        400
      );
    }
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
    if (payload.model !== undefined && (typeof payload.model !== 'string' || !payload.model.trim())) {
      return jsonResponse({ error: 'model must be a non-empty string when provided' }, 400);
    }
    const model = typeof payload.model === 'string' ? payload.model.trim() : undefined;
    const severityThresholdValue =
      typeof policy.severityThreshold === 'string' ? policy.severityThreshold.trim() : policy.severityThreshold;
    if (severityThresholdValue !== undefined && !isSeverityThreshold(severityThresholdValue)) {
      return jsonResponse(
        {
          error: 'Invalid policy.severityThreshold',
          code: 'invalid_review_policy',
          allowedSeverityThresholds: ['low', 'medium', 'high', 'critical'],
        },
        400
      );
    }
    const reviewRepo = normalizeRepoSlug(provenance.repo);
    const reviewBranch = normalizeBranchRef(provenance.branch);
    if (!reviewRepo || !reviewBranch) {
      return jsonResponse(
        {
          error: 'Missing required provenance.repo or provenance.branch',
          code: 'invalid_review_provenance',
        },
        400
      );
    }

    const { requestPayload, idempotencyPayload } = buildReviewRequestPayload({
      workspaceId,
      deploymentId,
      policyMode,
      reviewBasis,
      policy,
      format,
      provenance,
      repo: reviewRepo,
      branch: reviewBranch,
      model,
    });
    const sanitizedRequestPayload = stripSensitiveTokenFields(requestPayload) as Record<string, unknown>;

    const requestPayloadSha256 = await sha256Hex(JSON.stringify(idempotencyPayload));
    const existingReview = await getReviewRunByIdempotency(
      env.DB,
      workspaceId,
      idempotencyKey,
      requestPayloadSha256
    );
    if (existingReview) {
      const existingSession = existingReview.sessionId ? await getReviewSession(env.DB, existingReview.sessionId) : null;
      const created = { review: existingReview, reused: true };
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
          sessionId: existingSession?.id ?? created.review.sessionId,
          status: created.review.status,
          eventsUrl: `/api/reviews/${created.review.id}/events`,
          resultUrl: `/api/reviews/${created.review.id}`,
          ...(existingSession ? { sessionUrl: `/api/review-sessions/${existingSession.id}` } : {}),
        },
        200
      );
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace || workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const workspaceAccountId = await getWorkspaceAccountId(env.DB, workspaceId);
    if (workspaceAccountId === undefined) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
    if (!deployment) {
      return jsonResponse({ error: 'Deployment not found' }, 404);
    }
    if (deployment.status !== 'succeeded') {
      return jsonResponse(
        {
          error: 'Review target deployment must be succeeded',
          code: 'deployment_not_reviewable',
        },
        409
      );
    }

    const reviewSession = await createReviewSession(env.DB, {
      id: generateReviewSessionId(),
      workspaceId,
      anchorDeploymentId: deploymentId,
      repo: reviewRepo,
      branch: reviewBranch,
      initialReviewBasis: reviewBasis ?? 'checkpoint',
      anchorCommitSha: workspace.commitSha,
      anchorCheckpointId: workspace.checkpointId,
      sourceProjectRoot: workspace.sourceProjectRoot,
      accountId: workspaceAccountId,
    });

    let created: Awaited<ReturnType<typeof createReviewRun>>;
    try {
      created = await createReviewRun(env.DB, {
        id: generateReviewRunId(),
        workspaceId,
        deploymentId,
        sessionId: reviewSession.id,
        targetType: 'workspace_deployment',
        mode: 'report_only',
        idempotencyKey,
        requestPayload: sanitizedRequestPayload,
        requestPayloadSha256,
        accountId: workspaceAccountId,
        provenance: {
          promptSummary: `Review deployment ${deploymentId} for workspace ${workspaceId}`,
        },
        repo: reviewRepo,
        branch: reviewBranch,
      });
    } catch (error) {
      await deleteReviewSession(env.DB, reviewSession.id).catch(() => undefined);
      throw error;
    }

    let responseSessionId: string | null = reviewSession.id;
    if (created.reused) {
      await deleteReviewSession(env.DB, reviewSession.id).catch(() => undefined);
      responseSessionId = created.review.sessionId;
    } else {
      await attachReviewPassToSession(env.DB, reviewSession.id, created.review.id);
    }

    if (!created.reused) {
      await appendReviewEvent(env.DB, {
        reviewId: created.review.id,
        eventType: 'review_created',
        payload: {
          workspaceId,
          deploymentId,
          mode: 'report_only',
          policyMode,
          reviewBasis,
        },
      });
    }

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
        sessionId: responseSessionId,
        status: created.review.status,
        eventsUrl: `/api/reviews/${created.review.id}/events`,
        resultUrl: `/api/reviews/${created.review.id}`,
        ...(responseSessionId ? { sessionUrl: `/api/review-sessions/${encodeURIComponent(responseSessionId)}` } : {}),
      },
      created.reused ? 200 : 202
    );
  } catch (error) {
    if (error instanceof ReviewIdempotencyConflictError) {
      return jsonResponse(
        {
          error: 'Idempotency key has already been used with different payload',
          code: 'idempotency_key_conflict',
        },
        409
      );
    }

    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to create review: ${message}` }, 500);
  }
}
