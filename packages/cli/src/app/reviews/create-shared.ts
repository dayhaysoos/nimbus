import { createHash } from 'crypto';
import type { ReviewEventEnvelope, ReviewGetResponse, ReviewSessionGetResponse, ReviewSessionResponse } from '../../lib/types.js';
import type { createReview } from '../../clients/worker/reviews.js';
import { detectRepoSlugFromGitOrigin } from '../../lib/git.js';
import { GitRepo } from '../../lib/checkpoint/git.js';

export const MAX_COMMIT_DIFF_PATCH_CHARS = 120_000;
export const COCHANGE_LOOKBACK_SESSIONS = 5;
export const COCHANGE_TOP_N = 20;

export type ReviewCreateProvenance = NonNullable<Parameters<typeof createReview>[2]['provenance']>;

function readRecordString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

export function isExpectedLocalCochangeResolutionError(message: string): boolean {
  return (
    /not a git repository/i.test(message) ||
    /unable to resolve entire checkpoints branch reference/i.test(message) ||
    /failed to resolve git repository/i.test(message) ||
    /unknown revision/i.test(message) ||
    /bad revision/i.test(message)
  );
}

export function parseChangedPathsFromDiff(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+++ ')) {
      continue;
    }
    const raw = line.slice(4).trim();
    if (!raw || raw === '/dev/null') {
      continue;
    }
    const normalized = raw.replace(/^b\//, '').replace(/^\.\//, '').trim();
    if (!normalized || normalized === '/dev/null') {
      continue;
    }
    paths.add(normalized);
  }
  return Array.from(paths);
}

export function buildIdempotencyKey(workspaceId: string, deploymentId: string): string {
  const seed = `${workspaceId}:${deploymentId}:${Date.now()}:${Math.random()}`;
  return `review-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

function normalizeProjectRootForIdempotency(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.') {
    return '.';
  }

  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '') || '.';
}

function normalizeBranchRefForProvenance(value: string): string | null {
  const normalized = value.trim().replace(/^refs\/heads\//, '');
  if (!normalized) {
    return null;
  }
  if (/[\s~^:?*\[\\]/.test(normalized) || normalized.includes('..') || normalized.includes('@{')) {
    return null;
  }
  if (!/^[A-Za-z0-9._\/-]+$/.test(normalized)) {
    return null;
  }
  if (
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.startsWith('.') ||
    normalized.endsWith('.') ||
    normalized.includes('//') ||
    normalized.includes('/.') ||
    normalized.includes('./') ||
    normalized.endsWith('.lock')
  ) {
    return null;
  }
  return normalized;
}

/**
 * Resolves git provenance required by worker review creation.
 * Falls back to GITHUB_HEAD_REF when local branch detection is unavailable (for CI detached-head runs).
 */
export function resolveReviewGitProvenance(cwd = process.cwd()): { repo: string; branch: string } {
  let branchCandidate = '';
  try {
    branchCandidate = new GitRepo(cwd).getCurrentBranchRef() ?? '';
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve current git branch: ${details}`);
  }

  let branch = normalizeBranchRefForProvenance(branchCandidate);

  if (!branch) {
    const githubHeadRef = typeof process.env.GITHUB_HEAD_REF === 'string' ? process.env.GITHUB_HEAD_REF.trim() : '';
    if (githubHeadRef) {
      branch = normalizeBranchRefForProvenance(githubHeadRef);
      if (!branch) {
        throw new Error(`GITHUB_HEAD_REF is present but invalid for branch provenance: ${githubHeadRef}`);
      }
    }
  }

  if (!branch) {
    throw new Error(
      'Could not resolve current git branch (git branch detection failed and GITHUB_HEAD_REF not set). In GitHub Actions, ensure GITHUB_HEAD_REF is available in the workflow environment.'
    );
  }

  let repo = '';
  try {
    repo = detectRepoSlugFromGitOrigin(cwd);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve git repo slug from origin: ${details}`);
  }

  return { repo: repo.trim(), branch };
}

export function buildStudioSessionRoutePath(options: {
  sessionId: string;
  reviewId?: string | null;
  repo?: string | null;
  branch?: string | null;
}): string {
  const sessionId = encodeURIComponent(options.sessionId);
  return `/sessions/${sessionId}`;
}

export function formatReviewExecutionFailure(
  status: string,
  finalReview: { error?: { code: string; message: string } },
  lastFailureEvent: Record<string, unknown> | null
): string {
  const details: string[] = [];

  if (finalReview.error?.code && finalReview.error?.message) {
    details.push(`${finalReview.error.code}: ${finalReview.error.message}`);
  }

  if (lastFailureEvent) {
    const eventType = readRecordString(lastFailureEvent, 'type');
    const reason = readRecordString(lastFailureEvent, 'reason');
    const githubResponseBody = readRecordString(lastFailureEvent, 'githubResponseBody');
    const code = readRecordString(lastFailureEvent, 'code');
    const message = readRecordString(lastFailureEvent, 'message');

    if (eventType) {
      details.push(`event=${eventType}`);
    }
    if (reason) {
      details.push(`reason=${reason}`);
    }
    if (code && message) {
      details.push(`${code}: ${message}`);
    }
    if (githubResponseBody) {
      details.push(`details=${githubResponseBody}`);
    }
  }

  if (details.length === 0) {
    return `Review flow failed at review execution: review ended with status ${status}`;
  }

  return `Review flow failed at review execution: review ended with status ${status} (${details.join(' | ')})`;
}

export function buildWorkspaceIdempotencyKey(input: {
  repo: string;
  commitSha: string;
  checkpointId: string | null;
  projectRoot: string;
}): string {
  const seed = JSON.stringify({
    repo: input.repo.trim().toLowerCase(),
    commitSha: input.commitSha.trim().toLowerCase(),
    checkpointId: input.checkpointId?.trim().toLowerCase() || null,
    projectRoot: normalizeProjectRootForIdempotency(input.projectRoot),
  });

  return `workspace-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

export function deriveIdempotencyKey(base: string, scope: 'workspace' | 'deploy' | 'review'): string {
  return `${scope}-${createHash('sha256').update(`${base}:${scope}`).digest('hex').slice(0, 20)}`;
}

export function normalizeResultUrl(workerUrl: string, resultUrl: string): string {
  try {
    return new URL(resultUrl, workerUrl).toString();
  } catch {
    return resultUrl;
  }
}

function isTerminalReviewStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function isInProgressReviewStatus(status: string): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'policy_approved'
  );
}

