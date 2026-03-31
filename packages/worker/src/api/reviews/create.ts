import type { AuthContext, Env } from '../../types.js';
import {
  ReviewIdempotencyConflictError,
  appendReviewEvent,
  createReviewRun,
  generateReviewRunId,
  getReviewRunByIdempotency,
  getWorkspace,
  getWorkspaceAccountId,
  getWorkspaceDeployment,
  hasReviewEvent,
} from '../../lib/db.js';
import { createReviewQueueMessage } from '../../lib/review-queue.js';
import {
  buildReviewRequestPayload,
  isRecord,
  isSeverityThreshold,
  jsonResponse,
  normalizeBranchRef,
  normalizeRepoSlug,
  readOpenrouterApiKeyHeader,
  readReviewGithubTokenHeader,
  requireWorkspaceAccess,
  sha256Hex,
  stripSensitiveTokenFields,
} from './shared.js';
import { validateRecoveredReviewRetryAuth } from './recovery.js';

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
      const created = { review: existingReview, reused: true };

      if (created.review.status === 'queued') {
        const alreadyEnqueued = await hasReviewEvent(env.DB, created.review.id, 'review_enqueued');
        const shouldReenqueueRecoveredReview =
          created.reused && (created.review.error?.code === 'retry_scheduled' || created.review.attemptCount > 0);
        const requiresOpenrouterRetryKey = created.review.error?.code === 'missing_openrouter_api_key';
        if (!alreadyEnqueued || shouldReenqueueRecoveredReview) {
          const authRetryError = await validateRecoveredReviewRetryAuth(
            env,
            created.review.id,
            shouldReenqueueRecoveredReview,
            reviewGithubToken
          );
          if (authRetryError) {
            return authRetryError;
          }
          if (shouldReenqueueRecoveredReview && requiresOpenrouterRetryKey && !openrouterApiKey) {
            return jsonResponse(
              {
                error: 'OpenRouter API key required for retry',
                code: 'missing_openrouter_api_key',
              },
              409
            );
          }
          await env.REVIEWS_QUEUE.send(createReviewQueueMessage(created.review.id, reviewGithubToken, openrouterApiKey));

          await appendReviewEvent(env.DB, {
            reviewId: created.review.id,
            eventType: 'review_enqueued',
            payload: {
              mode: 'queue',
              reused: created.reused,
              recovered: shouldReenqueueRecoveredReview,
            },
          });
        }
      }

      return jsonResponse(
        {
          reviewId: created.review.id,
          status: created.review.status,
          eventsUrl: `/api/reviews/${created.review.id}/events`,
          resultUrl: `/api/reviews/${created.review.id}`,
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

    const created = await createReviewRun(env.DB, {
      id: generateReviewRunId(),
      workspaceId,
      deploymentId,
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

    if (!created.reused) {
      await appendReviewEvent(env.DB, {
        reviewId: created.review.id,
        eventType: 'review_created',
        payload: {
          workspaceId,
          deploymentId,
          mode: 'report_only',
        },
      });
    }

    if (created.review.status === 'queued') {
      const alreadyEnqueued = await hasReviewEvent(env.DB, created.review.id, 'review_enqueued');
      const shouldReenqueueRecoveredReview =
        created.reused && (created.review.error?.code === 'retry_scheduled' || created.review.attemptCount > 0);
      const requiresOpenrouterRetryKey = created.review.error?.code === 'missing_openrouter_api_key';
      if (!alreadyEnqueued || shouldReenqueueRecoveredReview) {
        const authRetryError = await validateRecoveredReviewRetryAuth(
          env,
          created.review.id,
          shouldReenqueueRecoveredReview,
          reviewGithubToken
        );
        if (authRetryError) {
          return authRetryError;
        }
        if (shouldReenqueueRecoveredReview && requiresOpenrouterRetryKey && !openrouterApiKey) {
          return jsonResponse(
            {
              error: 'OpenRouter API key required for retry',
              code: 'missing_openrouter_api_key',
            },
            409
          );
        }
        await env.REVIEWS_QUEUE.send(createReviewQueueMessage(created.review.id, reviewGithubToken, openrouterApiKey));

        await appendReviewEvent(env.DB, {
          reviewId: created.review.id,
          eventType: 'review_enqueued',
          payload: {
            mode: 'queue',
            reused: created.reused,
            recovered: shouldReenqueueRecoveredReview,
          },
        });
      }
    }

    return jsonResponse(
      {
        reviewId: created.review.id,
        status: created.review.status,
        eventsUrl: `/api/reviews/${created.review.id}/events`,
        resultUrl: `/api/reviews/${created.review.id}`,
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
