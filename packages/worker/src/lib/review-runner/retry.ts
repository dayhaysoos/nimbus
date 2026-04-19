import type { Env, ReviewRunResponse } from '../../types.js';
import {
  appendReviewEvent,
  getReviewRun,
  replaceReviewFindings,
  updateReviewRunStatus,
} from '../db.js';
import { createReviewQueueMessage } from '../review-queue.js';

export class QueueRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueRetryError';
  }
}

const REVIEW_MAX_RETRIES = 2;
const DEFAULT_REVIEW_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
const REVIEW_STALE_GRACE_MS = 60 * 1000;

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

function toTimestampMs(value: string | null): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function transientReviewFailure(message: string): boolean {
  return /(d1|database is locked|sqlite_busy|temporarily unavailable|connection reset|timed out|timeout|aborted|fetch failed|network)/i.test(message);
}

async function enqueueScheduledReviewRetry(
  env: Env,
  reviewId: string,
  input?: {
    cochangeGithubToken?: string | null;
    providerApiKey?: string | null;
    openrouterApiKey?: string | null;
  }
): Promise<void> {
  if (!env.REVIEWS_QUEUE) {
    return;
  }
  await env.REVIEWS_QUEUE.send(
    createReviewQueueMessage(reviewId, input?.cochangeGithubToken, input?.providerApiKey, input?.openrouterApiKey)
  );
}

/**
 * Moves a review back to queued state with a retry marker and clears any partial persisted output.
 */
export async function scheduleReviewRetry(
  env: Env,
  reviewId: string,
  input: {
    attemptCount: number;
    message: string;
    reason: string;
    extraPayload?: Record<string, unknown>;
    throwMessage?: string;
    cochangeGithubToken?: string | null;
    providerApiKey?: string | null;
    openrouterApiKey?: string | null;
  }
): Promise<never> {
  await replaceReviewFindings(env.DB, reviewId, []);
  await updateReviewRunStatus(env.DB, reviewId, 'queued', {
    report: null,
    markdownSummary: null,
    startedAt: null,
    finishedAt: null,
    errorCode: 'retry_scheduled',
    errorMessage: input.message,
  });
  await appendReviewEvent(env.DB, {
    reviewId,
    eventType: 'review_retry_scheduled',
    payload: {
      attemptCount: input.attemptCount,
      maxRetries: REVIEW_MAX_RETRIES,
      reason: input.reason,
      ...(input.extraPayload ?? {}),
    },
  });
  await enqueueScheduledReviewRetry(env, reviewId, {
    cochangeGithubToken: input.cochangeGithubToken,
    providerApiKey: input.providerApiKey,
    openrouterApiKey: input.openrouterApiKey,
  });
  throw new QueueRetryError(input.throwMessage ?? 'Review retry requested');
}

/**
 * Schedules a retry only if the same running attempt is still current.
 * Returns false when another transition (for example manual fail) won the race.
 */
export async function scheduleReviewRetryIfCurrent(
  env: Env,
  reviewId: string,
  input: {
    attemptCount: number;
    message: string;
    reason: string;
    extraPayload?: Record<string, unknown>;
    throwMessage?: string;
    cochangeGithubToken?: string | null;
    providerApiKey?: string | null;
    openrouterApiKey?: string | null;
  }
): Promise<boolean> {
  const now = new Date().toISOString();
  const transitioned = await env.DB
    .prepare(
      `UPDATE review_runs SET status = ?,
           updated_at = ?,
           started_at = NULL,
           finished_at = NULL,
           report_json = NULL,
           markdown_summary = NULL,
           error_code = ?,
           error_message = ?
       WHERE id = ? AND status = 'running' AND attempt_count = ?`
    )
    .bind('queued', now, 'retry_scheduled', input.message, reviewId, input.attemptCount)
    .run();

  if ((transitioned.meta?.changes ?? 0) === 0) {
    return false;
  }

  await replaceReviewFindings(env.DB, reviewId, []);
  await appendReviewEvent(env.DB, {
    reviewId,
    eventType: 'review_retry_scheduled',
    payload: {
      attemptCount: input.attemptCount,
      maxRetries: REVIEW_MAX_RETRIES,
      reason: input.reason,
      ...(input.extraPayload ?? {}),
    },
  });
  await enqueueScheduledReviewRetry(env, reviewId, {
    cochangeGithubToken: input.cochangeGithubToken,
    providerApiKey: input.providerApiKey,
    openrouterApiKey: input.openrouterApiKey,
  });
  return true;
}

/**
 * Handles the case where a review could not be claimed because another worker may already be running it.
 * Detects stale-running reviews and either schedules a retry or marks them failed.
 */
export async function handleUnclaimedReviewRun(
  env: Env,
  reviewId: string,
  existing: ReviewRunResponse,
  allowRetryScheduling: boolean,
  options?: {
    cochangeGithubToken?: string | null;
    providerApiKey?: string | null;
    openrouterApiKey?: string | null;
  }
): Promise<void> {
  if (existing.status !== 'running') {
    return;
  }

  const attemptTimeoutMs = parseTimeoutMs(env.ATTEMPT_TIMEOUT_MS, DEFAULT_REVIEW_ATTEMPT_TIMEOUT_MS);
  const staleThresholdMs = attemptTimeoutMs + REVIEW_STALE_GRACE_MS;
  const startedAtMs = toTimestampMs(existing.startedAt) ?? toTimestampMs(existing.updatedAt) ?? toTimestampMs(existing.createdAt);
  const staleForMs = startedAtMs === null ? null : Date.now() - startedAtMs;
  const isStale = typeof staleForMs === 'number' && staleForMs >= staleThresholdMs;
  if (!isStale) {
    throw new QueueRetryError('Review run is already running; defer redelivery');
  }

  const staleForSeconds = Math.floor((staleForMs ?? 0) / 1000);
  const message = `Review execution stalled in running state for ${staleForSeconds}s (timeout threshold ${Math.floor(staleThresholdMs / 1000)}s).`;
  const attemptCount = existing.attemptCount ?? 0;
  if (allowRetryScheduling && attemptCount <= REVIEW_MAX_RETRIES) {
    await scheduleReviewRetry(env, reviewId, {
      attemptCount,
      message,
      reason: 'stale_running_timeout',
      extraPayload: { staleForSeconds },
      throwMessage: 'Review stale-running recovery requested',
      cochangeGithubToken: options?.cochangeGithubToken,
      providerApiKey: options?.providerApiKey,
      openrouterApiKey: options?.openrouterApiKey,
    });
  }

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
    },
  });
}

/**
 * Final fallback when repeated inline retries leave the review stuck in queued/retry-scheduled state.
 */
export async function finalizeInlineRetryExhaustion(env: Env, reviewId: string): Promise<void> {
  const latest = await getReviewRun(env.DB, reviewId);
  if (latest?.status === 'queued' && latest.error?.code === 'retry_scheduled') {
    const message = `Review ${reviewId} remained queued after inline retries`;
    await replaceReviewFindings(env.DB, reviewId, []);
    await updateReviewRunStatus(env.DB, reviewId, 'failed', {
      report: null,
      markdownSummary: null,
      errorCode: 'review_execution_failed',
      errorMessage: message,
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_failed',
      payload: {
        code: 'review_execution_failed',
        message,
      },
    });
  }
}

export function shouldRetryReviewError(error: unknown): boolean {
  if (error instanceof QueueRetryError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return transientReviewFailure(message);
}

export { enqueueScheduledReviewRetry };
