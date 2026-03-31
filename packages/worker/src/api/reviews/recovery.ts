import type { Env, ReviewRunStatus } from '../../types.js';
import {
  appendReviewEvent,
  getReviewRunRequestPayload,
  updateReviewRunStatus,
} from '../../lib/db.js';
import { createReviewQueueMessage } from '../../lib/review-queue.js';
import { jsonResponse } from './shared.js';

const REVIEW_STALE_RUNNING_GRACE_MS = 60_000;
export const REVIEW_STALE_NOAUTH_TERMINAL_GRACE_MS = 120_000;

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
