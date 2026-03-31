import type { Env, ReviewReport, ReviewRunResponse } from '../types.js';
import {
  appendReviewEvent,
  claimReviewRunForExecution,
  getReviewRun,
  getReviewRunRequestPayload,
  updateReviewRunStatus,
} from './db.js';
import { formatReviewAnalysisError } from './review-analysis.js';
import { ReviewContextAssemblyError } from './review-runner/cochange.js';
import { readOptionalString } from './review-runner/context-helpers.js';
import { assembleReviewContextBootstrap } from './review-runner/context.js';
import { executeReviewRun } from './review-runner/execution.js';
import { finalizeFailedReview, finalizeSuccessfulReview } from './review-runner/finalization.js';
import { intentSummaryFromApprovedPolicy, runIntentSummarizationPrePass, summarizeReviewIntentPolicy } from './review-runner/intent-summary.js';
import {
  finalizeInlineRetryExhaustion,
  handleUnclaimedReviewRun,
  QueueRetryError,
  scheduleReviewRetry,
  shouldRetryReviewError,
} from './review-runner/retry.js';
import type { ReviewRunExecutionOptions } from './review-runner/shared.js';

export {
  intentSummaryFromApprovedPolicy,
  runIntentSummarizationPrePass,
  summarizeReviewIntentPolicy,
} from './review-runner/intent-summary.js';
export { shouldRetryReviewError } from './review-runner/retry.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Claims, executes, persists, and finalizes one review run.
 * This is the main orchestration boundary for review execution and retry scheduling.
 */
export async function processReviewRun(env: Env, reviewId: string, options?: ReviewRunExecutionOptions): Promise<void> {
  const claimed = await claimReviewRunForExecution(env.DB, reviewId);
  if (!claimed) {
    const existing = await getReviewRun(env.DB, reviewId);
    if (existing?.status === 'running') {
      await handleUnclaimedReviewRun(env, reviewId, existing, options?.allowRetryScheduling ?? true);
    }
    return;
  }

  let review: ReviewRunResponse | null = null;
  try {
    review = await getReviewRun(env.DB, reviewId);
    if (!review) {
      return;
    }

    const payload = await getReviewRunRequestPayload(env.DB, reviewId);
    if (!payload) {
      await updateReviewRunStatus(env.DB, reviewId, 'failed', {
        errorCode: 'review_not_found',
        errorMessage: 'Review request payload no longer exists',
      });
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_failed',
        payload: {
          code: 'review_not_found',
          message: 'Review request payload no longer exists',
        },
      });
      return;
    }

    const reviewContext = await assembleReviewContextBootstrap(env, review, payload, options);
    const report = await executeReviewRun(env, review, payload, reviewContext, options);
    await finalizeSuccessfulReview(env, reviewId, payload, report);
  } catch (error) {
    const message = formatReviewAnalysisError(error, {
      openrouterApiKey: readOptionalString(options?.openrouterApiKey),
    });
    const latest = await getReviewRun(env.DB, reviewId);
    const attemptCount = latest?.attemptCount ?? review?.attemptCount ?? 0;

    const allowRetryScheduling = options?.allowRetryScheduling !== false;
    if (allowRetryScheduling && shouldRetryReviewError(error) && attemptCount <= 2) {
      await scheduleReviewRetry(env, reviewId, {
        attemptCount,
        message,
        reason: message.slice(0, 500),
        throwMessage: 'Review transient failure; retry requested',
      });
    }

    const contextAssemblyErrorCode = error instanceof ReviewContextAssemblyError ? error.code : null;
    const finalErrorCode = contextAssemblyErrorCode ?? 'review_execution_failed';
    await finalizeFailedReview(env, reviewId, {
      errorCode: finalErrorCode,
      message,
      contextAssemblyErrorCode,
    });
  }
}

/**
 * Repeats inline review execution while the persisted state requests another retry cycle.
 */
export async function runReviewInlineWithRetries(
  env: Env,
  reviewId: string,
  maxCycles = 4,
  options?: ReviewRunExecutionOptions
): Promise<void> {
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    try {
      await processReviewRun(env, reviewId, options);
    } catch {
      // Retry scheduling is inferred from persisted status.
    }

    const latest = await getReviewRun(env.DB, reviewId);
    if (!latest) {
      return;
    }
    if (latest.status !== 'queued') {
      return;
    }
    if (latest.error?.code !== 'retry_scheduled') {
      return;
    }
  }

  await finalizeInlineRetryExhaustion(env, reviewId);
}
