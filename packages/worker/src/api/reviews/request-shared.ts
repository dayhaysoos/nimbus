import { normalizeIntentSummaryModel } from './policy-shared.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLocalCochange(value: unknown): {
  source: 'local_git';
  checkpointsRef: string;
  lookbackSessions: number;
  topN: number;
  sessionsScanned: number;
  relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
} | null {
  if (!isRecord(value)) {
    return null;
  }

  const source = typeof value.source === 'string' && value.source.trim() ? value.source.trim() : null;
  if (source !== 'local_git') {
    return null;
  }
  const checkpointsRef =
    typeof value.checkpointsRef === 'string' && value.checkpointsRef.trim()
      ? value.checkpointsRef.trim().slice(0, 256)
      : 'entire/checkpoints/v1';
  const lookbackSessions =
    typeof value.lookbackSessions === 'number' && Number.isFinite(value.lookbackSessions)
      ? Math.max(1, Math.min(50, Math.floor(value.lookbackSessions)))
      : 5;
  const topN =
    typeof value.topN === 'number' && Number.isFinite(value.topN)
      ? Math.max(1, Math.min(100, Math.floor(value.topN)))
      : 20;
  const sessionsScanned =
    typeof value.sessionsScanned === 'number' && Number.isFinite(value.sessionsScanned)
      ? Math.max(0, Math.min(200, Math.floor(value.sessionsScanned)))
      : 0;

  const relatedByChangedPathRaw = isRecord(value.relatedByChangedPath) ? value.relatedByChangedPath : null;
  if (!relatedByChangedPathRaw) {
    return null;
  }

  const relatedByChangedPath = Object.entries(relatedByChangedPathRaw)
    .slice(0, 400)
    .reduce<Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>>((acc, [changedPath, entries]) => {
      const key = changedPath.trim();
      if (!key || !Array.isArray(entries)) {
        return acc;
      }
      const normalizedEntries = entries
        .slice(0, 400)
        .flatMap((entry) => {
          if (!isRecord(entry)) {
            return [];
          }
          const path = typeof entry.path === 'string' ? entry.path.trim() : '';
          const frequency =
            typeof entry.frequency === 'number' && Number.isFinite(entry.frequency)
              ? Math.max(0, Math.floor(entry.frequency))
              : 0;
          const sessionIds = Array.isArray(entry.sessionIds)
            ? Array.from(
                new Set(
                  entry.sessionIds
                    .filter((item): item is string => typeof item === 'string')
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .slice(0, 40)
                )
              )
            : [];
          if (!path || frequency <= 0) {
            return [];
          }
          return [{ path, frequency, sessionIds }];
        })
        .sort((left, right) => right.frequency - left.frequency)
        .slice(0, topN);
      acc[key] = normalizedEntries;
      return acc;
    }, {});

  return {
    source: 'local_git',
    checkpointsRef,
    lookbackSessions,
    topN,
    sessionsScanned,
    relatedByChangedPath,
  };
}

export function normalizeRepoSlug(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  if (value.length > 255) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : undefined;
}

export function normalizeBranchRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  if (value.length > 255) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizePolicyMode(value: unknown): 'none' | 'auto' | 'review' {
  const candidate = typeof value === 'string' ? value.trim() : value;
  if (candidate === 'none' || candidate === 'auto' || candidate === 'review') {
    return candidate;
  }
  return 'none';
}

export function normalizeReviewBasis(value: unknown): 'checkpoint' | 'environment' {
  const candidate = typeof value === 'string' ? value.trim() : value;
  if (candidate === 'checkpoint' || candidate === 'environment') {
    return candidate;
  }
  return 'checkpoint';
}

export function stripSensitiveTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitiveTokenFields(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.entries(record).reduce<Record<string, unknown>>((result, [key, nested]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'x-review-github-token' ||
      normalizedKey === 'review_context_github_token' ||
      normalizedKey === 'x-openrouter-api-key' ||
      normalizedKey === 'openrouter_api_key' ||
      normalizedKey === 'authorization'
    ) {
      return result;
    }
    result[key] = stripSensitiveTokenFields(nested);
    return result;
  }, {});
}

export function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => withSortedKeys(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = withSortedKeys(record[key]);
      return result;
    }, {});
}

