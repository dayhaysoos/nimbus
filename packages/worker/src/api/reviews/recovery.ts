import type { Env, ReviewRunStatus } from '../../types.js';
import {
  appendReviewEvent,
  getReviewRun,
  getReviewRunRequestPayload,
  replaceReviewFindings,
  updateReviewRunStatus,
} from '../../lib/db.js';
import { createReviewQueueMessage } from '../../lib/review-queue.js';
import { jsonResponse } from './shared.js';

const REVIEW_STALE_RUNNING_GRACE_MS = 60_000;
export const REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS = 120_000;
export const REVIEW_STALE_RETRY_SCHEDULED_GRACE_MS = 60_000;

function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseMaxRetryCount(value: string | undefined, fallbackAttempts: number): number {
  const parsedAttempts = Number.parseInt(value ?? '', 10);
  const attempts = Number.isFinite(parsedAttempts) && parsedAttempts > 0 ? parsedAttempts : fallbackAttempts;
  return Math.max(0, attempts - 1);
}

function hasLocalCochangeProvenance(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  const provenance = record.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return false;
  }
  const localCochange = (provenance as Record<string, unknown>).localCochange;
  if (!localCochange || typeof localCochange !== 'object' || Array.isArray(localCochange)) {
    return false;
  }
  const candidate = localCochange as Record<string, unknown>;
  if (candidate.source !== 'local_git') {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(candidate, 'relatedByChangedPath')) {
    return false;
  }
  const relatedByChangedPath = candidate.relatedByChangedPath;
  return Boolean(relatedByChangedPath !== null && typeof relatedByChangedPath === 'object' && !Array.isArray(relatedByChangedPath));
}

function isValidScopedGithubToken(value: string): boolean {
  const token = value.trim();
  if (!token) {
    return false;
  }
  return /^(ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token);
}

