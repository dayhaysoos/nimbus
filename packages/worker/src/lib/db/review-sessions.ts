import type {
  ReviewBasis,
  ReviewRunStatus,
  ReviewSessionPassRecord,
  ReviewSessionPassSummary,
  ReviewSessionPhase,
  ReviewSessionRecord,
  ReviewSessionResponse,
  ReviewSessionStopReason,
} from '../../types.js';
import { generatePrefixedId, parseJsonOrFallback } from './reviews/shared.js';

function normalizeReviewBasis(value: unknown): ReviewBasis {
  return value === 'environment' ? 'environment' : 'checkpoint';
}

function deriveSessionPhase(status: ReviewRunStatus | null): ReviewSessionPhase {
  switch (status) {
    case 'policy_pending':
    case 'policy_ready':
      return 'waiting_on_human';
    case 'running':
      return 'reviewing';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'policy_approved':
    case 'queued':
    default:
      return 'preparing';
  }
}

function deriveStopReason(status: ReviewRunStatus | null, passCount = 1): ReviewSessionStopReason | null {
  switch (status) {
    case 'succeeded':
      return passCount > 1 ? 'followup_pass_completed' : 'initial_pass_completed';
    case 'failed':
      return passCount > 1 ? 'followup_pass_failed' : 'initial_pass_failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

function toPassSummary(record: ReviewSessionPassRecord): ReviewSessionPassSummary {
  const requestPayload = parseJsonOrFallback<Record<string, unknown>>(record.request_payload_json, {});
  return {
    reviewId: record.id,
    status: record.status,
    reviewBasis: normalizeReviewBasis(requestPayload.reviewBasis),
    createdAt: record.created_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
  };
}

function toReviewSessionResponse(record: ReviewSessionRecord, passes: ReviewSessionPassRecord[]): ReviewSessionResponse {
  const passSummaries = passes.map(toPassSummary);
  const latestPass = passSummaries[passSummaries.length - 1] ?? null;
  const currentReviewStatus = latestPass?.status ?? null;
  const derivedPassCount = typeof record.pass_count === 'number' ? record.pass_count : passSummaries.length;
  const derivedUpdatedAt =
    latestPass?.finishedAt ?? latestPass?.startedAt ?? latestPass?.createdAt ?? record.updated_at;
  const derivedFinishedAt = record.finished_at ?? latestPass?.finishedAt ?? null;

  return {
    id: record.id,
    workspaceId: record.workspace_id,
    anchorDeploymentId: record.anchor_deployment_id,
    repo: record.repo,
    branch: record.branch,
    initialReviewBasis: normalizeReviewBasis(record.initial_review_basis),
    anchorCommitSha: record.anchor_commit_sha,
    anchorCheckpointId: record.anchor_checkpoint_id,
    sourceProjectRoot: record.source_project_root,
    phase: deriveSessionPhase(currentReviewStatus),
    passCount: derivedPassCount,
    activeReviewId: record.active_review_id,
    latestReviewId: record.latest_review_id,
    currentReviewStatus,
    stopReason: record.stop_reason ?? deriveStopReason(currentReviewStatus, derivedPassCount),
    createdAt: record.created_at,
    updatedAt: derivedUpdatedAt,
    finishedAt: derivedFinishedAt,
    passes: passSummaries,
  };
}

export function generateReviewSessionId(): string {
  return generatePrefixedId('session');
}

export async function createReviewSession(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    anchorDeploymentId: string;
    repo: string;
    branch: string;
    initialReviewBasis: ReviewBasis;
    anchorCommitSha?: string | null;
    anchorCheckpointId?: string | null;
    sourceProjectRoot?: string | null;
    accountId?: string | null;
  }
): Promise<ReviewSessionResponse> {
  const now = new Date().toISOString();
  const record = await db
    .prepare(
      `INSERT INTO review_sessions (
         id,
         workspace_id,
         anchor_deployment_id,
         repo,
         branch,
         initial_review_basis,
         anchor_commit_sha,
         anchor_checkpoint_id,
         source_project_root,
         account_id,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.anchorDeploymentId,
      input.repo,
      input.branch,
      input.initialReviewBasis,
      input.anchorCommitSha ?? null,
      input.anchorCheckpointId ?? null,
      input.sourceProjectRoot ?? null,
      input.accountId ?? null,
      now,
      now
    )
    .first<ReviewSessionRecord>();

  if (!record) {
    throw new Error('Failed to create review session');
  }

  return toReviewSessionResponse(record, []);
}

export async function attachReviewPassToSession(
  db: D1Database,
  sessionId: string,
  reviewId: string,
  options?: { terminalStatus?: ReviewRunStatus | null }
): Promise<void> {
  const terminalStatus = options?.terminalStatus ?? null;
  const finishedAt = terminalStatus === 'succeeded' || terminalStatus === 'failed' || terminalStatus === 'cancelled'
    ? new Date().toISOString()
    : null;
  await db
    .prepare(
      `UPDATE review_sessions
       SET active_review_id = ?,
           latest_review_id = ?,
           pass_count = CASE
             WHEN latest_review_id IS NULL THEN 1
             WHEN latest_review_id = ? THEN pass_count
             ELSE pass_count + 1
           END,
           stop_reason = ?,
           finished_at = ?,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      reviewId,
      reviewId,
      reviewId,
      deriveStopReason(terminalStatus),
      finishedAt,
      new Date().toISOString(),
      sessionId
    )
    .run();
}

export async function deleteReviewSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM review_sessions WHERE id = ?').bind(sessionId).run();
}

export async function getReviewSession(db: D1Database, sessionId: string): Promise<ReviewSessionResponse | null> {
  const record = await db.prepare('SELECT * FROM review_sessions WHERE id = ?').bind(sessionId).first<ReviewSessionRecord>();
  if (!record) {
    return null;
  }

  const passes = await db
    .prepare(
      `SELECT id, session_id, status, request_payload_json, created_at, started_at, finished_at
       FROM review_runs
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .bind(sessionId)
    .all<ReviewSessionPassRecord>();

  return toReviewSessionResponse(record, passes.results);
}

export async function getReviewSessionAccountId(
  db: D1Database,
  sessionId: string
): Promise<string | null | undefined> {
  const result = await db
    .prepare('SELECT account_id FROM review_sessions WHERE id = ?')
    .bind(sessionId)
    .first<{ account_id: string | null }>();
  if (!result) {
    return undefined;
  }
  return result.account_id;
}

export async function getReviewSessionByReviewId(
  db: D1Database,
  reviewId: string
): Promise<ReviewSessionResponse | null> {
  const row = await db
    .prepare('SELECT session_id FROM review_runs WHERE id = ?')
    .bind(reviewId)
    .first<{ session_id: string | null }>();

  if (!row?.session_id) {
    return null;
  }

  return getReviewSession(db, row.session_id);
}