function assignIdempotencyNestedField(
  payload: Record<string, unknown>,
  section: 'policy' | 'format',
  key: string,
  value: unknown
): void {
  payload[section] = {
    ...(payload[section] as Record<string, unknown> | undefined),
    [key]: value,
  };
}

/**
 * Normalizes review create request payloads and derives the canonical idempotency subset.
 * This keeps equivalent requests stable even when optional fields are omitted.
 */
export function buildReviewRequestPayload(input: {
  workspaceId: string;
  deploymentId: string;
  policyMode: unknown;
  reviewBasis: unknown;
  policy: Record<string, unknown>;
  format: Record<string, unknown>;
  provenance: Record<string, unknown>;
  repo: string;
  branch: string;
  model: string | undefined;
}) {
  const note = typeof input.provenance.note === 'string' && input.provenance.note.trim()
    ? input.provenance.note.trim()
    : null;
  const transcriptUrl = typeof input.provenance.transcriptUrl === 'string' && input.provenance.transcriptUrl.trim()
    ? input.provenance.transcriptUrl.trim()
    : null;
  const sessionIds = Array.isArray(input.provenance.sessionIds)
    ? Array.from(new Set(input.provenance.sessionIds.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
    : [];
  const intentSessionContext = Array.isArray(input.provenance.intentSessionContext)
    ? Array.from(
        new Set(
          input.provenance.intentSessionContext
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        )
      )
    : [];
  const rawSessionPrompts =
    typeof input.provenance.rawSessionPrompts === 'string' && input.provenance.rawSessionPrompts.trim()
      ? input.provenance.rawSessionPrompts.trim().slice(0, 6000)
      : null;
  const intentSummaryModel = normalizeIntentSummaryModel(input.provenance.intentSummaryModel);
  const commitSha = typeof input.provenance.commitSha === 'string' && input.provenance.commitSha.trim()
    ? input.provenance.commitSha.trim()
    : undefined;
  const commitDiffPatch = typeof input.provenance.commitDiffPatch === 'string' && input.provenance.commitDiffPatch.trim()
    ? input.provenance.commitDiffPatch
    : undefined;
  const commitDiffPatchSha256 =
    typeof input.provenance.commitDiffPatchSha256 === 'string' && input.provenance.commitDiffPatchSha256.trim()
      ? input.provenance.commitDiffPatchSha256.trim()
      : undefined;
  const commitDiffPatchTruncated = input.provenance.commitDiffPatchTruncated === true;
  const commitDiffPatchOriginalChars =
    typeof input.provenance.commitDiffPatchOriginalChars === 'number' && Number.isFinite(input.provenance.commitDiffPatchOriginalChars)
      ? Math.max(0, Math.floor(input.provenance.commitDiffPatchOriginalChars))
      : undefined;
  const contextResolution =
    input.provenance.contextResolution === 'branch_fallback' || input.provenance.contextResolution === 'direct'
      ? input.provenance.contextResolution
      : undefined;
  const contextResolutionOriginalCheckpointId =
    typeof input.provenance.contextResolutionOriginalCheckpointId === 'string' &&
    input.provenance.contextResolutionOriginalCheckpointId.trim()
      ? input.provenance.contextResolutionOriginalCheckpointId.trim()
      : undefined;
  const contextResolutionResolvedCheckpointId =
    typeof input.provenance.contextResolutionResolvedCheckpointId === 'string' &&
    input.provenance.contextResolutionResolvedCheckpointId.trim()
      ? input.provenance.contextResolutionResolvedCheckpointId.trim()
      : undefined;
  const contextResolutionResolvedCommitSha =
    typeof input.provenance.contextResolutionResolvedCommitSha === 'string' &&
    input.provenance.contextResolutionResolvedCommitSha.trim()
      ? input.provenance.contextResolutionResolvedCommitSha.trim()
      : undefined;
  const contextResolutionResolvedCommitMessage =
    typeof input.provenance.contextResolutionResolvedCommitMessage === 'string' &&
    input.provenance.contextResolutionResolvedCommitMessage.trim()
      ? input.provenance.contextResolutionResolvedCommitMessage.trim()
      : undefined;
  const localCochange = normalizeLocalCochange(input.provenance.localCochange);
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
  const policyMode = normalizePolicyMode(input.policyMode);
  const reviewBasis = normalizeReviewBasis(input.reviewBasis);

  const normalized = {
    target: {
      type: 'workspace_deployment' as const,
      workspaceId: input.workspaceId,
      deploymentId: input.deploymentId,
    },
    mode: 'report_only' as const,
    policyMode,
    reviewBasis,
    policy: {
      severityThreshold:
        typeof input.policy.severityThreshold === 'string' && input.policy.severityThreshold.trim()
          ? input.policy.severityThreshold.trim()
          : 'low',
      maxFindings: typeof input.policy.maxFindings === 'number' && Number.isFinite(input.policy.maxFindings)
        ? Math.max(1, Math.min(500, Math.floor(input.policy.maxFindings)))
        : 100,
      includeProvenance: input.policy.includeProvenance !== false,
      includeValidationEvidence: input.policy.includeValidationEvidence !== false,
    },
    format: {
      primary: typeof input.format.primary === 'string' && input.format.primary.trim() ? input.format.primary.trim() : 'json',
      includeMarkdownSummary: input.format.includeMarkdownSummary !== false,
    },
    provenance: {
      trigger: 'api',
      ...(note ? { note } : {}),
      ...(transcriptUrl ? { transcriptUrl } : {}),
      ...(sessionIds.length > 0 ? { sessionIds } : {}),
      ...(intentSessionContext.length > 0 ? { intentSessionContext } : {}),
      ...(rawSessionPrompts ? { rawSessionPrompts } : {}),
      ...(intentSummaryModel ? { intentSummaryModel } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(commitDiffPatch ? { commitDiffPatch } : {}),
      ...(commitDiffPatchSha256 ? { commitDiffPatchSha256 } : {}),
      ...(commitDiffPatchTruncated ? { commitDiffPatchTruncated } : {}),
      ...(typeof commitDiffPatchOriginalChars === 'number' ? { commitDiffPatchOriginalChars } : {}),
      ...(contextResolution ? { contextResolution } : {}),
      ...(contextResolutionOriginalCheckpointId ? { contextResolutionOriginalCheckpointId } : {}),
      ...(contextResolutionResolvedCheckpointId ? { contextResolutionResolvedCheckpointId } : {}),
      ...(contextResolutionResolvedCommitSha ? { contextResolutionResolvedCommitSha } : {}),
      ...(contextResolutionResolvedCommitMessage ? { contextResolutionResolvedCommitMessage } : {}),
      repo: input.repo,
      branch: input.branch,
      ...(localCochange ? { localCochange } : {}),
    },
    ...(model ? { model } : {}),
  };

  const idempotencyPayload: Record<string, unknown> = {
    target: normalized.target,
    mode: normalized.mode,
    policyMode: normalized.policyMode,
    reviewBasis: normalized.reviewBasis,
    provenance: normalized.provenance,
  };

  if (normalized.policy.severityThreshold !== 'low') {
    assignIdempotencyNestedField(
      idempotencyPayload,
      'policy',
      'severityThreshold',
      normalized.policy.severityThreshold
    );
  }
  if (normalized.policy.maxFindings !== 100) {
    assignIdempotencyNestedField(idempotencyPayload, 'policy', 'maxFindings', normalized.policy.maxFindings);
  }
  if (normalized.policy.includeProvenance !== true) {
    assignIdempotencyNestedField(
      idempotencyPayload,
      'policy',
      'includeProvenance',
      normalized.policy.includeProvenance
    );
  }
  if (normalized.policy.includeValidationEvidence !== true) {
    assignIdempotencyNestedField(
      idempotencyPayload,
      'policy',
      'includeValidationEvidence',
      normalized.policy.includeValidationEvidence
    );
  }
  if (normalized.format.primary !== 'json') {
    assignIdempotencyNestedField(idempotencyPayload, 'format', 'primary', normalized.format.primary);
  }
  if (normalized.format.includeMarkdownSummary !== true) {
    assignIdempotencyNestedField(
      idempotencyPayload,
      'format',
      'includeMarkdownSummary',
      normalized.format.includeMarkdownSummary
    );
  }
  if (normalized.model) {
    idempotencyPayload.model = normalized.model;
  }

  return {
    requestPayload: normalized,
    idempotencyPayload: withSortedKeys(idempotencyPayload),
  };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