async function pollReviewUntilTerminalStatus(
  getReview: (workerUrl: string, reviewId: string) => Promise<ReviewGetResponse>,
  workerUrl: string,
  reviewId: string,
  options?: { intervalMs?: number; timeoutMs?: number }
): Promise<ReviewGetResponse> {
  const intervalMs =
    typeof options?.intervalMs === 'number' && Number.isFinite(options.intervalMs)
      ? Math.max(1_000, Math.min(10_000, Math.floor(options.intervalMs)))
      : 2_000;
  const timeoutMs =
    typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(10_000, Math.min(30 * 60_000, Math.floor(options.timeoutMs)))
      : 10 * 60_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const latest = await getReview(workerUrl, reviewId);
    if (!isInProgressReviewStatus(latest.review.status)) {
      return latest;
    }
    if (Date.now() >= deadline) {
      return latest;
    }
    await sleep(intervalMs);
  }
}

function resolveFollowupReviewId(
  session: ReviewSessionResponse | undefined,
  currentReviewId: string,
  options?: { minimumPassCount?: number }
): string | null {
  if (!session) {
    return null;
  }

  if (
    session.activeReviewId &&
    session.activeReviewId !== currentReviewId &&
    (session.currentReviewStatus === 'policy_pending' ||
      session.currentReviewStatus === 'policy_ready' ||
      session.currentReviewStatus === 'policy_approved' ||
      session.currentReviewStatus === 'queued' ||
      session.currentReviewStatus === 'running')
  ) {
    return session.activeReviewId;
  }

  const currentPassIndex = session.passes.findIndex((pass) => pass.reviewId === currentReviewId);
  if (currentPassIndex >= 0 && currentPassIndex < session.passes.length - 1) {
    return session.passes[currentPassIndex + 1]?.reviewId ?? null;
  }

  if (
    session.latestReviewId &&
    session.latestReviewId !== currentReviewId &&
    (
      (typeof options?.minimumPassCount === 'number' && session.passCount > options.minimumPassCount) ||
      session.passCount > session.passes.length
    )
  ) {
    return session.latestReviewId;
  }

  return null;
}

