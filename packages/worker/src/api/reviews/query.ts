import type { AuthContext, Env, ReviewRunStatus } from '../../types.js';
import { getReviewRun, getReviewSession, listReviewEvents, listReviewRuns } from '../../lib/db.js';
import { createReviewEventsStream } from './events-stream.js';
import { normalizeBranchRef, normalizeRepoSlug } from './request-shared.js';
import { REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS, manuallyFailReviewRun, manuallyRecoverReviewRun, recoverStaleRunningReviewIfNeeded } from './recovery.js';
import {
  corsHeaders,
  jsonResponse,
  readOpenrouterApiKeyHeader,
  readReviewGithubTokenHeader,
  requireReviewAccess,
  resolveFromSequence,
} from './shared.js';

export async function handleGetReview(
  reviewId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const reviewAccessResponse = await requireReviewAccess(env, reviewId, effectiveAuthContext);
  if (reviewAccessResponse) {
    return reviewAccessResponse;
  }

  let review = await getReviewRun(env.DB, reviewId);
  if (!review) {
    return jsonResponse({ error: 'Review not found' }, 404);
  }

  await recoverStaleRunningReviewIfNeeded(
    env,
    reviewId,
    review,
    readReviewGithubTokenHeader(request),
    readOpenrouterApiKeyHeader(request),
    { markFailedWhenRetryUnavailable: false, noAuthTerminalGraceMs: REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS }
  );
  review = await getReviewRun(env.DB, reviewId);
  if (!review) {
    return jsonResponse({ error: 'Review not found' }, 404);
  }

  const session = review.sessionId ? await getReviewSession(env.DB, review.sessionId) : null;

  return jsonResponse({
    review,
    ...(session ? { session } : {}),
  });
}

export async function handleListReviews(
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);

  const url = new URL(request.url);
  const rawLimit = url.searchParams.get('limit');
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : Number.NaN;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 100;

  const rawRepo = url.searchParams.get('repo');
  const rawBranch = url.searchParams.get('branch');
  const repo = rawRepo === null ? undefined : normalizeRepoSlug(rawRepo);
  const branch = rawBranch === null ? undefined : normalizeBranchRef(rawBranch);

  if (rawRepo !== null && !repo) {
    return jsonResponse(
      {
        error: 'Invalid repo query parameter. Expected owner/repo.',
        code: 'invalid_review_query',
      },
      400
    );
  }
  if (rawBranch !== null && !branch) {
    return jsonResponse(
      {
        error: 'Invalid branch query parameter.',
        code: 'invalid_review_query',
      },
      400
    );
  }

  const accountId =
    effectiveAuthContext.isHostedMode && !effectiveAuthContext.isAdmin
      ? effectiveAuthContext.isAuthenticated && typeof effectiveAuthContext.accountId === 'string'
        ? effectiveAuthContext.accountId
        : '__no_account__'
      : undefined;

  if (accountId === '__no_account__') {
    return jsonResponse({ reviews: [] });
  }

  const reviews = await listReviewRuns(env.DB, {
    limit,
    accountId,
    repo,
    branch,
  });

  return jsonResponse({ reviews });
}

export async function handleGetReviewEvents(
  reviewId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  try {
    const reviewAccessResponse = await requireReviewAccess(env, reviewId, effectiveAuthContext);
    if (reviewAccessResponse) {
      return reviewAccessResponse;
    }

    const review = await getReviewRun(env.DB, reviewId);
    if (!review) {
      return jsonResponse({ error: 'Review not found' }, 404);
    }

    const fromSeq = resolveFromSequence(request);
    const stream = createReviewEventsStream(env, reviewId, request, review.status, fromSeq);

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}

export async function handleRecoverReview(
  reviewId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const reviewAccessResponse = await requireReviewAccess(env, reviewId, effectiveAuthContext);
  if (reviewAccessResponse) {
    return reviewAccessResponse;
  }

  try {
    const result = await manuallyRecoverReviewRun(
      env,
      reviewId,
      readReviewGithubTokenHeader(request),
      readOpenrouterApiKeyHeader(request)
    );
    if (!result.review) {
      return jsonResponse({ error: 'Review not found' }, 404);
    }
    return jsonResponse({
      action: result.action,
      review: result.review,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 409);
  }
}

export async function handleFailReview(
  reviewId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: false, isAuthenticated: false, isHostedMode: false } as const);
  const reviewAccessResponse = await requireReviewAccess(env, reviewId, effectiveAuthContext);
  if (reviewAccessResponse) {
    return reviewAccessResponse;
  }

  try {
    const result = await manuallyFailReviewRun(env, reviewId);
    if (!result.review) {
      return jsonResponse({ error: 'Review not found' }, 404);
    }
    return jsonResponse({
      action: result.action,
      review: result.review,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 409);
  }
}
