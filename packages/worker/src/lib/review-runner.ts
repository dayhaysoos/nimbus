import type { Env, ReviewReport, ReviewRunResponse } from '../types.js';
import {
  appendReviewEvent,
  claimReviewRunForExecution,
  getHighestFindingNumberForBranch,
  getReviewRun,
  getReviewRunRequestPayload,
  replaceReviewFindings,
  updateReviewRunStatus,
} from './db.js';
import { formatReviewAnalysisError } from './review-analysis.js';
import { ReviewContextAssemblyError } from './review-runner/cochange.js';
import { readOptionalString } from './review-runner/context-helpers.js';
import { assembleReviewContextBootstrap } from './review-runner/context.js';
import { executeReviewRun } from './review-runner/execution.js';
import { intentSummaryFromApprovedPolicy, runIntentSummarizationPrePass, summarizeReviewIntentPolicy } from './review-runner/intent-summary.js';
import type { ReviewRunExecutionOptions } from './review-runner/shared.js';

export {
  intentSummaryFromApprovedPolicy,
  runIntentSummarizationPrePass,
  summarizeReviewIntentPolicy,
} from './review-runner/intent-summary.js';

class QueueRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueRetryError';
  }
}

const REVIEW_MAX_RETRIES = 2;
const DEFAULT_REVIEW_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
const REVIEW_STALE_GRACE_MS = 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

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

function transientReviewFailure(message: string): boolean {
  return /(d1|database is locked|sqlite_busy|temporarily unavailable|connection reset|timed out|timeout|aborted|fetch failed|network)/i.test(message);
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
      const attemptTimeoutMs = parseTimeoutMs(env.ATTEMPT_TIMEOUT_MS, DEFAULT_REVIEW_ATTEMPT_TIMEOUT_MS);
      const staleThresholdMs = attemptTimeoutMs + REVIEW_STALE_GRACE_MS;
      const startedAtMs = toTimestampMs(existing.startedAt) ?? toTimestampMs(existing.updatedAt) ?? toTimestampMs(existing.createdAt);
      const staleForMs = startedAtMs === null ? null : Date.now() - startedAtMs;
      const isStale = typeof staleForMs === 'number' && staleForMs >= staleThresholdMs;
      if (isStale) {
        const staleForSeconds = Math.floor(staleForMs / 1000);
        const message = `Review execution stalled in running state for ${staleForSeconds}s (timeout threshold ${Math.floor(staleThresholdMs / 1000)}s).`;
        const attemptCount = existing.attemptCount ?? 0;
        if ((options?.allowRetryScheduling ?? true) && attemptCount <= REVIEW_MAX_RETRIES) {
          await replaceReviewFindings(env.DB, reviewId, []);
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
              attemptCount,
              maxRetries: REVIEW_MAX_RETRIES,
              reason: 'stale_running_timeout',
              staleForSeconds,
            },
          });
          throw new QueueRetryError('Review stale-running recovery requested');
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
        return;
      }
      throw new QueueRetryError('Review run is already running; defer redelivery');
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
    const payloadRecord = asRecord(payload);
    const requestProvenance = asRecord(payloadRecord.provenance);
    const reviewRepo = readOptionalString(requestProvenance.repo);
    const reviewBranch = readOptionalString(requestProvenance.branch);
    if (!reviewRepo || !reviewBranch) {
      throw new Error('Review request payload missing required provenance.repo or provenance.branch.');
    }

    const findingSequenceStart = (await getHighestFindingNumberForBranch(env.DB, reviewRepo, reviewBranch)) + 1;
    const findingsWithSequence = report.findings.map((finding, index) => ({
      ...finding,
      sequence: findingSequenceStart + index,
    }));
    const reportWithSequence: ReviewReport = {
      ...report,
      findings: findingsWithSequence,
    };

    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_finalize_started',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await replaceReviewFindings(env.DB, reviewId, findingsWithSequence, { startNumber: findingSequenceStart });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_analysis_findings_persisted',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await updateReviewRunStatus(env.DB, reviewId, 'succeeded', {
      report: reportWithSequence,
      markdownSummary: reportWithSequence.markdownSummary,
      errorCode: null,
      errorMessage: null,
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_analysis_succeeded',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_succeeded',
      payload: {
        recommendation: report.summary.recommendation,
        findingCount: report.findings.length,
      },
    });
  } catch (error) {
    const message = formatReviewAnalysisError(error, {
      openrouterApiKey: readOptionalString(options?.openrouterApiKey),
    });
    const latest = await getReviewRun(env.DB, reviewId);
    const attemptCount = latest?.attemptCount ?? review?.attemptCount ?? 0;

    const allowRetryScheduling = options?.allowRetryScheduling !== false;
    if (allowRetryScheduling && (error instanceof QueueRetryError || transientReviewFailure(message)) && attemptCount <= REVIEW_MAX_RETRIES) {
      await replaceReviewFindings(env.DB, reviewId, []);
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
          attemptCount,
          maxRetries: REVIEW_MAX_RETRIES,
          reason: message.slice(0, 500),
        },
      });
      throw new QueueRetryError('Review transient failure; retry requested');
    }

    const contextAssemblyErrorCode = error instanceof ReviewContextAssemblyError ? error.code : null;
    const finalErrorCode = contextAssemblyErrorCode ?? 'review_execution_failed';
    await updateReviewRunStatus(env.DB, reviewId, 'failed', {
      errorCode: finalErrorCode,
      errorMessage: message,
    });
    try {
      if (contextAssemblyErrorCode) {
        await appendReviewEvent(env.DB, {
          reviewId,
          eventType: 'review_context_assembly_failed',
          payload: {
            code: contextAssemblyErrorCode,
            message,
          },
        });
      }
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_failed',
        payload: {
          code: finalErrorCode,
          message,
        },
      });
    } catch {
      // Best-effort terminal event.
    }
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
