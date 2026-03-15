import type { AuthContext, Env, ReviewRunStatus } from '../types.js';
import {
  ReviewIdempotencyConflictError,
  appendReviewEvent,
  createReviewRun,
  generateReviewRunId,
  getReviewRun,
  getReviewRunAccountId,
  getReviewRunByIdempotency,
  getWorkspaceAccountId,
  getWorkspace,
  getWorkspaceDeployment,
  hasReviewEvent,
  listReviewEvents,
  updateReviewRunStatus,
} from '../lib/db.js';
import { createReviewQueueMessage } from '../lib/review-queue.js';
import { canAccessAccount } from '../lib/authz.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Review-Github-Token, X-Openrouter-Api-Key, X-Nimbus-Api-Key',
};

// Keep review SSE polling at 1s to stay within Cloudflare per-invocation API request
// limits. Sub-second polling (50ms) can exhaust subrequests on reviews lasting ~25s+.
const REVIEW_STREAM_POLL_INTERVAL_MS = 1000;
const REVIEW_STREAM_HEARTBEAT_INTERVAL_MS = 1000;
const REVIEW_TERMINAL_EVENT_GRACE_MS = 1000;
const REVIEW_STREAM_STATUS_REFRESH_POLLS = 5;
const REVIEW_STALE_RUNNING_GRACE_MS = 60_000;

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

function parseMaxRetryCount(value: string | undefined, fallbackAttempts: number): number {
  const parsedAttempts = Number.parseInt(value ?? '', 10);
  const attempts = Number.isFinite(parsedAttempts) && parsedAttempts > 0 ? parsedAttempts : fallbackAttempts;
  return Math.max(0, attempts - 1);
}

function readWorkerReviewGithubToken(env: Env): string | null {
  return typeof env.REVIEW_CONTEXT_GITHUB_TOKEN === 'string' && env.REVIEW_CONTEXT_GITHUB_TOKEN.trim()
    ? env.REVIEW_CONTEXT_GITHUB_TOKEN.trim()
    : null;
}

