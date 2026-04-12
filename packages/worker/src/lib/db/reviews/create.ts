import type { ReviewApprovedPolicy, ReviewMode, ReviewRunStatus, ReviewTargetType } from '../../../types.js';
import { getReviewRun, getReviewRunByIdempotency } from './query.js';
import {
  generatePrefixedId,
  isUniqueConstraintError,
  ReviewIdempotencyConflictError,
  stripSensitiveTokenFields,
  toReviewRunResponse,
} from './shared.js';

/** Creates or reuses a review row keyed by workspace-scoped idempotency. */
export async function createReviewRun(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    deploymentId: string;
    sessionId?: string | null;
    targetType: ReviewTargetType;
    mode: ReviewMode;
    status?: ReviewRunStatus;
    idempotencyKey: string;
    requestPayload: unknown;
    requestPayloadSha256: string;
    provenance?: Record<string, unknown>;
    repo: string;
    branch: string;
    accountId?: string | null;
    derivedPolicy?: ReviewApprovedPolicy | null;
    approvedPolicy?: ReviewApprovedPolicy | null;
    approvedPolicySha256?: string | null;
  }
) {
  const now = new Date().toISOString();
  const reused = await getReviewRunByIdempotency(db, input.workspaceId, input.idempotencyKey, input.requestPayloadSha256);
  if (reused) {
    return { review: reused, reused: true };
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sanitizedRequestPayload = stripSensitiveTokenFields(input.requestPayload ?? {});
  const sanitizedProvenance = stripSensitiveTokenFields(input.provenance ?? {});
  const initialStatus = input.status ?? 'queued';
  const derivedPolicyJson = input.derivedPolicy ? JSON.stringify(stripSensitiveTokenFields(input.derivedPolicy)) : null;
  const approvedPolicyJson = input.approvedPolicy ? JSON.stringify(stripSensitiveTokenFields(input.approvedPolicy)) : null;
  const approvedPolicySha256 = typeof input.approvedPolicySha256 === 'string' && input.approvedPolicySha256.trim() ? input.approvedPolicySha256.trim() : null;

  const reviewRecord = await db
    .prepare(
      `INSERT INTO review_runs (
         id,
         workspace_id,
         deployment_id,
         session_id,
         target_type,
         mode,
         status,
         idempotency_key,
         request_payload_json,
         request_payload_sha256,
         account_id,
         provenance_json,
         repo,
         branch,
         derived_policy_json,
         approved_policy_json,
         approved_policy_sha256,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.deploymentId,
      input.sessionId ?? null,
      input.targetType,
      input.mode,
      initialStatus,
      input.idempotencyKey,
      JSON.stringify(sanitizedRequestPayload),
      input.requestPayloadSha256,
      input.accountId ?? null,
      JSON.stringify(sanitizedProvenance),
      input.repo,
      input.branch,
      derivedPolicyJson,
      approvedPolicyJson,
      approvedPolicySha256,
      now,
      now
    )
    .first();

  if (!reviewRecord) {
    throw new Error('Failed to create review run');
  }

  try {
    await db
      .prepare(
        `INSERT INTO review_run_idempotency (
           id,
           workspace_id,
           idempotency_key,
           review_id,
           request_payload_sha256,
           expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(generatePrefixedId('rvid'), input.workspaceId, input.idempotencyKey, input.id, input.requestPayloadSha256, expiresAt)
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      await db.prepare('DELETE FROM review_runs WHERE id = ?').bind(input.id).run();
      throw error;
    }

    const concurrent = await db
      .prepare(
        `SELECT review_id, request_payload_sha256, expires_at
         FROM review_run_idempotency
         WHERE workspace_id = ? AND idempotency_key = ?
         LIMIT 1`
      )
      .bind(input.workspaceId, input.idempotencyKey)
      .first<{ review_id: string; request_payload_sha256: string; expires_at: string }>();

    if (!concurrent || concurrent.expires_at <= now) {
      await db.prepare('DELETE FROM review_runs WHERE id = ?').bind(input.id).run();
      throw new Error('Review idempotency race detected but winner record is unavailable');
    }

    if (concurrent.request_payload_sha256 !== input.requestPayloadSha256) {
      await db.prepare('DELETE FROM review_runs WHERE id = ?').bind(input.id).run();
      throw new ReviewIdempotencyConflictError(input.idempotencyKey);
    }

    const existingReview = await getReviewRun(db, concurrent.review_id);
    if (!existingReview) {
      await db.prepare('DELETE FROM review_runs WHERE id = ?').bind(input.id).run();
      throw new Error(`Idempotency record references missing review ${concurrent.review_id}`);
    }

    await db.prepare('DELETE FROM review_runs WHERE id = ?').bind(input.id).run();
    return { review: existingReview, reused: true };
  }

  return { review: toReviewRunResponse(reviewRecord as never), reused: false };
}
