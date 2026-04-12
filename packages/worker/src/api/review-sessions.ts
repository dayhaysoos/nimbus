import type { AuthContext, Env } from '../types.js';
import { getReviewSession } from '../lib/db.js';
import { CreateReviewSessionPassError, createReviewSessionPass } from '../lib/review-session-pass.js';
import { normalizePolicyMode, normalizeReviewBasis } from './reviews/request-shared.js';
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

    const reviewGithubToken = readReviewGithubTokenHeader(request);
    const openrouterApiKey = readOpenrouterApiKeyHeader(request);
    const userProvenance = isRecord(payload.provenance) ? payload.provenance : {};
    const requestedIdempotencyKey = request.headers.get('Idempotency-Key');
    if (requestedIdempotencyKey !== null && !requestedIdempotencyKey.trim()) {
      return jsonResponse(
        {
          error: 'Missing required Idempotency-Key header',
          code: 'missing_idempotency_key',
        },
        400
      );
    }
    const created = await createReviewSessionPass(env, {
      session,
      reviewBasis,
      policyMode: 'none',
      policy: isRecord(payload.policy) ? payload.policy : {},
      format: isRecord(payload.format) ? payload.format : {},
      provenance: userProvenance,
      model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined,
      ...(requestedIdempotencyKey?.trim() ? { idempotencyKey: requestedIdempotencyKey.trim() } : {}),
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
      created.reused ? 200 : 202
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    if (error instanceof CreateReviewSessionPassError) {
      return jsonResponse(
        {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
        },
        error.status
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to create review session pass: ${message}` }, 500);
  }
}
