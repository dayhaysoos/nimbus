import type {
  ReviewApprovedPolicy,
  ReviewBasis,
  ReviewContextRef,
  ReviewFinding,
  ReviewPolicyMode,
  ReviewRecommendation,
  ReviewReport,
  ReviewRunListItem,
  ReviewRunRecord,
  ReviewRunResponse,
  ReviewRunStatus,
  ReviewSeverity,
} from '../../../types.js';
import { extractPolicyItemsFromIntentContext } from '../../review-redaction.js';

export interface ReviewEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface ReviewEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export interface ReviewRunListRecord {
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

export function parseJsonOrFallback<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique constraint failed/i.test(error.message);
}

const GITHUB_TOKEN_PATTERN = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_TOKEN_PATTERN_TEST = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/;

export function stripSensitiveTokenFields(value: unknown): unknown {
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

export function normalizeReviewPolicy(value: unknown): ReviewApprovedPolicy | null {
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

export function toReviewFindingRecord(value: unknown): ReviewFinding[] {
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

      return [{ filePath, startLine: nullRange ? null : (startLine as number), endLine: nullRange ? null : (endLine as number) }];
    });

    if (locations.length === 0) {
      return [];
    }

    const sequence = typeof record.sequence === 'number' && Number.isInteger(record.sequence) && record.sequence > 0
      ? record.sequence
      : undefined;

    return [{ ...(sequence ? { sequence } : {}), severity: severity as ReviewFinding['severity'], category: category as ReviewFinding['category'], passType: passType as ReviewFinding['passType'], locations, description, suggestedFix }];
  });
}

