import type {
  ReviewApprovedPolicy,
  ReviewContextRef,
  ReviewFinding,
  ReviewMode,
  ReviewRecommendation,
  ReviewReport,
  ReviewRunListItem,
  ReviewRunRecord,
  ReviewRunResponse,
  ReviewRunStatus,
  ReviewSeverity,
  ReviewTargetType,
} from '../../types.js';
import { extractPolicyItemsFromIntentContext } from '../review-redaction.js';

interface ReviewEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface ReviewEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

interface ReviewRunListRecord {
  id: string;
  workspace_id: string;
  deployment_id: string;
  repo: string | null;
  branch: string | null;
  status: ReviewRunStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  finding_count: number | null;
  risk_level: ReviewSeverity | null;
  recommendation: ReviewRecommendation | null;
  summary_text: string | null;
  error_code: string | null;
  error_message: string | null;
}

function parseJsonOrFallback<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique constraint failed/i.test(error.message);
}

const GITHUB_TOKEN_PATTERN = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_TOKEN_PATTERN_TEST = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/;

function stripSensitiveTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitiveTokenFields(item));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && GITHUB_TOKEN_PATTERN_TEST.test(value)) {
      return value.replace(GITHUB_TOKEN_PATTERN, '[REDACTED_TOKEN]');
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.entries(record).reduce<Record<string, unknown>>((result, [key, nested]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'x-review-github-token' ||
      normalizedKey === 'review_context_github_token' ||
      normalizedKey === 'authorization'
    ) {
      return result;
    }
    result[key] = stripSensitiveTokenFields(nested);
    return result;
  }, {});
}

function normalizeReviewPolicy(value: unknown): ReviewApprovedPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const goal = typeof record.goal === 'string' && record.goal.trim() ? record.goal.trim() : null;
  const normalizeList = (input: unknown): string[] =>
    Array.isArray(input)
      ? Array.from(
          new Set(
            input
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter(Boolean)
          )
        )
      : [];

  const policy: ReviewApprovedPolicy = {
    goal,
    prohibitions: normalizeList(record.prohibitions),
    constraints: normalizeList(record.constraints),
  };

  if (!policy.goal && policy.prohibitions.length === 0 && policy.constraints.length === 0) {
    return null;
  }

  return policy;
}

function toReviewFindingRecord(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const record = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    if (!record) {
      return [];
    }

    const severity = typeof record.severity === 'string' ? record.severity.trim() : '';
    const category = typeof record.category === 'string' ? record.category.trim() : '';
    const passType = typeof record.passType === 'string' ? record.passType.trim() : '';
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    const suggestedFix = typeof record.suggestedFix === 'string' ? record.suggestedFix.trim() : '';
    if (!severity || !category || !passType || !description) {
      return [];
    }

    if (!['info', 'low', 'medium', 'high', 'critical'].includes(severity)) {
      return [];
    }
    if (!['security', 'logic', 'style', 'breaking-change'].includes(category)) {
      return [];
    }
    if (passType !== 'single') {
      return [];
    }

    const locationsRaw = Array.isArray(record.locations) ? record.locations : [];
    const locations = locationsRaw.flatMap((locationItem) => {
      const location =
        locationItem && typeof locationItem === 'object' && !Array.isArray(locationItem)
          ? (locationItem as Record<string, unknown>)
          : null;
      if (!location) {
        return [];
      }

      const filePath = typeof location.filePath === 'string' ? location.filePath.trim() : '';
      if (!filePath) {
        return [];
      }
      const startLine = location.startLine;
      const endLine = location.endLine;
      const nullRange = startLine === null && endLine === null;
      const numericRange =
        typeof startLine === 'number' &&
        Number.isInteger(startLine) &&
        startLine > 0 &&
        typeof endLine === 'number' &&
        Number.isInteger(endLine) &&
        endLine >= startLine;
      if (!nullRange && !numericRange) {
        return [];
      }

      return [
        {
          filePath,
          startLine: nullRange ? null : (startLine as number),
          endLine: nullRange ? null : (endLine as number),
        },
      ];
    });

    if (locations.length === 0) {
      return [];
    }

    const sequence = typeof record.sequence === 'number' && Number.isInteger(record.sequence) && record.sequence > 0
      ? record.sequence
      : undefined;

    return [
      {
        ...(sequence ? { sequence } : {}),
        severity: severity as ReviewFinding['severity'],
        category: category as ReviewFinding['category'],
        passType: passType as ReviewFinding['passType'],
        locations,
        description,
        suggestedFix,
      },
    ];
  });
}