async function persistManualFailIfCurrent(input: {
  db: D1Database;
  reviewId: string;
  review: { status: ReviewRunStatus; attemptCount: number };
  message: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const sql = [
    'UPDATE review_runs SET status = ?, updated_at = ?, report_json = NULL, markdown_summary = NULL, error_code = ?, error_message = ?, finished_at = COALESCE(finished_at, ?)',
    'WHERE id = ? AND status = ?',
  ];
  const values: Array<string | number | null> = [
    'failed',
    now,
    'review_execution_aborted',
    input.message,
    now,
    input.reviewId,
    input.review.status,
  ];

  if (input.review.status === 'running') {
    sql.push('AND attempt_count = ?');
    values.push(input.review.attemptCount);
  }

  const result = await input.db.prepare(sql.join(' ')).bind(...values).run();
  return (result.meta?.changes ?? 0) > 0;
}

function parseReviewTimestampMs(review: { updatedAt: string; createdAt: string }): number | null {
  const parsed = Date.parse(review.updatedAt ?? review.createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function failStaleRetryScheduledReviewIfNeeded(
  env: Env,
  reviewId: string,
  review: { status: ReviewRunStatus; updatedAt: string; createdAt: string; error?: { code: string; message: string } | null }
): Promise<void> {
  if (review.status !== 'queued' || review.error?.code !== 'retry_scheduled') {
    return;
  }

  const updatedAtMs = parseReviewTimestampMs(review);
  if (updatedAtMs === null) {
    return;
  }

  const queuedForMs = Date.now() - updatedAtMs;
  if (queuedForMs < REVIEW_STALE_RETRY_SCHEDULED_GRACE_MS) {
    return;
  }

  const message = `Review recovery retry was scheduled but no worker claimed it within ${Math.floor(REVIEW_STALE_RETRY_SCHEDULED_GRACE_MS / 1000)}s.`;
  await replaceReviewFindings(env.DB, reviewId, []);
  await updateReviewRunStatus(env.DB, reviewId, 'failed', {
    report: null,
    markdownSummary: null,
    errorCode: 'review_execution_timeout',
    errorMessage: message,
  });
  await appendReviewEvent(env.DB, {
    reviewId,
    eventType: 'review_failed',
    payload: {
      code: 'review_execution_timeout',
      message,
      reason: 'retry_not_claimed',
    },
  });
}

export async function recoverStaleRunningReviewIfNeeded(
  env: Env,
  reviewId: string,
  review: { status: ReviewRunStatus; startedAt: string | null; updatedAt: string; createdAt: string; attemptCount: number },
  cochangeGithubToken?: string | null,
  openrouterApiKey?: string | null,
  options?: { markFailedWhenRetryUnavailable?: boolean; noAuthTerminalGraceMs?: number }
): Promise<void> {
  if (review.status !== 'running') {
    return;
  }
  const attemptTimeoutMs = parseTimeoutMs(env.ATTEMPT_TIMEOUT_MS, 600_000);
  const staleThresholdMs = attemptTimeoutMs + REVIEW_STALE_RUNNING_GRACE_MS;
  const startedMs = Date.parse(review.startedAt ?? review.updatedAt ?? review.createdAt);
  if (!Number.isFinite(startedMs)) {
    return;
  }
  const staleForMs = Date.now() - startedMs;
  if (staleForMs < staleThresholdMs) {
    return;
  }

  const maxRetries = parseMaxRetryCount(env.MAX_ATTEMPTS, 3);
  const requestPayload = await getReviewRunRequestPayload(env.DB, reviewId);
  const canRetryWithoutGithubToken = hasLocalCochangeProvenance(requestPayload);
  const rawScopedToken = typeof cochangeGithubToken === 'string' && cochangeGithubToken.trim() ? cochangeGithubToken.trim() : null;
  const scopedGithubToken = rawScopedToken && isValidScopedGithubToken(rawScopedToken) ? rawScopedToken : null;
  const hasInvalidScopedToken = Boolean(rawScopedToken) && !scopedGithubToken;
  if (review.attemptCount <= maxRetries && env.REVIEWS_QUEUE && (scopedGithubToken || canRetryWithoutGithubToken)) {
    await updateReviewRunStatus(env.DB, reviewId, 'queued', {
      report: null,
      markdownSummary: null,
      startedAt: null,
      finishedAt: null,
      errorCode: 'retry_scheduled',
      errorMessage: `Review execution stalled in running state for ${Math.floor(staleForMs / 1000)}s.`,
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_retry_scheduled',
      payload: {
        attemptCount: review.attemptCount,
        maxRetries,
        reason: 'stale_running_timeout',
        staleForSeconds: Math.floor(staleForMs / 1000),
        authMode: scopedGithubToken ? 'scoped_request_token' : 'local_cochange_only',
      },
    });
    await env.REVIEWS_QUEUE.send(createReviewQueueMessage(reviewId, scopedGithubToken, openrouterApiKey));
    return;
  }

  if (options?.markFailedWhenRetryUnavailable === false) {
    const noAuthTerminalGraceMs =
      typeof options.noAuthTerminalGraceMs === 'number' && options.noAuthTerminalGraceMs >= 0
        ? options.noAuthTerminalGraceMs
        : REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS;
    if (staleForMs < staleThresholdMs + noAuthTerminalGraceMs) {
      return;
    }
  }

  const missingTokenSuffix =
    !scopedGithubToken && !canRetryWithoutGithubToken
      ? ' No retry was scheduled because a fresh scoped GitHub token was not provided. Re-run review creation with X-Review-Github-Token (CLI: set REVIEW_CONTEXT_GITHUB_TOKEN).'
      : '';
  const invalidTokenSuffix = hasInvalidScopedToken
    ? ' No retry was scheduled because the provided scoped GitHub token format is invalid.'
    : '';
  const retriesExhaustedSuffix = review.attemptCount > maxRetries ? ' No retry was scheduled because max retry attempts were exhausted.' : '';
  const message = `Review execution timed out after ${Math.floor(staleForMs / 1000)}s in running state.${missingTokenSuffix}${invalidTokenSuffix}${retriesExhaustedSuffix}`;
  await updateReviewRunStatus(env.DB, reviewId, 'failed', {
    report: null,
    markdownSummary: null,
    errorCode: 'review_execution_timeout',
    errorMessage: message,
  });
  await appendReviewEvent(env.DB, {
    reviewId,
    eventType: 'review_failed',
    payload: {
      code: 'review_execution_timeout',
      message,
    },
  });
}

export async function validateRecoveredReviewRetryAuth(
  env: Env,
  reviewId: string,
  shouldReenqueueRecoveredReview: boolean,
  reviewGithubToken: string | null
): Promise<Response | null> {
  if (!shouldReenqueueRecoveredReview) {
    return null;
  }

  if (reviewGithubToken && !isValidScopedGithubToken(reviewGithubToken)) {
    return jsonResponse(
      {
        error: 'Scoped GitHub token format is invalid for retry. Expected ghp_* or github_pat_* token.',
        code: 'invalid_token_format',
      },
      409
    );
  }

  if (reviewGithubToken) {
    return null;
  }

  const storedRequestPayload = await getReviewRunRequestPayload(env.DB, reviewId);
  if (hasLocalCochangeProvenance(storedRequestPayload)) {
    return null;
  }

  return jsonResponse(
    {
      error:
        'Scoped GitHub token required for retry. Provide X-Review-Github-Token (CLI: set REVIEW_CONTEXT_GITHUB_TOKEN) when re-queueing recovered reviews without local co-change provenance.',
      code: 'review_context_github_token_missing',
    },
    409
  );
}

export async function manuallyRecoverReviewRun(
  env: Env,
  reviewId: string,
  reviewGithubToken: string | null,
  openrouterApiKey: string | null
): Promise<{ action: 'requeued' | 'failed'; review: Awaited<ReturnType<typeof getReviewRun>> }> {
  const review = await getReviewRun(env.DB, reviewId);
  if (!review) {
    return { action: 'failed', review: null };
  }

  if (review.status !== 'queued' && review.status !== 'running') {
    throw new Error(`Review is ${review.status}; only queued or running reviews can be recovered.`);
  }

  if (review.status === 'running') {
    throw new Error(
      'Review is running; manual recovery only supports queued reviews to avoid concurrent execution attempts.'
    );
  }

  const maxRetries = parseMaxRetryCount(env.MAX_ATTEMPTS, 3);
  const requestPayload = await getReviewRunRequestPayload(env.DB, reviewId);
  const canRetryWithoutGithubToken = hasLocalCochangeProvenance(requestPayload);
  const rawScopedToken = typeof reviewGithubToken === 'string' && reviewGithubToken.trim() ? reviewGithubToken.trim() : null;
  const scopedGithubToken = rawScopedToken && isValidScopedGithubToken(rawScopedToken) ? rawScopedToken : null;

  if (rawScopedToken && !scopedGithubToken) {
    throw new Error('Scoped GitHub token format is invalid for retry. Expected ghp_* or github_pat_* token.');
  }

  const canRequeue = review.attemptCount <= maxRetries && Boolean(env.REVIEWS_QUEUE) && (scopedGithubToken || canRetryWithoutGithubToken);

  if (canRequeue) {
    await replaceReviewFindings(env.DB, reviewId, []);
    const message = 'Manual recovery requested while review was queued.';
    await updateReviewRunStatus(env.DB, reviewId, 'queued', {
      report: null,
      markdownSummary: null,
      startedAt: null,
      finishedAt: null,
      errorCode: 'retry_scheduled',
      errorMessage: message,
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_retry_scheduled',
      payload: {
        attemptCount: review.attemptCount,
        maxRetries,
        reason: 'manual_recovery',
        priorStatus: review.status,
        authMode: scopedGithubToken ? 'scoped_request_token' : 'local_cochange_only',
      },
    });
    await env.REVIEWS_QUEUE?.send(createReviewQueueMessage(reviewId, scopedGithubToken, openrouterApiKey));
    return {
      action: 'requeued',
      review: await getReviewRun(env.DB, reviewId),
    };
  }

  const missingTokenSuffix =
    !scopedGithubToken && !canRetryWithoutGithubToken
      ? ' No retry was scheduled because a fresh scoped GitHub token was not provided.'
      : '';
  const retriesExhaustedSuffix = review.attemptCount > maxRetries ? ' No retry was scheduled because max retry attempts were exhausted.' : '';
  const message = `Manual recovery stopped this review after it appeared stuck in ${review.status} state.${missingTokenSuffix}${retriesExhaustedSuffix}`;
  await updateReviewRunStatus(env.DB, reviewId, 'failed', {
    report: null,
    markdownSummary: null,
    errorCode: 'review_execution_timeout',
    errorMessage: message,
  });
  await appendReviewEvent(env.DB, {
    reviewId,
    eventType: 'review_failed',
    payload: {
      code: 'review_execution_timeout',
      message,
      reason: 'manual_recovery',
    },
  });
  return {
    action: 'failed',
    review: await getReviewRun(env.DB, reviewId),
  };
}

export async function manuallyFailReviewRun(
  env: Env,
  reviewId: string
): Promise<{ action: 'failed' | 'unchanged'; review: Awaited<ReturnType<typeof getReviewRun>> }> {
  const review = await getReviewRun(env.DB, reviewId);
  if (!review) {
    return { action: 'unchanged', review: null };
  }

  if (review.status !== 'queued' && review.status !== 'running') {
    throw new Error(`Review is ${review.status}; only queued or running reviews can be failed manually.`);
  }

  const message =
    review.status === 'running'
      ? 'Review was manually marked failed while execution was still in progress. In-flight work may continue until the current attempt ends.'
      : 'Manual fail requested while review was queued.';

  const persisted = await persistManualFailIfCurrent({
    db: env.DB,
    reviewId,
    review: {
      status: review.status,
      attemptCount: review.attemptCount,
    },
    message,
  });
  if (persisted) {
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_failed',
      payload: {
        code: 'review_execution_aborted',
        message,
        reason: 'manual_fail',
        priorStatus: review.status,
      },
    });
  }

  return {
    action: persisted ? 'failed' : 'unchanged',
    review: await getReviewRun(env.DB, reviewId),
  };
}