async function recoverStaleRunningReviewIfNeeded(
  env: Env,
  reviewId: string,
  review: { status: ReviewRunStatus; startedAt: string | null; updatedAt: string; createdAt: string; attemptCount: number }
): Promise<void> {
  if (review.status !== 'running') {
    return;
  }
  const attemptTimeoutMs = parseTimeoutMs(env.ATTEMPT_TIMEOUT_MS, 600_000);
  const staleThresholdMs = attemptTimeoutMs + REVIEW_STALE_RUNNING_GRACE_MS;
  const startedMs = Date.parse(review.startedAt ?? review.updatedAt ?? review.createdAt);
  if (!Number.isFinite(startedMs)) {
    return;
  }
  const staleForMs = Date.now() - startedMs;
  if (staleForMs < staleThresholdMs) {
    return;
  }

  const maxRetries = parseMaxRetryCount(env.MAX_ATTEMPTS, 3);
  const workerGithubToken = readWorkerReviewGithubToken(env);
  if (review.attemptCount <= maxRetries && env.REVIEWS_QUEUE && workerGithubToken) {
    await updateReviewRunStatus(env.DB, reviewId, 'queued', {
      report: null,
      markdownSummary: null,
      startedAt: null,
      finishedAt: null,
      errorCode: 'retry_scheduled',
      errorMessage: `Review execution stalled in running state for ${Math.floor(staleForMs / 1000)}s.`,
    });
    await appendReviewEvent(env.DB, {
      reviewId,
      eventType: 'review_retry_scheduled',
      payload: {
        attemptCount: review.attemptCount,
        maxRetries,
        reason: 'stale_running_timeout',
        staleForSeconds: Math.floor(staleForMs / 1000),
      },
    });
    await env.REVIEWS_QUEUE.send(createReviewQueueMessage(reviewId, workerGithubToken));
    return;
  }

  const missingTokenSuffix = !workerGithubToken
    ? ' Automatic stale-run retry requires REVIEW_CONTEXT_GITHUB_TOKEN and cannot reuse per-request header tokens.'
    : '';
  const message = `Review execution timed out after ${Math.floor(staleForMs / 1000)}s in running state.${missingTokenSuffix}`;
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
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

async function requireWorkspaceAccess(env: Env, workspaceId: string, authContext: AuthContext): Promise<Response | null> {
  const accountId = await getWorkspaceAccountId(env.DB, workspaceId);
  if (!canAccessAccount(authContext, accountId)) {
    return jsonResponse({ error: 'Workspace not found' }, 404);
  }
  return null;
}

async function requireReviewAccess(env: Env, reviewId: string, authContext: AuthContext): Promise<Response | null> {
  const accountId = await getReviewRunAccountId(env.DB, reviewId);
  if (!canAccessAccount(authContext, accountId)) {
    return jsonResponse({ error: 'Review not found' }, 404);
  }
  return null;
}

function formatSseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function formatSseDataWithId(seq: number, payload: unknown): string {
  return `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFromSequence(request: Request): number {
  const url = new URL(request.url);
  const fromParam = Number.parseInt(url.searchParams.get('from') ?? '', 10);
  const lastEventId = Number.parseInt(request.headers.get('Last-Event-ID') ?? '', 10);

  if (Number.isFinite(lastEventId) && lastEventId >= 0) {
    return lastEventId;
  }
  if (Number.isFinite(fromParam) && fromParam >= 0) {
    return fromParam;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSeverityThreshold(value: unknown): value is 'low' | 'medium' | 'high' | 'critical' {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
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

function readReviewGithubTokenHeader(request: Request): string | null {
  const value = request.headers.get('X-Review-Github-Token');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOpenrouterApiKeyHeader(request: Request): string | null {
  const value = request.headers.get('X-Openrouter-Api-Key');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stripSensitiveTokenFields(value: unknown): unknown {
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

function withSortedKeys(value: unknown): unknown {
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

function buildReviewRequestPayload(input: {
  workspaceId: string;
  deploymentId: string;
  policy: Record<string, unknown>;
  format: Record<string, unknown>;
  provenance: Record<string, unknown>;
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

  const normalized = {
    target: {
      type: 'workspace_deployment' as const,
      workspaceId: input.workspaceId,
      deploymentId: input.deploymentId,
    },
    mode: 'report_only' as const,
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
      ...(localCochange ? { localCochange } : {}),
    },
    ...(model ? { model } : {}),
  };

  const idempotencyPayload: Record<string, unknown> = {
    target: normalized.target,
    mode: normalized.mode,
    provenance: normalized.provenance,
  };

  if (normalized.policy.severityThreshold !== 'low') {
    idempotencyPayload.policy = {
      ...(idempotencyPayload.policy as Record<string, unknown> | undefined),
      severityThreshold: normalized.policy.severityThreshold,
    };
  }
  if (normalized.policy.maxFindings !== 100) {
    idempotencyPayload.policy = {
      ...(idempotencyPayload.policy as Record<string, unknown> | undefined),
      maxFindings: normalized.policy.maxFindings,
    };
  }
  if (normalized.policy.includeProvenance !== true) {
    idempotencyPayload.policy = {
      ...(idempotencyPayload.policy as Record<string, unknown> | undefined),
      includeProvenance: normalized.policy.includeProvenance,
    };
  }
  if (normalized.policy.includeValidationEvidence !== true) {
    idempotencyPayload.policy = {
      ...(idempotencyPayload.policy as Record<string, unknown> | undefined),
      includeValidationEvidence: normalized.policy.includeValidationEvidence,
    };
  }
  if (normalized.format.primary !== 'json') {
    idempotencyPayload.format = {
      ...(idempotencyPayload.format as Record<string, unknown> | undefined),
      primary: normalized.format.primary,
    };
  }
  if (normalized.format.includeMarkdownSummary !== true) {
    idempotencyPayload.format = {
      ...(idempotencyPayload.format as Record<string, unknown> | undefined),
      includeMarkdownSummary: normalized.format.includeMarkdownSummary,
    };
  }
  if (normalized.model) {
    idempotencyPayload.model = normalized.model;
  }

  return {
    requestPayload: normalized,
    idempotencyPayload: withSortedKeys(idempotencyPayload),
  };
}

function buildLegacyReviewRequestPayload(input: {
  workspaceId: string;
  deploymentId: string;
  policy: Record<string, unknown>;
  format: Record<string, unknown>;
}) {
  return {
    target: {
      type: 'workspace_deployment',
      workspaceId: input.workspaceId,
      deploymentId: input.deploymentId,
    },
    mode: 'report_only',
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
    },
  };
}

function hasExtendedReviewIdempotencyInputs(input: {
  provenance: Record<string, unknown>;
  model: string | undefined;
}): boolean {
  if (typeof input.model === 'string' && input.model.trim()) {
    return true;
  }
  const provenance = input.provenance;
  if (typeof provenance.note === 'string' && provenance.note.trim()) {
    return true;
  }
  if (typeof provenance.transcriptUrl === 'string' && provenance.transcriptUrl.trim()) {
    return true;
  }
  if (typeof provenance.commitSha === 'string' && provenance.commitSha.trim()) {
    return true;
  }
  if (typeof provenance.commitDiffPatch === 'string' && provenance.commitDiffPatch.trim()) {
    return true;
  }
  if (typeof provenance.commitDiffPatchSha256 === 'string' && provenance.commitDiffPatchSha256.trim()) {
    return true;
  }
  if (provenance.commitDiffPatchTruncated === true) {
    return true;
  }
  if (
    typeof provenance.commitDiffPatchOriginalChars === 'number' &&
    Number.isFinite(provenance.commitDiffPatchOriginalChars) &&
    provenance.commitDiffPatchOriginalChars > 0
  ) {
    return true;
  }
  if (provenance.contextResolution === 'branch_fallback' || provenance.contextResolution === 'direct') {
    return true;
  }
  if (
    typeof provenance.contextResolutionOriginalCheckpointId === 'string' &&
    provenance.contextResolutionOriginalCheckpointId.trim()
  ) {
    return true;
  }
  if (
    typeof provenance.contextResolutionResolvedCheckpointId === 'string' &&
    provenance.contextResolutionResolvedCheckpointId.trim()
  ) {
    return true;
  }
  if (
    typeof provenance.contextResolutionResolvedCommitSha === 'string' &&
    provenance.contextResolutionResolvedCommitSha.trim()
  ) {
    return true;
  }
  if (
    typeof provenance.contextResolutionResolvedCommitMessage === 'string' &&
    provenance.contextResolutionResolvedCommitMessage.trim()
  ) {
    return true;
  }
  if (Array.isArray(provenance.sessionIds) && provenance.sessionIds.some((item) => typeof item === 'string' && item.trim())) {
    return true;
  }
  if (
    Array.isArray(provenance.intentSessionContext) &&
    provenance.intentSessionContext.some((item) => typeof item === 'string' && item.trim())
  ) {
    return true;
  }
  if (normalizeLocalCochange(provenance.localCochange)) {
    return true;
  }
  return false;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function handleCreateReview(
  request: Request,
  env: Env,
  _ctx?: ExecutionContext,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: true, isAuthenticated: false, isHostedMode: false } as const);
  try {
    if (!env.REVIEWS_QUEUE || !env.ReviewRunner) {
      return jsonResponse(
        {
          error: 'Review runner is unavailable',
          code: 'review_runner_unavailable',
        },
        503
      );
    }

    const idempotencyKey = (request.headers.get('Idempotency-Key') ?? '').trim();
    if (!idempotencyKey) {
      return jsonResponse({ error: 'Missing required Idempotency-Key header' }, 400);
    }
    if (effectiveAuthContext.isHostedMode && new URL(request.url).protocol !== 'https:') {
      return jsonResponse({ error: 'Hosted review requests must use HTTPS' }, 400);
    }
    const reviewGithubToken = readReviewGithubTokenHeader(request);
    const openrouterApiKey = readOpenrouterApiKeyHeader(request);
    const workerGithubToken = readWorkerReviewGithubToken(env);

    const payloadRaw = await request.text();
    const payload = payloadRaw.trim() ? (JSON.parse(payloadRaw) as unknown) : {};
    if (!isRecord(payload)) {
      return jsonResponse({ error: 'Request body must be a JSON object' }, 400);
    }

    const target = isRecord(payload.target) ? payload.target : null;
    if (!target) {
      return jsonResponse({ error: 'target is required' }, 400);
    }

    const targetType = typeof target.type === 'string' ? target.type.trim() : '';
    if (targetType !== 'workspace_deployment') {
      return jsonResponse(
        {
          error: 'Unsupported review target',
          code: 'unsupported_review_target',
          allowedTargets: ['workspace_deployment'],
        },
        400
      );
    }

    const workspaceId = typeof target.workspaceId === 'string' ? target.workspaceId.trim() : '';
    const deploymentId = typeof target.deploymentId === 'string' ? target.deploymentId.trim() : '';
    if (!workspaceId || !deploymentId) {
      return jsonResponse({ error: 'target.workspaceId and target.deploymentId are required' }, 400);
    }

    const workspaceAccessResponse = await requireWorkspaceAccess(env, workspaceId, effectiveAuthContext);
    if (workspaceAccessResponse) {
      return workspaceAccessResponse;
    }

    const mode = typeof payload.mode === 'string' && payload.mode.trim() ? payload.mode.trim() : 'report_only';
    if (mode !== 'report_only') {
      return jsonResponse(
        {
          error: 'Unsupported review mode',
          code: 'unsupported_review_mode',
          allowedModes: ['report_only'],
        },
        400
      );
    }

    const policy = isRecord(payload.policy) ? payload.policy : {};
    const format = isRecord(payload.format) ? payload.format : {};
    const provenance = isRecord(payload.provenance) ? payload.provenance : {};
    if (payload.model !== undefined && (typeof payload.model !== 'string' || !payload.model.trim())) {
      return jsonResponse({ error: 'model must be a non-empty string when provided' }, 400);
    }
    const model = typeof payload.model === 'string' ? payload.model.trim() : undefined;
    const severityThresholdValue =
      typeof policy.severityThreshold === 'string' ? policy.severityThreshold.trim() : policy.severityThreshold;
    if (severityThresholdValue !== undefined && !isSeverityThreshold(severityThresholdValue)) {
      return jsonResponse(
        {
          error: 'Invalid policy.severityThreshold',
          code: 'invalid_review_policy',
          allowedSeverityThresholds: ['low', 'medium', 'high', 'critical'],
        },
        400
      );
    }
    const { requestPayload, idempotencyPayload } = buildReviewRequestPayload({
      workspaceId,
      deploymentId,
      policy,
      format,
      provenance,
      model,
    });
    const requestProvenance: Record<string, unknown> = isRecord(requestPayload.provenance) ? requestPayload.provenance : {};
    const hasLocalCochange = isRecord(requestProvenance.localCochange);
    if (!reviewGithubToken && !workerGithubToken && !hasLocalCochange) {
      return jsonResponse(
        { error: 'co-change retrieval requires a GitHub token - set REVIEW_CONTEXT_GITHUB_TOKEN in your local .env' },
        400
      );
    }
    const sanitizedRequestPayload = stripSensitiveTokenFields(requestPayload) as Record<string, unknown>;

    const requestPayloadSha256 = await sha256Hex(JSON.stringify(idempotencyPayload));
    const requestPayloadSha256Aliases: string[] = [];
    if (!hasExtendedReviewIdempotencyInputs({ provenance, model })) {
      const legacyRequestPayloadSha256 = await sha256Hex(
        JSON.stringify(buildLegacyReviewRequestPayload({ workspaceId, deploymentId, policy, format }))
      );
      if (legacyRequestPayloadSha256 !== requestPayloadSha256) {
        requestPayloadSha256Aliases.push(legacyRequestPayloadSha256);
      }
    }
    const existingReview = await getReviewRunByIdempotency(
      env.DB,
      workspaceId,
      idempotencyKey,
      requestPayloadSha256,
      requestPayloadSha256Aliases
    );
    if (existingReview) {
      const created = { review: existingReview, reused: true };

      if (created.review.status === 'queued') {
        const alreadyEnqueued = await hasReviewEvent(env.DB, created.review.id, 'review_enqueued');
        const shouldReenqueueRecoveredReview =
          created.reused && (created.review.error?.code === 'retry_scheduled' || created.review.attemptCount > 0);
        if (!alreadyEnqueued || shouldReenqueueRecoveredReview) {
          await env.REVIEWS_QUEUE.send(createReviewQueueMessage(created.review.id, reviewGithubToken, openrouterApiKey));

          await appendReviewEvent(env.DB, {
            reviewId: created.review.id,
            eventType: 'review_enqueued',
            payload: {
              mode: 'queue',
              reused: created.reused,
              recovered: shouldReenqueueRecoveredReview,
            },
          });
        }
      }

      return jsonResponse(
        {
          reviewId: created.review.id,
          status: created.review.status,
          eventsUrl: `/api/reviews/${created.review.id}/events`,
          resultUrl: `/api/reviews/${created.review.id}`,
        },
        200
      );
    }

    const workspace = await getWorkspace(env.DB, workspaceId);
    if (!workspace || workspace.status === 'deleted') {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const workspaceAccountId = await getWorkspaceAccountId(env.DB, workspaceId);
    if (workspaceAccountId === undefined) {
      return jsonResponse({ error: 'Workspace not found' }, 404);
    }

    const deployment = await getWorkspaceDeployment(env.DB, workspaceId, deploymentId);
    if (!deployment) {
      return jsonResponse({ error: 'Deployment not found' }, 404);
    }
    if (deployment.status !== 'succeeded') {
      return jsonResponse(
        {
          error: 'Review target deployment must be succeeded',
          code: 'deployment_not_reviewable',
        },
        409
      );
    }

    const created = await createReviewRun(env.DB, {
      id: generateReviewRunId(),
      workspaceId,
      deploymentId,
      targetType: 'workspace_deployment',
      mode: 'report_only',
      idempotencyKey,
      requestPayload: sanitizedRequestPayload,
      requestPayloadSha256,
      requestPayloadSha256Aliases,
      accountId: workspaceAccountId,
      provenance: {
        promptSummary: `Review deployment ${deploymentId} for workspace ${workspaceId}`,
      },
    });

    if (!created.reused) {
      await appendReviewEvent(env.DB, {
        reviewId: created.review.id,
        eventType: 'review_created',
        payload: {
          workspaceId,
          deploymentId,
          mode: 'report_only',
        },
      });
    }

    if (created.review.status === 'queued') {
      const alreadyEnqueued = await hasReviewEvent(env.DB, created.review.id, 'review_enqueued');
      const shouldReenqueueRecoveredReview =
        created.reused && (created.review.error?.code === 'retry_scheduled' || created.review.attemptCount > 0);
      if (!alreadyEnqueued || shouldReenqueueRecoveredReview) {
        await env.REVIEWS_QUEUE.send(createReviewQueueMessage(created.review.id, reviewGithubToken, openrouterApiKey));

        await appendReviewEvent(env.DB, {
          reviewId: created.review.id,
          eventType: 'review_enqueued',
          payload: {
            mode: 'queue',
            reused: created.reused,
            recovered: shouldReenqueueRecoveredReview,
          },
        });
      }
    }

    return jsonResponse(
      {
        reviewId: created.review.id,
        status: created.review.status,
        eventsUrl: `/api/reviews/${created.review.id}/events`,
        resultUrl: `/api/reviews/${created.review.id}`,
      },
      created.reused ? 200 : 202
    );
  } catch (error) {
    if (error instanceof ReviewIdempotencyConflictError) {
      return jsonResponse(
        {
          error: 'Idempotency key has already been used with different payload',
          code: 'idempotency_key_conflict',
        },
        409
      );
    }

    if (error instanceof SyntaxError) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Failed to create review: ${message}` }, 500);
  }
}