function toReviewRunResponse(record: ReviewRunRecord): ReviewRunResponse {
  const provenance = parseJsonOrFallback<Record<string, unknown>>(record.provenance_json, {});
  const report = parseJsonOrFallback<ReviewReport | null>(record.report_json, null);
  const requestPayload = parseJsonOrFallback<Record<string, unknown>>(record.request_payload_json, {});
  const requestProvenance =
    requestPayload && typeof requestPayload.provenance === 'object' && requestPayload.provenance !== null
      ? (requestPayload.provenance as Record<string, unknown>)
      : {};
  const rawIntentSessionContext = Array.isArray(requestProvenance.intentSessionContext)
    ? requestProvenance.intentSessionContext
    : [];
  const intentSummaryFromReport = report?.provenance?.intentSummary;
  const intentSummary = intentSummaryFromReport
    ? {
        goal:
          typeof intentSummaryFromReport.goal === 'string' && intentSummaryFromReport.goal.trim()
            ? intentSummaryFromReport.goal.trim()
            : null,
        prohibitions: Array.isArray(intentSummaryFromReport.prohibitions)
          ? intentSummaryFromReport.prohibitions.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
          : [],
        constraints: Array.isArray(intentSummaryFromReport.constraints)
          ? intentSummaryFromReport.constraints.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
          : [],
      }
    : undefined;
  const policyItems = extractPolicyItemsFromIntentContext(
    rawIntentSessionContext.filter((item): item is string => typeof item === 'string')
  );
  const reportHasProvenance = Boolean(report?.provenance);
  const derivedPolicy = normalizeReviewPolicy(parseJsonOrFallback(record.derived_policy_json, null));
  const approvedPolicy = normalizeReviewPolicy(parseJsonOrFallback(record.approved_policy_json, null));

  const response: ReviewRunResponse = {
    id: record.id,
    workspaceId: record.workspace_id,
    deploymentId: record.deployment_id,
    target: {
      type: record.target_type,
      workspaceId: record.workspace_id,
      deploymentId: record.deployment_id,
    },
    mode: record.mode,
    status: record.status,
    idempotencyKey: record.idempotency_key,
    attemptCount: record.attempt_count,
    ...(derivedPolicy ? { derivedPolicy } : {}),
    ...(approvedPolicy ? { approvedPolicy } : {}),
    ...(typeof record.approved_policy_sha256 === 'string' && record.approved_policy_sha256
      ? { approvedPolicySha256: record.approved_policy_sha256 }
      : {}),
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    findings: toReviewFindingRecord(report?.findings),
    evidence: Array.isArray(report?.evidence) ? report.evidence : [],
    provenance: {
      repo:
        typeof requestProvenance.repo === 'string' && requestProvenance.repo.trim()
          ? requestProvenance.repo.trim()
          : (record.repo ?? ''),
      branch:
        typeof requestProvenance.branch === 'string' && requestProvenance.branch.trim()
          ? requestProvenance.branch.trim()
          : (record.branch ?? ''),
      sessionIds:
        report?.provenance && Array.isArray(report.provenance.sessionIds) ? report.provenance.sessionIds : [],
      policyItems: intentSummary ? [] : policyItems,
      ...(intentSummary ? { intentSummary } : {}),
      promptSummary:
        report?.provenance && typeof report.provenance.promptSummary === 'string'
          ? report.provenance.promptSummary
          : !reportHasProvenance && typeof provenance.promptSummary === 'string'
            ? provenance.promptSummary
            : null,
      transcriptUrl:
        report?.provenance && typeof report.provenance.transcriptUrl === 'string'
          ? report.provenance.transcriptUrl
          : null,
      reviewContextRef:
        report?.provenance && report.provenance.reviewContextRef && typeof report.provenance.reviewContextRef === 'object'
          ? (report.provenance.reviewContextRef as ReviewContextRef)
          : null,
      reviewContextStats:
        report?.provenance && report.provenance.reviewContextStats && typeof report.provenance.reviewContextStats === 'object'
          ? report.provenance.reviewContextStats
          : undefined,
      coChange:
        report?.provenance && report.provenance.coChange && typeof report.provenance.coChange === 'object'
          ? report.provenance.coChange
          : undefined,
      contextResolution:
        report?.provenance && report.provenance.contextResolution && typeof report.provenance.contextResolution === 'object'
          ? report.provenance.contextResolution
          : undefined,
      outputSchemaVersion: report?.provenance?.outputSchemaVersion,
      passArchitecture: report?.provenance?.passArchitecture,
      validation:
        report?.provenance && report.provenance.validation && typeof report.provenance.validation === 'object'
          ? report.provenance.validation
          : undefined,
      furtherPassesLowYield:
        report?.provenance && report.provenance.furtherPassesLowYield && typeof report.provenance.furtherPassesLowYield === 'object'
          ? report.provenance.furtherPassesLowYield
          : undefined,
      advisories:
        report?.provenance && Array.isArray(report.provenance.advisories)
          ? report.provenance.advisories.filter((item): item is string => typeof item === 'string')
          : undefined,
    },
    markdownSummary: record.markdown_summary,
  };

  if (report?.summary) {
    response.summary = report.summary;
  }
  if (typeof report?.summaryText === 'string') {
    response.summaryText = report.summaryText;
  }
  if (typeof report?.furtherPassesLowYield === 'boolean') {
    response.furtherPassesLowYield = report.furtherPassesLowYield;
  }
  if (report?.intent) {
    response.intent = report.intent;
  }
  if (record.error_code && record.error_message) {
    response.error = {
      code: record.error_code,
      message: record.error_message,
    };
  }

  return response;
}