function shouldWaitForSessionSettlement(session: ReviewSessionResponse | undefined, currentReviewId: string): boolean {
  if (!session) {
    return false;
  }

  if (session.latestReviewId !== currentReviewId) {
    return false;
  }

  if (session.stopReason || session.finishedAt) {
    return false;
  }

  return true;
}

function reviewMayAdvanceSession(finalReview: ReviewGetResponse): boolean {
  const totalFindingCount = Object.values(finalReview.review.summary?.findingCounts ?? {}).reduce((sum, value) => {
    return sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);
  const followUpReviewScore =
    (
      finalReview.review.provenance as
        | {
            validation?: {
              followUpReviewScore?: unknown;
            };
          }
        | undefined
    )?.validation?.followUpReviewScore;
  const recommendation = finalReview.review.summary?.recommendation;
  const hasExplicitNonApproveRecommendation =
    typeof recommendation === 'string' && recommendation.trim().length > 0 && recommendation !== 'approve';
  return (
    finalReview.review.status === 'succeeded' &&
    (
      (Array.isArray(finalReview.review.findings) && finalReview.review.findings.length > 0) ||
      totalFindingCount > 0 ||
      hasExplicitNonApproveRecommendation ||
      followUpReviewScore === 2 ||
      followUpReviewScore === 3
    )
  );
}

async function waitForSessionFollowup(input: {
  workerUrl: string;
  sessionId: string;
  currentReviewId: string;
  minimumPassCount: number | null;
  allowTransientInitialPassCompletion?: boolean;
  getReviewSession: (workerUrl: string, sessionId: string) => Promise<ReviewSessionGetResponse>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{ nextReviewId: string | null; session: ReviewSessionResponse | null; warning?: string; continuationPending?: boolean }> {
  const intervalMs =
    typeof input.pollIntervalMs === 'number' && Number.isFinite(input.pollIntervalMs)
      ? Math.max(1_000, Math.min(10_000, Math.floor(input.pollIntervalMs)))
      : 2_000;
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(10_000, Math.min(30 * 60_000, Math.floor(input.timeoutMs)))
      : 3 * 60_000;
  const deadline = Date.now() + timeoutMs;
  let minimumPassCount = input.minimumPassCount;
  let latestSession: ReviewSessionResponse | null = null;
  let successfulReads = 0;
  let readErrorCount = 0;
  let lastReadErrorMessage: string | null = null;
  let settledInitialPassProbeCount = 0;
  const maxSettledInitialPassProbes = 2;
  let settledInitialPassReadErrorRetryUsed = false;
  const settlingTimeoutWarning =
    'Review session is still settling; a follow-up pass may appear shortly. Re-run `nimbus review events` to continue watching.';

  while (true) {
    try {
      const response = await input.getReviewSession(input.workerUrl, input.sessionId);
      latestSession = response.session;
      successfulReads += 1;
    } catch (error) {
      readErrorCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      lastReadErrorMessage = `Failed to read review session state while awaiting follow-up pass: ${message}`;
      if (latestSession) {
        const isInitialPassCompletionWithoutAdvance = Boolean(
          input.allowTransientInitialPassCompletion &&
            latestSession.latestReviewId === input.currentReviewId &&
            (minimumPassCount === null || latestSession.passCount <= minimumPassCount) &&
            latestSession.stopReason === 'initial_pass_completed'
        );
        const shouldRetrySettledProbeAfterReadError = Boolean(
          isInitialPassCompletionWithoutAdvance &&
            latestSession.finishedAt &&
            !latestSession.activeReviewId &&
            settledInitialPassProbeCount > 0 &&
            !settledInitialPassReadErrorRetryUsed
        );
        if (shouldRetrySettledProbeAfterReadError) {
          settledInitialPassReadErrorRetryUsed = true;
        }
        const shouldContinueTransientGrace = Boolean(isInitialPassCompletionWithoutAdvance && !latestSession.finishedAt);
        const shouldContinueWaiting =
          shouldWaitForSessionSettlement(latestSession, input.currentReviewId) ||
          shouldContinueTransientGrace ||
          shouldRetrySettledProbeAfterReadError;
        if (!shouldContinueWaiting) {
          return {
            nextReviewId: null,
            session: latestSession,
            warning: lastReadErrorMessage,
          };
        }
      }
      if (Date.now() >= deadline) {
        const continuationPending = Boolean(latestSession && shouldWaitForSessionSettlement(latestSession, input.currentReviewId));
        return {
          nextReviewId: null,
          session: latestSession,
          continuationPending,
          ...(readErrorCount > 0 && successfulReads === 0
            ? { warning: lastReadErrorMessage ?? undefined }
            : continuationPending
              ? { warning: settlingTimeoutWarning }
              : {}),
        };
      }
      await sleep(intervalMs);
      continue;
    }
    const nextReviewId = resolveFollowupReviewId(latestSession, input.currentReviewId, {
      minimumPassCount: minimumPassCount ?? 0,
    });
    if (nextReviewId) {
      return { nextReviewId, session: latestSession };
    }
    const isInitialPassCompletionWithoutAdvance = Boolean(
      input.allowTransientInitialPassCompletion &&
        latestSession?.latestReviewId === input.currentReviewId &&
        (minimumPassCount === null || latestSession.passCount <= minimumPassCount) &&
        latestSession.stopReason === 'initial_pass_completed'
    );
    const shouldProbeSettledInitialPass = Boolean(
      isInitialPassCompletionWithoutAdvance &&
        latestSession?.finishedAt &&
        !latestSession.activeReviewId &&
        settledInitialPassProbeCount < maxSettledInitialPassProbes
    );
    if (shouldProbeSettledInitialPass) {
      settledInitialPassProbeCount += 1;
    }
    const shouldContinueWaiting =
      shouldWaitForSessionSettlement(latestSession, input.currentReviewId) ||
      (isInitialPassCompletionWithoutAdvance && !latestSession?.finishedAt) ||
      shouldProbeSettledInitialPass;
    if (!shouldContinueWaiting) {
      const returnWarning = readErrorCount > 0 ? (lastReadErrorMessage ?? undefined) : undefined;
      return { nextReviewId: null, session: latestSession, warning: returnWarning };
    }
    if (Date.now() >= deadline) {
      const continuationPending = shouldContinueWaiting;
      return {
        nextReviewId: null,
        session: latestSession,
        continuationPending,
        ...(readErrorCount > 0 && successfulReads === 0
          ? { warning: lastReadErrorMessage ?? 'Failed to read review session state while awaiting follow-up pass.' }
          : continuationPending
            ? { warning: settlingTimeoutWarning }
            : {}),
      };
    }
    await sleep(intervalMs);
  }
}

export async function followReviewChain(input: {
  workerUrl: string;
  initialReviewId: string;
  initialResultUrl: string;
  streamReviewEvents: (workerUrl: string, reviewId: string, onEvent: (event: ReviewEventEnvelope) => void | Promise<void>) => Promise<void>;
  getReview: (workerUrl: string, reviewId: string) => Promise<ReviewGetResponse>;
  getReviewSession?: (workerUrl: string, sessionId: string) => Promise<ReviewSessionGetResponse>;
  formatEvent: (event: ReviewEventEnvelope) => string;
  onStreamWarning?: (message: string) => void;
  onFollowupReview?: (reviewId: string) => void;
  pollIntervalMs?: number;
}): Promise<{
  finalReviewId: string;
  finalReview: ReviewGetResponse;
  finalSession: ReviewSessionResponse | null;
  finalResultUrl: string;
  lastFailureEvent: Record<string, unknown> | null;
  sessionContinuationPending: boolean;
}> {
  let currentReviewId = input.initialReviewId;
  let currentResultUrl = input.initialResultUrl;
  let lastFailureEvent: Record<string, unknown> | null = null;
  let latestObservedSession: ReviewSessionResponse | null = null;

  while (true) {
    let terminalStatus: string | null = null;
    let nextReviewId: string | null = null;
    let streamErrorMessage: string | null = null;

    try {
      await input.streamReviewEvents(input.workerUrl, currentReviewId, async (event) => {
        const data = event.data ?? {};
        if (
          data.type === 'review_context_cochange_failed' ||
          data.type === 'review_context_assembly_failed' ||
          data.type === 'review_failed' ||
          data.type === 'error'
        ) {
          lastFailureEvent = data;
        }
        if (data.type === 'review_auto_remediation_completed' && typeof data.nextReviewId === 'string' && data.nextReviewId.trim()) {
          nextReviewId = data.nextReviewId.trim();
        }
        if (data.type === 'terminal' && typeof data.status === 'string') {
          terminalStatus = data.status;
        }
        const line = input.formatEvent(event);
        if (line) {
          console.log(line);
        }
      });
    } catch (error) {
      streamErrorMessage = error instanceof Error ? error.message : String(error);
      input.onStreamWarning?.(`Event stream interrupted before terminal status: ${streamErrorMessage}`);
    }

    let finalReview = await input.getReview(input.workerUrl, currentReviewId);
    latestObservedSession = finalReview.session ?? latestObservedSession;
    const reviewStillInProgress = isInProgressReviewStatus(finalReview.review.status);
    if (reviewStillInProgress && (!terminalStatus || terminalStatus === 'succeeded')) {
      input.onStreamWarning?.('Review status has not settled yet; falling back to status polling.');
      finalReview = await pollReviewUntilTerminalStatus(input.getReview, input.workerUrl, currentReviewId, {
        intervalMs: input.pollIntervalMs,
        timeoutMs: finalReview.review.status === 'policy_approved' ? 30_000 : undefined,
      });
    }

    const status = isTerminalReviewStatus(finalReview.review.status)
      ? finalReview.review.status
      : typeof terminalStatus === 'string'
        ? terminalStatus
        : finalReview.review.status;
    if (status !== 'succeeded') {
      return {
        finalReviewId: currentReviewId,
        finalReview,
        finalSession: latestObservedSession,
        finalResultUrl: currentResultUrl,
        lastFailureEvent,
        sessionContinuationPending: false,
      };
    }

    const sessionId = finalReview.review.sessionId ?? finalReview.session?.id ?? null;
    if (!nextReviewId) {
      nextReviewId = resolveFollowupReviewId(finalReview.session, currentReviewId);
    }
    const shouldReadSessionForFollowup =
      Boolean(sessionId && input.getReviewSession) &&
      (!finalReview.session ||
        shouldWaitForSessionSettlement(finalReview.session, currentReviewId) ||
        reviewMayAdvanceSession(finalReview));
    if (!nextReviewId && shouldReadSessionForFollowup && sessionId && input.getReviewSession) {
      const awaitedSession = await waitForSessionFollowup({
        workerUrl: input.workerUrl,
        sessionId,
        currentReviewId,
        minimumPassCount: typeof finalReview.session?.passCount === 'number' ? finalReview.session.passCount : null,
        allowTransientInitialPassCompletion: reviewMayAdvanceSession(finalReview),
        getReviewSession: input.getReviewSession,
        pollIntervalMs: input.pollIntervalMs,
      });
      if (awaitedSession.warning) {
        input.onStreamWarning?.(awaitedSession.warning);
      }
      latestObservedSession = awaitedSession.session ?? latestObservedSession;
      nextReviewId = awaitedSession.nextReviewId;
      if (!nextReviewId && awaitedSession.continuationPending) {
        return {
          finalReviewId: currentReviewId,
          finalReview,
          finalSession: latestObservedSession,
          finalResultUrl: currentResultUrl,
          lastFailureEvent,
          sessionContinuationPending: true,
        };
      }
    }

    if (!nextReviewId || nextReviewId === currentReviewId) {
      return {
        finalReviewId: currentReviewId,
        finalReview,
        finalSession: latestObservedSession,
        finalResultUrl: currentResultUrl,
        lastFailureEvent,
        sessionContinuationPending: false,
      };
    }

    currentReviewId = nextReviewId;
    currentResultUrl = normalizeResultUrl(input.workerUrl, `/api/reviews/${encodeURIComponent(nextReviewId)}`);
    input.onFollowupReview?.(nextReviewId);
  }
}

export function normalizeCommitDiffPatch(patch: string): {
  patch: string;
  sha256: string;
  truncated: boolean;
  originalChars: number;
} {
  const originalChars = patch.length;
  const sha256 = createHash('sha256').update(patch).digest('hex');
  if (originalChars <= MAX_COMMIT_DIFF_PATCH_CHARS) {
    return {
      patch,
      sha256,
      truncated: false,
      originalChars,
    };
  }

  return {
    patch: `${patch.slice(0, MAX_COMMIT_DIFF_PATCH_CHARS)}\n\n[... NIMBUS TRUNCATED COMMIT PATCH ...]\n`,
    sha256,
    truncated: true,
    originalChars,
  };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