export async function handleGetReview(reviewId: string, env: Env, authContext?: AuthContext): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: true, isAuthenticated: false, isHostedMode: false } as const);
  const reviewAccessResponse = await requireReviewAccess(env, reviewId, effectiveAuthContext);
  if (reviewAccessResponse) {
    return reviewAccessResponse;
  }

  let review = await getReviewRun(env.DB, reviewId);
  if (!review) {
    return jsonResponse({ error: 'Review not found' }, 404);
  }

  await recoverStaleRunningReviewIfNeeded(env, reviewId, review);
  review = await getReviewRun(env.DB, reviewId);
  if (!review) {
    return jsonResponse({ error: 'Review not found' }, 404);
  }

  return jsonResponse({ review });
}

export async function handleGetReviewEvents(
  reviewId: string,
  request: Request,
  env: Env,
  authContext?: AuthContext
): Promise<Response> {
  const effectiveAuthContext =
    authContext ??
    ({ accountId: 'self-hosted', isAdmin: true, isAuthenticated: false, isHostedMode: false } as const);
  try {
    const reviewAccessResponse = await requireReviewAccess(env, reviewId, effectiveAuthContext);
    if (reviewAccessResponse) {
      return reviewAccessResponse;
    }

    const review = await getReviewRun(env.DB, reviewId);
    if (!review) {
      return jsonResponse({ error: 'Review not found' }, 404);
    }

    const fromSeq = resolveFromSequence(request);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        try {
          let cursor = fromSeq;
          let currentStatus = review.status;
          let lastHeartbeatAt = Date.now();
          let sawTerminalEvent = false;
          let terminalGraceDeadline: number | null = null;
          let pollCount = 0;

          const isTerminalEventType = (eventType: string): boolean => {
            return eventType === 'review_succeeded' || eventType === 'review_failed' || eventType === 'review_cancelled';
          };

          const statusFromTerminalEventType = (eventType: string): ReviewRunStatus | null => {
            if (eventType === 'review_succeeded') {
              return 'succeeded';
            }
            if (eventType === 'review_failed') {
              return 'failed';
            }
            if (eventType === 'review_cancelled') {
              return 'cancelled';
            }
            return null;
          };

          const write = (chunk: string): void => {
            controller.enqueue(encoder.encode(chunk));
          };

          const writePersistedEvents = async (): Promise<void> => {
            const persistedEvents = await listReviewEvents(env.DB, reviewId, cursor);
            for (const item of persistedEvents) {
              cursor = item.seq;
              if (isTerminalEventType(item.eventType)) {
                sawTerminalEvent = true;
                currentStatus = statusFromTerminalEventType(item.eventType) ?? currentStatus;
              }
              write(
                formatSseDataWithId(item.seq, {
                  type: item.eventType,
                  reviewId,
                  seq: item.seq,
                  createdAt: item.createdAt,
                  ...(isRecord(item.payload) ? item.payload : { value: item.payload }),
                })
              );
            }
          };

          await writePersistedEvents();
          write(
            formatSseData({
              type: 'snapshot',
              reviewId,
              status: currentStatus,
            })
          );

          while (currentStatus === 'queued' || currentStatus === 'running') {
            await sleep(REVIEW_STREAM_POLL_INTERVAL_MS);
            pollCount += 1;
            await writePersistedEvents();

            if (pollCount % REVIEW_STREAM_STATUS_REFRESH_POLLS === 0) {
              const latest = await getReviewRun(env.DB, reviewId);
              if (!latest) {
                write(
                  formatSseData({
                    type: 'error',
                    reviewId,
                    message: 'Review not found during event stream',
                  })
                );
                break;
              }
              await recoverStaleRunningReviewIfNeeded(env, reviewId, latest);
              const refreshed = await getReviewRun(env.DB, reviewId);
              currentStatus = refreshed?.status ?? latest.status;
            }

            if (currentStatus !== 'queued' && currentStatus !== 'running' && terminalGraceDeadline === null) {
              terminalGraceDeadline = Date.now() + REVIEW_TERMINAL_EVENT_GRACE_MS;
            }
            if (currentStatus !== 'queued' && currentStatus !== 'running' && sawTerminalEvent) {
              break;
            }
            if (terminalGraceDeadline !== null && Date.now() >= terminalGraceDeadline) {
              break;
            }
            if (Date.now() - lastHeartbeatAt >= REVIEW_STREAM_HEARTBEAT_INTERVAL_MS) {
              write(
                formatSseData({
                  type: 'heartbeat',
                  reviewId,
                  status: currentStatus,
                })
              );
              lastHeartbeatAt = Date.now();
            }
          }

          const terminal = await getReviewRun(env.DB, reviewId);
          if (terminal) {
            await writePersistedEvents();
            write(
              formatSseData({
                type: 'terminal',
                reviewId,
                status: terminal.status,
              })
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          controller.enqueue(
            encoder.encode(
              formatSseData({
                type: 'error',
                reviewId,
                message,
              })
            )
          );
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
}