export class ReviewIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Review idempotency key conflict: ${key}`);
    this.name = 'ReviewIdempotencyConflictError';
  }
}

/**
 * Creates or reuses a review row keyed by workspace-scoped idempotency, preserving policy state and sanitized payloads.
 */
export async function createReviewRun(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    deploymentId: string;
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
): Promise<{ review: ReviewRunResponse; reused: boolean }> {
  const now = new Date().toISOString();
  const existingIdempotency = await db
    .prepare(
      `SELECT review_id, request_payload_sha256, expires_at
       FROM review_run_idempotency
       WHERE workspace_id = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.idempotencyKey)
    .first<{ review_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (existingIdempotency.request_payload_sha256 !== input.requestPayloadSha256) {
      throw new ReviewIdempotencyConflictError(input.idempotencyKey);
    }

    const existingReview = await getReviewRun(db, existingIdempotency.review_id);
    if (!existingReview) {
      throw new Error(`Idempotency record references missing review ${existingIdempotency.review_id}`);
    }

    return { review: existingReview, reused: true };
  }

  if (existingIdempotency && existingIdempotency.expires_at <= now) {
    await db
      .prepare('DELETE FROM review_run_idempotency WHERE workspace_id = ? AND idempotency_key = ?')
      .bind(input.workspaceId, input.idempotencyKey)
      .run();
  }

  const idempotencyWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingReviewByKey = await db
    .prepare(
      `SELECT *
       FROM review_runs
       WHERE workspace_id = ?
         AND idempotency_key = ?
         AND julianday(created_at) >= julianday(?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(input.workspaceId, input.idempotencyKey, idempotencyWindowStart)
    .first<ReviewRunRecord>();

  if (existingReviewByKey) {
    if (existingReviewByKey.request_payload_sha256 !== input.requestPayloadSha256) {
      throw new ReviewIdempotencyConflictError(input.idempotencyKey);
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
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
        .bind(
          generatePrefixedId('rvid'),
          input.workspaceId,
          input.idempotencyKey,
          existingReviewByKey.id,
          input.requestPayloadSha256,
          expiresAt
        )
        .run();
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    return { review: toReviewRunResponse(existingReviewByKey), reused: true };
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const sanitizedRequestPayload = stripSensitiveTokenFields(input.requestPayload ?? {});
  const sanitizedProvenance = stripSensitiveTokenFields(input.provenance ?? {});
  const initialStatus = input.status ?? 'queued';
  const derivedPolicyJson = input.derivedPolicy ? JSON.stringify(stripSensitiveTokenFields(input.derivedPolicy)) : null;
  const approvedPolicyJson = input.approvedPolicy ? JSON.stringify(stripSensitiveTokenFields(input.approvedPolicy)) : null;
  const approvedPolicySha256 =
    typeof input.approvedPolicySha256 === 'string' && input.approvedPolicySha256.trim()
      ? input.approvedPolicySha256.trim()
      : null;
  const reviewRecord = await db
    .prepare(
       `INSERT INTO review_runs (
         id,
         workspace_id,
         deployment_id,
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.deploymentId,
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
    .first<ReviewRunRecord>();

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
      .bind(
        generatePrefixedId('rvid'),
        input.workspaceId,
        input.idempotencyKey,
        input.id,
        input.requestPayloadSha256,
        expiresAt
      )
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

  return { review: toReviewRunResponse(reviewRecord), reused: false };
}

export async function getReviewRun(db: D1Database, reviewId: string): Promise<ReviewRunResponse | null> {
  const record = await db.prepare('SELECT * FROM review_runs WHERE id = ?').bind(reviewId).first<ReviewRunRecord>();
  if (!record) {
    return null;
  }

  return toReviewRunResponse(record);
}

export async function listReviewRuns(
  db: D1Database,
  options?: {
    limit?: number;
    accountId?: string;
    repo?: string;
    branch?: string;
  }
): Promise<ReviewRunListItem[]> {
  const resolvedLimit =
    typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(200, Math.floor(options.limit)))
      : 100;

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
  ]
    .filter(Boolean)
    .join(' ');

  values.push(resolvedLimit);

  const result = await db.prepare(query).bind(...values).all<ReviewRunListRecord>();
  return result.results.map((record) => {
    const response: ReviewRunListItem = {
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
      findingCount: typeof record.finding_count === 'number' && Number.isFinite(record.finding_count) ? record.finding_count : null,
      riskLevel: record.risk_level,
      recommendation: record.recommendation,
      summaryText: typeof record.summary_text === 'string' ? record.summary_text : null,
    };

    if (record.error_code && record.error_message) {
      response.error = {
        code: record.error_code,
        message: record.error_message,
      };
    }

    return response;
  });
}

