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
import { finalizeFailedReviewIfCurrent, finalizeSuccessfulReview } from './review-runner/finalization.js';
import { intentSummaryFromApprovedPolicy, runIntentSummarizationPrePass, summarizeReviewIntentPolicy } from './review-runner/intent-summary.js';
import {
  finalizeInlineRetryExhaustion,
  handleUnclaimedReviewRun,
  QueueRetryError,
  scheduleReviewRetryIfCurrent,
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

function isManuallyFailedReview(review: ReviewRunResponse | null): boolean {
  return review?.status === 'failed' && review.error?.code === 'review_execution_aborted';
}

async function loadLatestReviewUnlessManuallyFailed(env: Env, reviewId: string): Promise<ReviewRunResponse | null> {
  const latest = await getReviewRun(env.DB, reviewId);
  return isManuallyFailedReview(latest) ? null : latest;
}

function startManualFailAbortMonitor(env: Env, reviewId: string): { signal: AbortSignal; stop: () => void } {
  const controller = new AbortController();
  let stopped = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped || polling || controller.signal.aborted) {
      return;
    }
    polling = true;
    try {
      const latest = await getReviewRun(env.DB, reviewId);
      if (isManuallyFailedReview(latest)) {
        controller.abort();
        stop();
      }
    } catch {
      // Best-effort polling only; transient read failures must not become unhandled rejections.
    } finally {
      polling = false;
    }
  };

  timer = setInterval(() => {
    void poll();
  }, 250);
  void poll();

  return { signal: controller.signal, stop };
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
  const manualFailAbortMonitor = startManualFailAbortMonitor(env, reviewId);
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
    const latestBeforeExecution = await loadLatestReviewUnlessManuallyFailed(env, reviewId);
    if (!latestBeforeExecution) {
      return;
    }
    const report = await executeReviewRun(env, review, payload, reviewContext, {
      ...options,
      abortSignal: manualFailAbortMonitor.signal,
    });
    const latest = await loadLatestReviewUnlessManuallyFailed(env, reviewId);
    if (!latest) {
      return;
    }
    await finalizeSuccessfulReview(env, reviewId, payload, report, {
      expectedAttemptCount: review.attemptCount,
      allowRetryScheduling: options?.allowRetryScheduling,
    });
  } catch (error) {
    const message = formatReviewAnalysisError(error, {
      openrouterApiKey: readOptionalString(options?.openrouterApiKey),
    });
    const latest = await loadLatestReviewUnlessManuallyFailed(env, reviewId);
    if (!latest) {
      return;
    }
    const attemptCount = review?.attemptCount ?? latest?.attemptCount ?? 0;

    const allowRetryScheduling = options?.allowRetryScheduling !== false;
    if (allowRetryScheduling && shouldRetryReviewError(error) && attemptCount <= 2) {
      const retryScheduled = await scheduleReviewRetryIfCurrent(env, reviewId, {
        attemptCount,
        message,
        reason: message.slice(0, 500),
      });
      if (retryScheduled) {
        throw new QueueRetryError('Review transient failure; retry requested');
      }
    }

    const contextAssemblyErrorCode = error instanceof ReviewContextAssemblyError ? error.code : null;
    const finalErrorCode = contextAssemblyErrorCode ?? 'review_execution_failed';
    await finalizeFailedReviewIfCurrent(env, reviewId, {
      errorCode: finalErrorCode,
      message,
      contextAssemblyErrorCode,
      expectedAttemptCount: attemptCount,
    });
  } finally {
    manualFailAbortMonitor.stop();
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
