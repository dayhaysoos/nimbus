import type { Env, ReviewReport, ReviewRunResponse } from '../../types.js';
import {
  appendReviewEvent,
  getHighestFindingNumberForBranch,
  replaceReviewFindings,
  updateReviewRunStatus,
} from '../db.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Persists successful review output, assigns branch-stable finding numbers, and emits completion events.
 */
export async function finalizeSuccessfulReview(
  env: Env,
  reviewId: string,
  payload: Record<string, unknown>,
  report: ReviewReport
): Promise<void> {
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
}

/**
 * Persists a terminal failed state and emits failure events, including context-assembly failures when applicable.
 */
export async function finalizeFailedReview(
  env: Env,
  reviewId: string,
  input: {
    errorCode: string;
    message: string;
    contextAssemblyErrorCode?: string | null;
  }
): Promise<void> {
  await updateReviewRunStatus(env.DB, reviewId, 'failed', {
    errorCode: input.errorCode,
    errorMessage: input.message,
  });
  try {
    if (input.contextAssemblyErrorCode) {
      await appendReviewEvent(env.DB, {
        reviewId,
        eventType: 'review_context_assembly_failed',
        payload: {
          code: input.contextAssemblyErrorCode,
          message: input.message,
        },
      });
    }
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_failed',
      payload: {
        code: input.errorCode,
        message: input.message,
      },
    });
  } catch {
    // Best-effort terminal event.
  }
}
