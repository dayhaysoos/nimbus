import type { ReviewApprovedPolicy, ReviewReport, ReviewRunStatus } from '../../../types.js';
import { stripSensitiveTokenFields } from './shared.js';

export async function claimReviewRunForExecution(db: D1Database, reviewId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE review_runs
       SET status = 'running',
           started_at = COALESCE(started_at, ?),
           attempt_count = attempt_count + 1,
           error_code = NULL,
           error_message = NULL,
           updated_at = ?
       WHERE id = ? AND status IN ('queued', 'policy_approved')`
    )
    .bind(now, now, reviewId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function updateReviewRunStatus(
  db: D1Database,
  reviewId: string,
  status: ReviewRunStatus,
  options?: {
    report?: ReviewReport | null;
    markdownSummary?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }
): Promise<void> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: Array<string | null> = [status, new Date().toISOString()];

  if (options?.startedAt !== undefined) {
    updates.push('started_at = ?');
    values.push(options.startedAt);
  }
  if (options?.finishedAt !== undefined) {
    updates.push('finished_at = ?');
    values.push(options.finishedAt);
  }
  if (options?.report !== undefined) {
    updates.push('report_json = ?');
    values.push(options.report ? JSON.stringify(stripSensitiveTokenFields(options.report)) : null);
  }
  if (options?.markdownSummary !== undefined) {
    updates.push('markdown_summary = ?');
    values.push(typeof options.markdownSummary === 'string' ? (stripSensitiveTokenFields(options.markdownSummary) as string) : options.markdownSummary);
  }
  if (options?.errorCode !== undefined) {
    updates.push('error_code = ?');
    values.push(options.errorCode);
  }
  if (options?.errorMessage !== undefined) {
    updates.push('error_message = ?');
    values.push(options.errorMessage);
  }
  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    updates.push('finished_at = COALESCE(finished_at, ?)');
    values.push(new Date().toISOString());
  }

  values.push(reviewId);
  await db.prepare(`UPDATE review_runs SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function updateReviewRunPolicy(
  db: D1Database,
  reviewId: string,
  options: {
    derivedPolicy?: ReviewApprovedPolicy | null;
    approvedPolicy?: ReviewApprovedPolicy | null;
    approvedPolicySha256?: string | null;
  }
): Promise<void> {
  const updates: string[] = ['updated_at = ?'];
  const values: Array<string | null> = [new Date().toISOString()];

  if (options.derivedPolicy !== undefined) {
    updates.push('derived_policy_json = ?');
    values.push(options.derivedPolicy ? JSON.stringify(stripSensitiveTokenFields(options.derivedPolicy)) : null);
  }
  if (options.approvedPolicy !== undefined) {
    updates.push('approved_policy_json = ?');
    values.push(options.approvedPolicy ? JSON.stringify(stripSensitiveTokenFields(options.approvedPolicy)) : null);
  }
  if (options.approvedPolicySha256 !== undefined) {
    updates.push('approved_policy_sha256 = ?');
    values.push(options.approvedPolicySha256 ?? null);
  }

  values.push(reviewId);
  await db.prepare(`UPDATE review_runs SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
}
