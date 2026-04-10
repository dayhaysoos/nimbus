import type { Env, ReviewFinding, ReviewReport, ReviewRunResponse } from '../../types.js';
import {
  appendReviewEvent,
  getReviewRun,
  getHighestFindingNumberForBranch,
  replaceReviewFindings,
  updateReviewRunStatus,
} from '../db.js';
import { stripSensitiveTokenFields } from '../db/reviews/shared.js';
import { scheduleReviewRetryIfCurrent, transientReviewFailure } from './retry.js';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canFinalizeSuccessfulReview(review: ReviewRunResponse | null): boolean {
  return review?.status === 'running';
}

async function persistSuccessfulReviewStatusIfCurrent(input: {
  db: D1Database;
  reviewId: string;
  report: ReviewReport;
  startedAt?: string | null;
  expectedAttemptCount?: number;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const sql = [
    'UPDATE review_runs SET status = ?, updated_at = ?, started_at = COALESCE(started_at, ?), report_json = ?, markdown_summary = ?, error_code = NULL, error_message = NULL, finished_at = COALESCE(finished_at, ?)',
    "WHERE id = ? AND status = 'running'",
  ];
  const values: Array<string | number | null> = [
    'succeeded',
    now,
    input.startedAt ?? now,
    JSON.stringify(stripSensitiveTokenFields(input.report)),
    typeof input.report.markdownSummary === 'string'
      ? (stripSensitiveTokenFields(input.report.markdownSummary) as string)
      : input.report.markdownSummary,
    now,
    input.reviewId,
  ];

  if (typeof input.expectedAttemptCount === 'number') {
    sql.push(' AND attempt_count = ?');
    values.push(input.expectedAttemptCount);
  }

  const result = await input.db.prepare(sql.join(' ')).bind(...values).run();
  return (result.meta?.changes ?? 0) > 0;
}

async function finalizeSuccessfulReviewPersistenceFailure(input: {
  env: Env;
  reviewId: string;
  message: string;
  expectedAttemptCount?: number;
  allowRetryScheduling?: boolean;
  phase?: 'running' | 'succeeded';
}): Promise<void> {
  if (
    input.allowRetryScheduling !== false &&
    transientReviewFailure(input.message) &&
    typeof input.expectedAttemptCount === 'number'
  ) {
    if (input.phase === 'running') {
      const scheduled = await scheduleReviewRetryIfCurrent(input.env, input.reviewId, {
        attemptCount: input.expectedAttemptCount,
        message: input.message,
        reason: 'success_persistence_retry',
      });
      if (scheduled) {
        return;
      }
    }

    const transitioned = await input.env.DB
      .prepare(
        `UPDATE review_runs SET status = ?,
             updated_at = ?,
             started_at = NULL,
             finished_at = NULL,
             report_json = NULL,
             markdown_summary = NULL,
             error_code = ?,
             error_message = ?
         WHERE id = ? AND status = 'succeeded' AND attempt_count = ?`
      )
      .bind(
        'queued',
        new Date().toISOString(),
        'retry_scheduled',
        input.message,
        input.reviewId,
        input.expectedAttemptCount
      )
      .run();

    if ((transitioned.meta?.changes ?? 0) > 0) {
      await replaceReviewFindings(input.env.DB, input.reviewId, []);
      try {
        await appendReviewEvent(input.env.DB, {
          reviewId: input.reviewId,
          eventType: 'review_retry_scheduled',
          payload: {
            attemptCount: input.expectedAttemptCount,
            maxRetries: 2,
            reason: 'success_persistence_retry',
          },
        });
      } catch {
        // Best-effort retry event only.
      }
      return;
    }
  }

  if (input.phase === 'running' && typeof input.expectedAttemptCount === 'number') {
    const finalized = await finalizeFailedReviewIfCurrent(input.env, input.reviewId, {
      errorCode: 'review_execution_failed',
      message: input.message,
      expectedAttemptCount: input.expectedAttemptCount,
    });
    if (finalized) {
      await replaceReviewFindings(input.env.DB, input.reviewId, []);
    }
    return;
  }

  await replaceReviewFindings(input.env.DB, input.reviewId, []);
  await updateReviewRunStatus(input.env.DB, input.reviewId, 'failed', {
    report: null,
    markdownSummary: null,
    errorCode: 'review_execution_failed',
    errorMessage: input.message,
  });
  try {
    await appendReviewEvent(input.env.DB, {
      reviewId: input.reviewId,
      eventType: 'review_failed',
      payload: {
        code: 'review_execution_failed',
        message: input.message,
      },
    });
  } catch {
    // Best-effort terminal event only.
  }
}

async function clearReviewFindingsIfNotSucceeded(db: D1Database, reviewId: string): Promise<void> {
  const latest = await getReviewRun(db, reviewId);
  if (!latest || latest.status === 'succeeded') {
    return;
  }
  await replaceReviewFindings(db, reviewId, []);
}

async function replaceReviewFindingsIfCurrent(input: {
  db: D1Database;
  reviewId: string;
  findings: ReviewFinding[];
  startNumber: number;
  expectedAttemptCount?: number;
}): Promise<void> {
  if (typeof input.expectedAttemptCount !== 'number') {
    await replaceReviewFindings(input.db, input.reviewId, input.findings, { startNumber: input.startNumber });
    return;
  }

  await input.db
    .prepare(
      `DELETE FROM review_findings
       WHERE review_id = ?
         AND EXISTS (
           SELECT 1
           FROM review_runs
           WHERE id = ? AND status = 'running' AND attempt_count = ?
         )`
    )
    .bind(input.reviewId, input.reviewId, input.expectedAttemptCount)
    .run();

  for (const [index, finding] of input.findings.entries()) {
    const findingNumber = input.startNumber + index;
    const findingId = `${input.reviewId}_F-${String(findingNumber).padStart(3, '0')}`;
    await input.db
      .prepare(
        `INSERT INTO review_findings (id, review_id, severity, category, pass_type, description, locations_json, suggested_fix)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1
           FROM review_runs
           WHERE id = ? AND status = 'running' AND attempt_count = ?
         )`
      )
      .bind(
        findingId,
        input.reviewId,
        finding.severity,
        finding.category,
        finding.passType,
        finding.description,
        JSON.stringify(finding.locations),
        finding.suggestedFix,
        input.reviewId,
        input.expectedAttemptCount
      )
      .run();
  }
}

/**
 * Persists successful review output, assigns branch-stable finding numbers, and emits completion events.
 */
export async function finalizeSuccessfulReview(
  env: Env,
  reviewId: string,
  payload: Record<string, unknown>,
  report: ReviewReport,
  options?: {
    expectedAttemptCount?: number;
    allowRetryScheduling?: boolean;
  }
): Promise<void> {
  const latest = await getReviewRun(env.DB, reviewId);
  if (!latest || !canFinalizeSuccessfulReview(latest)) {
    return;
  }
  if (typeof options?.expectedAttemptCount === 'number' && latest.attemptCount !== options.expectedAttemptCount) {
    return;
  }

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

  try {
    await replaceReviewFindingsIfCurrent({
      db: env.DB,
      reviewId,
      findings: findingsWithSequence,
      startNumber: findingSequenceStart,
      expectedAttemptCount: options?.expectedAttemptCount,
    });
    const persisted = await persistSuccessfulReviewStatusIfCurrent({
      db: env.DB,
      reviewId,
      report: reportWithSequence,
      startedAt: latest.startedAt,
      expectedAttemptCount: options?.expectedAttemptCount,
    });
    if (!persisted) {
      await clearReviewFindingsIfNotSucceeded(env.DB, reviewId);
      return;
    }
  } catch (error) {
    await finalizeSuccessfulReviewPersistenceFailure({
      env,
      reviewId,
      message: error instanceof Error ? error.message : String(error),
      expectedAttemptCount: options?.expectedAttemptCount,
      allowRetryScheduling: options?.allowRetryScheduling,
      phase: 'running',
    });
    return;
  }

  try {
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_finalize_started',
      payload: {
        findingCount: report.findings.length,
      },
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_analysis_findings_persisted',
      payload: {
        findingCount: report.findings.length,
      },
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
    // Best-effort lifecycle telemetry only. The review is already durably succeeded.
  }
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

/**
 * Persists a failed terminal state only if the same running attempt is still current.
 * Returns false when another transition (for example manual fail) won the race.
 */
export async function finalizeFailedReviewIfCurrent(
  env: Env,
  reviewId: string,
  input: {
    errorCode: string;
    message: string;
    contextAssemblyErrorCode?: string | null;
    expectedAttemptCount: number;
  }
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DB
    .prepare(
      `UPDATE review_runs SET status = ?,
           updated_at = ?,
           error_code = ?,
           error_message = ?,
           finished_at = COALESCE(finished_at, ?)
       WHERE id = ? AND status = 'running' AND attempt_count = ?`
    )
    .bind('failed', now, input.errorCode, input.message, now, reviewId, input.expectedAttemptCount)
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    return false;
  }

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

  return true;
}