export function toReviewRunResponse(record: ReviewRunRecord): ReviewRunResponse {
  const provenance = parseJsonOrFallback<Record<string, unknown>>(record.provenance_json, {});
  const report = parseJsonOrFallback<ReviewReport | null>(record.report_json, null);
  const requestPayload = parseJsonOrFallback<Record<string, unknown>>(record.request_payload_json, {});
  const policyMode = requestPayload.policyMode as ReviewPolicyMode | undefined;
  const reviewBasis = requestPayload.reviewBasis as ReviewBasis | undefined;
  const requestProvenance = requestPayload && typeof requestPayload.provenance === 'object' && requestPayload.provenance !== null
    ? (requestPayload.provenance as Record<string, unknown>)
    : {};
  const rawIntentSessionContext = Array.isArray(requestProvenance.intentSessionContext) ? requestProvenance.intentSessionContext : [];
  const intentSummaryFromReport = report?.provenance?.intentSummary;
  const intentSummary = intentSummaryFromReport
    ? {
        goal: typeof intentSummaryFromReport.goal === 'string' && intentSummaryFromReport.goal.trim() ? intentSummaryFromReport.goal.trim() : null,
        prohibitions: Array.isArray(intentSummaryFromReport.prohibitions) ? intentSummaryFromReport.prohibitions.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
        constraints: Array.isArray(intentSummaryFromReport.constraints) ? intentSummaryFromReport.constraints.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
      }
    : undefined;
  const policyItems = extractPolicyItemsFromIntentContext(rawIntentSessionContext.filter((item): item is string => typeof item === 'string'));
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
    ...(policyMode === 'none' || policyMode === 'auto' || policyMode === 'review' ? { policyMode } : {}),
    ...(reviewBasis === 'checkpoint' || reviewBasis === 'environment' ? { reviewBasis } : {}),
    idempotencyKey: record.idempotency_key,
    attemptCount: record.attempt_count,
    ...(derivedPolicy ? { derivedPolicy } : {}),
    ...(approvedPolicy ? { approvedPolicy } : {}),
    ...(typeof record.approved_policy_sha256 === 'string' && record.approved_policy_sha256 ? { approvedPolicySha256: record.approved_policy_sha256 } : {}),
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    findings: toReviewFindingRecord(report?.findings),
    evidence: Array.isArray(report?.evidence) ? report.evidence : [],
    provenance: {
      repo: typeof requestProvenance.repo === 'string' && requestProvenance.repo.trim() ? requestProvenance.repo.trim() : (record.repo ?? ''),
      branch: typeof requestProvenance.branch === 'string' && requestProvenance.branch.trim() ? requestProvenance.branch.trim() : (record.branch ?? ''),
      sessionIds: report?.provenance && Array.isArray(report.provenance.sessionIds) ? report.provenance.sessionIds : [],
      policyItems: intentSummary ? [] : policyItems,
      ...(intentSummary ? { intentSummary } : {}),
      promptSummary:
        report?.provenance && typeof report.provenance.promptSummary === 'string'
          ? report.provenance.promptSummary
          : !reportHasProvenance && typeof provenance.promptSummary === 'string'
            ? provenance.promptSummary
            : null,
      transcriptUrl: report?.provenance && typeof report.provenance.transcriptUrl === 'string' ? report.provenance.transcriptUrl : null,
      reviewContextRef: report?.provenance && report.provenance.reviewContextRef && typeof report.provenance.reviewContextRef === 'object' ? (report.provenance.reviewContextRef as ReviewContextRef) : null,
      reviewContextStats: report?.provenance && report.provenance.reviewContextStats && typeof report.provenance.reviewContextStats === 'object' ? report.provenance.reviewContextStats : undefined,
      reviewedFiles: report?.provenance && report.provenance.reviewedFiles && typeof report.provenance.reviewedFiles === 'object' ? report.provenance.reviewedFiles : undefined,
      coChange: report?.provenance && report.provenance.coChange && typeof report.provenance.coChange === 'object' ? report.provenance.coChange : undefined,
      contextResolution: report?.provenance && report.provenance.contextResolution && typeof report.provenance.contextResolution === 'object' ? report.provenance.contextResolution : undefined,
      checkpointSelectionMode:
        report?.provenance?.checkpointSelectionMode === 'latest' ||
        report?.provenance?.checkpointSelectionMode === 'last_n' ||
        report?.provenance?.checkpointSelectionMode === 'range'
          ? report.provenance.checkpointSelectionMode
          : requestProvenance.checkpointSelectionMode === 'latest' ||
              requestProvenance.checkpointSelectionMode === 'last_n' ||
              requestProvenance.checkpointSelectionMode === 'range'
            ? requestProvenance.checkpointSelectionMode
            : undefined,
      includedCheckpoints:
        report?.provenance && Array.isArray(report.provenance.includedCheckpoints)
          ? report.provenance.includedCheckpoints
              .flatMap((entry) => {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                  return [];
                }
                const record = entry as Record<string, unknown>;
                const checkpointId = typeof record.checkpointId === 'string' ? record.checkpointId.trim() : '';
                const commitSha = typeof record.commitSha === 'string' ? record.commitSha.trim() : '';
                const commitSubject = typeof record.commitSubject === 'string' ? record.commitSubject.trim() : '';
                return checkpointId && commitSha ? [{ checkpointId, commitSha, commitSubject }] : [];
              })
          : Array.isArray(requestProvenance.includedCheckpoints)
            ? requestProvenance.includedCheckpoints
                .flatMap((entry) => {
                  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                    return [];
                  }
                  const record = entry as Record<string, unknown>;
                  const checkpointId = typeof record.checkpointId === 'string' ? record.checkpointId.trim() : '';
                  const commitSha = typeof record.commitSha === 'string' ? record.commitSha.trim() : '';
                  const commitSubject = typeof record.commitSubject === 'string' ? record.commitSubject.trim() : '';
                  return checkpointId && commitSha ? [{ checkpointId, commitSha, commitSubject }] : [];
                })
            : undefined,
      outputSchemaVersion: report?.provenance?.outputSchemaVersion,
      passArchitecture: report?.provenance?.passArchitecture,
      validation: report?.provenance && report.provenance.validation && typeof report.provenance.validation === 'object' ? report.provenance.validation : undefined,
      furtherPassesLowYield: report?.provenance && report.provenance.furtherPassesLowYield && typeof report.provenance.furtherPassesLowYield === 'object' ? report.provenance.furtherPassesLowYield : undefined,
      advisories: report?.provenance && Array.isArray(report.provenance.advisories) ? report.provenance.advisories.filter((item): item is string => typeof item === 'string') : undefined,
    },
    markdownSummary: record.markdown_summary,
  };

  if (report?.summary) response.summary = report.summary;
  if (typeof report?.summaryText === 'string') response.summaryText = report.summaryText;
  if (typeof report?.furtherPassesLowYield === 'boolean') response.furtherPassesLowYield = report.furtherPassesLowYield;
  if (report?.intent) response.intent = report.intent;
  if (record.error_code && record.error_message) {
    response.error = { code: record.error_code, message: record.error_message };
  }

  return response;
}

export class ReviewIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Review idempotency key conflict: ${key}`);
    this.name = 'ReviewIdempotencyConflictError';
  }
}
