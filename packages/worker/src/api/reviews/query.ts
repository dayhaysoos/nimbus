import type { AuthContext, Env, ReviewRunStatus } from '../../types.js';
import { getReviewRun, listReviewEvents, listReviewRuns } from '../../lib/db.js';
import {
  REVIEW_STREAM_HEARTBEAT_INTERVAL_MS,
  REVIEW_STREAM_POLL_INTERVAL_MS,
  REVIEW_STREAM_STATUS_REFRESH_POLLS,
  REVIEW_TERMINAL_EVENT_GRACE_MS,
  corsHeaders,
  formatSseData,
  formatSseDataWithId,
  isRecord,
  isReviewStatusActive,
  jsonResponse,
  normalizeBranchRef,
  normalizeRepoSlug,
  readOpenrouterApiKeyHeader,
  readReviewGithubTokenHeader,
  requireReviewAccess,
  resolveFromSequence,
  sleep,
} from './shared.js';
import { REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS, recoverStaleRunningReviewIfNeeded } from './recovery.js';

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

  return jsonResponse({ review });
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
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          let cursor = fromSeq;
          let currentStatus = review.status;
          let lastHeartbeatAt = Date.now();
          let sawTerminalEvent = false;
          let terminalGraceDeadline: number | null = null;
          let pollCount = 0;

          const isTerminalEventType = (eventType: string): boolean => {
            return eventType === 'review_succeeded' || eventType === 'review_failed' || eventType === 'review_cancelled';
          };

          const statusFromTerminalEventType = (eventType: string): ReviewRunStatus | null => {
            if (eventType === 'review_succeeded') {
              return 'succeeded';
            }
            if (eventType === 'review_failed') {
              return 'failed';
            }
            if (eventType === 'review_cancelled') {
              return 'cancelled';
            }
            return null;
          };

          const write = (chunk: string): void => {
            controller.enqueue(encoder.encode(chunk));
          };

          const writePersistedEvents = async (): Promise<void> => {
            const persistedEvents = await listReviewEvents(env.DB, reviewId, cursor);
            for (const item of persistedEvents) {
              cursor = item.seq;
              if (isTerminalEventType(item.eventType)) {
                sawTerminalEvent = true;
                currentStatus = statusFromTerminalEventType(item.eventType) ?? currentStatus;
              }
              write(
                formatSseDataWithId(item.seq, {
                  type: item.eventType,
                  reviewId,
                  seq: item.seq,
                  createdAt: item.createdAt,
                  ...(isRecord(item.payload) ? item.payload : { value: item.payload }),
                })
              );
            }
          };

          await writePersistedEvents();
          write(
            formatSseData({
              type: 'snapshot',
              reviewId,
              status: currentStatus,
            })
          );

          while (isReviewStatusActive(currentStatus)) {
            await sleep(REVIEW_STREAM_POLL_INTERVAL_MS);
            pollCount += 1;
            await writePersistedEvents();

            if (pollCount % REVIEW_STREAM_STATUS_REFRESH_POLLS === 0) {
              const latest = await getReviewRun(env.DB, reviewId);
              if (!latest) {
                write(
                  formatSseData({
                    type: 'error',
                    reviewId,
                    message: 'Review not found during event stream',
                  })
                );
                break;
              }
              await recoverStaleRunningReviewIfNeeded(
                env,
                reviewId,
                latest,
                readReviewGithubTokenHeader(request),
                readOpenrouterApiKeyHeader(request),
                { markFailedWhenRetryUnavailable: false, noAuthTerminalGraceMs: REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS }
              );
              const refreshed = await getReviewRun(env.DB, reviewId);
              currentStatus = refreshed?.status ?? latest.status;
            }

            if (!isReviewStatusActive(currentStatus) && terminalGraceDeadline === null) {
              terminalGraceDeadline = Date.now() + REVIEW_TERMINAL_EVENT_GRACE_MS;
            }
            if (!isReviewStatusActive(currentStatus) && sawTerminalEvent) {
              break;
            }
            if (terminalGraceDeadline !== null && Date.now() >= terminalGraceDeadline) {
              break;
            }
            if (Date.now() - lastHeartbeatAt >= REVIEW_STREAM_HEARTBEAT_INTERVAL_MS) {
              write(
                formatSseData({
                  type: 'heartbeat',
                  reviewId,
                  status: currentStatus,
                })
              );
              lastHeartbeatAt = Date.now();
            }
          }

          const terminal = await getReviewRun(env.DB, reviewId);
          if (terminal) {
            await writePersistedEvents();
            write(
              formatSseData({
                type: 'terminal',
                reviewId,
                status: terminal.status,
              })
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          controller.enqueue(
            encoder.encode(
              formatSseData({
                type: 'error',
                reviewId,
                message,
              })
            )
          );
        }
        controller.close();
      },
    });

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
