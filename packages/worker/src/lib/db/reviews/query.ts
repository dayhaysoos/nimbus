import type { ReviewRunListItem, ReviewRunResponse } from '../../../types.js';
import { ReviewIdempotencyConflictError, ReviewRunListRecord, toReviewRunResponse } from './shared.js';

function resolveListLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function toReviewRunListItem(record: ReviewRunListRecord): ReviewRunListItem {
  const base: ReviewRunListItem = {
    id: record.id,
    workspaceId: record.workspace_id,
    deploymentId: record.deployment_id,
    repo: typeof record.repo === 'string' && record.repo.trim() ? record.repo.trim() : 'unknown/repo',
    branch: typeof record.branch === 'string' && record.branch.trim() ? record.branch.trim() : 'unknown',
    status: record.status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    findingCount:
      typeof record.finding_count === 'number' && Number.isFinite(record.finding_count)
        ? record.finding_count
        : null,
    riskLevel: record.risk_level,
    recommendation: record.recommendation,
    summaryText: typeof record.summary_text === 'string' ? record.summary_text : null,
  };

  if (!record.error_code || !record.error_message) {
    return base;
  }

  return {
    ...base,
    error: {
      code: record.error_code,
      message: record.error_message,
    },
  };
}

export async function getReviewRun(db: D1Database, reviewId: string): Promise<ReviewRunResponse | null> {
  const record = await db.prepare('SELECT * FROM review_runs WHERE id = ?').bind(reviewId).first();
  if (!record) {
    return null;
  }
  return toReviewRunResponse(record as never);
}

export async function listReviewRuns(
  db: D1Database,
  options?: { limit?: number; accountId?: string; repo?: string; branch?: string }
) {
  const resolvedLimit = resolveListLimit(options?.limit);
  const whereClauses: string[] = [];
  const values: Array<string | number> = [];

  if (typeof options?.accountId === 'string' && options.accountId.trim()) {
    whereClauses.push('account_id = ?');
    values.push(options.accountId.trim());
  }
  if (typeof options?.repo === 'string' && options.repo.trim()) {
    whereClauses.push('repo = ?');
    values.push(options.repo.trim());
  }
  if (typeof options?.branch === 'string' && options.branch.trim()) {
    whereClauses.push('branch = ?');
    values.push(options.branch.trim());
  }

  const query = [
    `SELECT
      id,
      workspace_id,
      deployment_id,
      repo,
      branch,
      status,
      created_at,
      updated_at,
      started_at,
      finished_at,
      error_code,
      error_message,
      json_extract(report_json, '$.summary.riskLevel') AS risk_level,
      json_extract(report_json, '$.summary.recommendation') AS recommendation,
      json_extract(report_json, '$.summaryText') AS summary_text,
      CASE
        WHEN report_json IS NULL THEN NULL
        WHEN json_type(report_json, '$.summary.findingCounts') = 'object' THEN
          COALESCE(CAST(json_extract(report_json, '$.summary.findingCounts.info') AS INTEGER), 0) +
          COALESCE(CAST(json_extract(report_json, '$.summary.findingCounts.critical') AS INTEGER), 0) +
          COALESCE(CAST(json_extract(report_json, '$.summary.findingCounts.high') AS INTEGER), 0) +
          COALESCE(CAST(json_extract(report_json, '$.summary.findingCounts.medium') AS INTEGER), 0) +
          COALESCE(CAST(json_extract(report_json, '$.summary.findingCounts.low') AS INTEGER), 0)
        WHEN json_type(report_json, '$.findings') = 'array' THEN json_array_length(report_json, '$.findings')
        ELSE NULL
      END AS finding_count
     FROM review_runs`,
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '',
    'ORDER BY created_at DESC',
    'LIMIT ?',
  ].filter(Boolean).join(' ');

  values.push(resolvedLimit);

  const result = await db.prepare(query).bind(...values).all<ReviewRunListRecord>();
  return result.results.map(toReviewRunListItem);
}

export async function getReviewRunAccountId(db: D1Database, reviewId: string): Promise<string | null | undefined> {
  const result = await db.prepare('SELECT account_id FROM review_runs WHERE id = ?').bind(reviewId).first<{ account_id: string | null }>();
  if (!result) {
    return undefined;
  }
  return result.account_id;
}

export async function getReviewRunByIdempotency(
  db: D1Database,
  workspaceId: string,
  idempotencyKey: string,
  requestPayloadSha256: string
): Promise<ReviewRunResponse | null> {
  const now = new Date().toISOString();
  const existingIdempotency = await db
    .prepare(
      `SELECT review_id, request_payload_sha256, expires_at
       FROM review_run_idempotency
       WHERE workspace_id = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(workspaceId, idempotencyKey)
    .first<{ review_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (existingIdempotency.request_payload_sha256 !== requestPayloadSha256) {
      throw new ReviewIdempotencyConflictError(idempotencyKey);
    }

    const review = await getReviewRun(db, existingIdempotency.review_id);
    if (!review) {
      throw new Error(`Idempotency record references missing review ${existingIdempotency.review_id}`);
    }

    return review;
  }

  const idempotencyWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingReview = await db
    .prepare(
      `SELECT *
       FROM review_runs
       WHERE workspace_id = ?
         AND idempotency_key = ?
         AND julianday(created_at) >= julianday(?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(workspaceId, idempotencyKey, idempotencyWindowStart)
    .first();

  if (!existingReview) {
    return null;
  }

  if ((existingReview as any).request_payload_sha256 !== requestPayloadSha256) {
    throw new ReviewIdempotencyConflictError(idempotencyKey);
  }

  return toReviewRunResponse(existingReview as never);
}

export async function getReviewRunRequestPayload(db: D1Database, reviewId: string): Promise<Record<string, unknown> | null> {
  const record = await db.prepare('SELECT request_payload_json FROM review_runs WHERE id = ?').bind(reviewId).first<{ request_payload_json: string }>();
  if (!record) {
    return null;
  }
  const parsed = JSON.parse(record.request_payload_json || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}