export async function getReviewRunAccountId(db: D1Database, reviewId: string): Promise<string | null | undefined> {
  const result = await db
    .prepare('SELECT account_id FROM review_runs WHERE id = ?')
    .bind(reviewId)
    .first<{ account_id: string | null }>();
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
    .first<ReviewRunRecord>();

  if (!existingReview) {
    return null;
  }

  if (existingReview.request_payload_sha256 !== requestPayloadSha256) {
    throw new ReviewIdempotencyConflictError(idempotencyKey);
  }

  return toReviewRunResponse(existingReview);
}

export async function getReviewRunRequestPayload(
  db: D1Database,
  reviewId: string
): Promise<Record<string, unknown> | null> {
  const record = await db
    .prepare('SELECT request_payload_json FROM review_runs WHERE id = ?')
    .bind(reviewId)
    .first<{ request_payload_json: string }>();

  if (!record) {
    return null;
  }

  const parsed = parseJsonOrFallback<unknown>(record.request_payload_json, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

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

export async function appendReviewEvent(
  db: D1Database,
  input: {
    reviewId: string;
    eventType: string;
    payload: unknown;
  }
): Promise<number> {
  const seqResult = await db
    .prepare('UPDATE review_runs SET last_event_seq = last_event_seq + 1 WHERE id = ? RETURNING last_event_seq')
    .bind(input.reviewId)
    .first<{ last_event_seq: number }>();

  if (!seqResult) {
    throw new Error(`Failed to allocate event sequence for review run ${input.reviewId}`);
  }

  const seq = Number(seqResult.last_event_seq);
  await db
    .prepare(
      `INSERT INTO review_events (review_id, seq, event_type, payload_json)
       VALUES (?, ?, ?, ?)`
    )
    .bind(input.reviewId, seq, input.eventType, JSON.stringify(stripSensitiveTokenFields(input.payload)))
    .run();

  return seq;
}

export async function listReviewEvents(
  db: D1Database,
  reviewId: string,
  fromExclusive = 0,
  limit = 500
): Promise<ReviewEventItem[]> {
  const result = await db
    .prepare(
      `SELECT seq, event_type, payload_json, created_at
       FROM review_events
       WHERE review_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .bind(reviewId, fromExclusive, limit)
    .all<ReviewEventRecord>();

  return result.results.map((row) => ({
    seq: row.seq,
    eventType: row.event_type,
    payload: parseJsonOrFallback(row.payload_json, { raw: row.payload_json }),
    createdAt: row.created_at,
  }));
}

export async function hasReviewEvent(db: D1Database, reviewId: string, eventType: string): Promise<boolean> {
  const record = await db
    .prepare(
      `SELECT 1
       FROM review_events
       WHERE review_id = ? AND event_type = ?
       LIMIT 1`
    )
    .bind(reviewId, eventType)
    .first<{ '1': number }>();

  return Boolean(record);
}

export async function replaceReviewFindings(
  db: D1Database,
  reviewId: string,
  findings: ReviewFinding[],
  options?: { startNumber?: number }
): Promise<void> {
  await db.prepare('DELETE FROM review_findings WHERE review_id = ?').bind(reviewId).run();

  const startNumber =
    typeof options?.startNumber === 'number' && Number.isFinite(options.startNumber) && options.startNumber > 0
      ? Math.floor(options.startNumber)
      : 1;

  for (const [index, finding] of findings.entries()) {
    const findingNumber = startNumber + index;
    const findingId = `${reviewId}_F-${String(findingNumber).padStart(3, '0')}`;
    await db
      .prepare(
        `INSERT INTO review_findings (
           id,
           review_id,
           severity,
           category,
           pass_type,
           description,
           locations_json,
           suggested_fix
          )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        findingId,
        reviewId,
        finding.severity,
        finding.category,
        finding.passType,
        finding.description,
        JSON.stringify(finding.locations),
        finding.suggestedFix
      )
      .run();
  }
}

export async function getHighestFindingNumberForBranch(
  db: D1Database,
  repo: string,
  branch: string
): Promise<number> {
  const normalizedRepo = repo.trim();
  const normalizedBranch = branch.trim();
  if (!normalizedRepo || !normalizedBranch) {
    return 0;
  }

  const row = await db
    .prepare(
      `SELECT
         COALESCE(MAX(
           CASE
             WHEN instr(rf.id, '_F-') > 0
               THEN CAST(substr(rf.id, instr(rf.id, '_F-') + 3) AS INTEGER)
             ELSE 0
           END
         ), 0) AS max_seq
       FROM review_findings rf
       JOIN review_runs rr ON rr.id = rf.review_id
       WHERE rr.repo = ? AND rr.branch = ?`
    )
    .bind(normalizedRepo, normalizedBranch)
    .first<{ max_seq: number | null }>();

  const maxSeq = typeof row?.max_seq === 'number' && Number.isFinite(row.max_seq) ? row.max_seq : 0;
  return Math.max(0, Math.floor(maxSeq));
}
