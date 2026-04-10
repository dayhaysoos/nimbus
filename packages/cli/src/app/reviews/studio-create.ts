import { approveReviewPolicy, deriveReviewPolicy } from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { validateReviewCommitCheckpoint, validateReviewEntireIntentContext } from '../../commands/review/preflight.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import { resolveReviewContext, type ResolveReviewContextProgressEvent } from './context.js';
import { buildStudioReviewRoutePath, resolveReviewGitProvenance } from './create-shared.js';
import { readStudioPreferences, updateStudioPolicyMode } from './session.js';

export type StudioReviewPolicyMode = 'auto' | 'review';

export interface StudioNewReviewPreflightResult {
  repo: string | null;
  branch: string | null;
  policyMode: StudioReviewPolicyMode;
  lastCheckpoints: 1 | 2 | 3;
  checkpointSelectionMode: 'latest' | 'last_n';
  checkpointId: string | null;
  commitSha: string | null;
  includedCheckpoints: Array<{
    checkpointId: string;
    commitSha: string;
    commitSubject: string;
  }>;
  ready: boolean;
  checks: Array<{
    code: 'checkpoint' | 'entire_context';
    label: string;
    ok: boolean;
    detail: string;
  }>;
  error?: {
    code: 'checkpoint_unavailable' | 'entire_context_unavailable' | 'unknown';
    message: string;
  };
}

function normalizeLastCheckpoints(value: number | null | undefined): 1 | 2 | 3 {
  if (value === 1 || value === 2 || value === 3) {
    return value;
  }
  return 2;
}

export interface StudioNewReviewStartResult {
  reviewId: string;
  routePath: string;
  policyMode: StudioReviewPolicyMode;
  status: 'policy_ready' | 'queued';
}

export interface StudioNewReviewStartStageEvent {
  type: 'stage';
  stage: ResolveReviewContextProgressEvent['stage'] | 'review_creation' | 'policy';
  state: 'active' | 'completed';
  label: string;
  detail: string;
}

export interface StudioNewReviewStartCompletedEvent extends StudioNewReviewStartResult {
  type: 'completed';
  detail: string;
}

export interface StudioNewReviewStartErrorEvent {
  type: 'error';
  message: string;
}

export type StudioNewReviewStartStreamEvent =
  | StudioNewReviewStartStageEvent
  | StudioNewReviewStartCompletedEvent
  | StudioNewReviewStartErrorEvent;

function shouldAbortStudioStart(signal: AbortSignal | undefined, abortBeforeReviewCreation: boolean): boolean {
  return abortBeforeReviewCreation && Boolean(signal?.aborted);
}

function preflightErrorCode(message: string): NonNullable<StudioNewReviewPreflightResult['error']>['code'] {
  const lower = message.toLowerCase();
  if (lower.includes('entire-checkpoint trailer') || lower.includes('no entire session history')) {
    return 'checkpoint_unavailable';
  }
  if (lower.includes('entire session') || lower.includes('checkpoint context')) {
    return 'entire_context_unavailable';
  }
  return 'unknown';
}

function normalizeStudioPolicyMode(value: string | null | undefined): StudioReviewPolicyMode {
  return value === 'review' ? 'review' : 'auto';
}

function resolveStudioRepoRoot(explicitRepoRoot?: string): string {
  if (explicitRepoRoot?.trim()) {
    return explicitRepoRoot.trim();
  }
  try {
    return new GitRepo(process.cwd()).getRepoRoot();
  } catch {
    return process.cwd();
  }
}

function normalizeExpectedContextField(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function studioBranchContextMatchesExpected(
  current: { repo: string; branch: string },
  expected?: { repo?: string | null; branch?: string | null }
): boolean {
  const expectedRepo = normalizeExpectedContextField(expected?.repo);
  const expectedBranch = normalizeExpectedContextField(expected?.branch);
  if (!expectedRepo || !expectedBranch) {
    return true;
  }
  return current.repo === expectedRepo && current.branch === expectedBranch;
}

export async function resolveStudioNewReviewPreflight(options?: {
  repoRoot?: string;
  lastCheckpoints?: number;
}): Promise<StudioNewReviewPreflightResult> {
  const repoRoot = resolveStudioRepoRoot(options?.repoRoot);
  const lastCheckpoints = normalizeLastCheckpoints(options?.lastCheckpoints ?? null);
  const preferences = await readStudioPreferences({ repoRoot });
  const policyMode = normalizeStudioPolicyMode(preferences.policyMode);
  let repo: string | null = null;
  let branch: string | null = null;
  try {
    const gitProvenance = resolveReviewGitProvenance(repoRoot);
    repo = gitProvenance.repo;
    branch = gitProvenance.branch;
  } catch {
    repo = null;
    branch = null;
  }

  let commitSha: string | null = null;
  let checkpointId: string | null = null;
  let includedCheckpoints: Array<{ checkpointId: string; commitSha: string; commitSubject: string }> = [];
  let checkpointSelectionMode: 'latest' | 'last_n' = lastCheckpoints > 1 ? 'last_n' : 'latest';
  let checkpointDetail = '';
  try {
    const checkpoint = validateReviewCommitCheckpoint('HEAD', repoRoot, {
      lastCheckpoints,
    });
    commitSha = checkpoint.commitSha;
    checkpointId = checkpoint.checkpointId;
    includedCheckpoints = checkpoint.includedCheckpoints ?? [];
    checkpointSelectionMode = checkpoint.checkpointSelectionMode === 'last_n' ? 'last_n' : 'latest';
    checkpointDetail =
      checkpointSelectionMode === 'last_n'
        ? `Resolved ${includedCheckpoints.length} checkpoints ending at ${checkpointId}.`
        : `Resolved checkpoint ${checkpointId} from ${commitSha.slice(0, 12)}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repo,
      branch,
      policyMode,
      lastCheckpoints,
      checkpointSelectionMode,
      checkpointId: null,
      commitSha: null,
      includedCheckpoints: [],
      ready: false,
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint target',
          ok: false,
          detail: message,
        },
        {
          code: 'entire_context',
          label: 'Entire context',
          ok: false,
          detail: 'Blocked until checkpoint target is available.',
        },
      ],
      error: {
        code: preflightErrorCode(message),
        message,
      },
    };
  }

  try {
    const context = await validateReviewEntireIntentContext(
      {
        commitSha,
        checkpointId,
      },
      {
        summarizeSession: 'auto',
        allowBranchFallback: true,
      },
      repoRoot
    );
    const contextDetail =
      context.contextResolution === 'branch_fallback'
        ? `Using branch fallback checkpoint ${context.resolvedCheckpointId} from ${context.commitsAgo} commit(s) ago.`
        : 'Readable Entire checkpoint context found for current commit.';
    return {
      repo,
      branch,
      policyMode,
      lastCheckpoints,
      checkpointSelectionMode,
      checkpointId,
      commitSha,
      includedCheckpoints,
      ready: true,
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint target',
          ok: true,
          detail: checkpointDetail,
        },
        {
          code: 'entire_context',
          label: 'Entire context',
          ok: true,
          detail: contextDetail,
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repo,
      branch,
      policyMode,
      lastCheckpoints,
      checkpointSelectionMode,
      checkpointId,
      commitSha,
      includedCheckpoints,
      ready: false,
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint target',
          ok: true,
          detail: checkpointDetail,
        },
        {
          code: 'entire_context',
          label: 'Entire context',
          ok: false,
          detail: message,
        },
      ],
      error: {
        code: preflightErrorCode(message),
        message,
      },
    };
  }
}

export async function startStudioNewReview(options: {
  policyMode: StudioReviewPolicyMode;
  lastCheckpoints?: number;
  repoRoot?: string;
  expectedRepo?: string | null;
  expectedBranch?: string | null;
  signal?: AbortSignal;
  onEvent?: (event: StudioNewReviewStartStreamEvent) => void | Promise<void>;
}): Promise<StudioNewReviewStartResult> {
  let abortBeforeReviewCreation = true;
  const throwIfAborted = (): void => {
    if (!shouldAbortStudioStart(options.signal, abortBeforeReviewCreation)) {
      return;
    }
    const error = new Error('Studio review start aborted before completion.');
    error.name = 'AbortError';
    throw error;
  };
  const emitEvent = async (event: StudioNewReviewStartStreamEvent): Promise<void> => {
    throwIfAborted();
    try {
      await options.onEvent?.(event);
    } catch {
      // Start-flow events are best-effort only and must not abort review setup.
    }
  };

  throwIfAborted();
  const policyMode = normalizeStudioPolicyMode(options.policyMode);
  const lastCheckpoints = normalizeLastCheckpoints(options.lastCheckpoints ?? null);
  const repoRoot = resolveStudioRepoRoot(options.repoRoot);
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const gitProvenance = resolveReviewGitProvenance(repoRoot);
  if (
    !studioBranchContextMatchesExpected(gitProvenance, {
      repo: options.expectedRepo,
      branch: options.expectedBranch,
    })
  ) {
    throw new Error(
      `Studio context changed to ${gitProvenance.branch} (${gitProvenance.repo}). Switch context in Home, then retry.`
    );
  }

  await updateStudioPolicyMode(policyMode, { repoRoot });
  const resolved = await resolveReviewContext({
    commitish: 'HEAD',
    projectRoot: '.',
    lastCheckpoints,
    signal: options.signal,
    onProgress: (event) => emitEvent({
      type: 'stage',
      stage: event.stage,
      state: event.state,
      label: event.label,
      detail: event.detail,
    }),
  });
  // Once context setup produced a workspace/deployment, finish attaching it to a
  // review instead of aborting and leaving startup artifacts unattached.
  abortBeforeReviewCreation = false;

  await emitEvent({
    type: 'stage',
    stage: 'review_creation',
    state: 'active',
    label: policyMode === 'review' ? 'Creating policy review' : 'Creating review',
    detail:
      policyMode === 'review'
        ? 'Creating the review and opening the policy screen.'
        : 'Creating the review record before queueing analysis.',
  });

  if (policyMode === 'review') {
    throwIfAborted();
    const derived = await deriveReviewPolicy(workerUrl, {
      workspaceId: resolved.workspaceId,
      deploymentId: resolved.deploymentId,
      policyMode: 'review',
      reviewBasis: 'checkpoint',
      provenance: resolved.resolvedProvenance,
    });
    // Once the review exists, finish the handoff even if the client disconnects.
    abortBeforeReviewCreation = false;

    await emitEvent({
      type: 'stage',
      stage: 'review_creation',
      state: 'completed',
      label: 'Policy review ready',
      detail: `Review ${derived.reviewId} is ready for policy confirmation.`,
    });

    const result: StudioNewReviewStartResult = {
      reviewId: derived.reviewId,
      routePath: buildStudioReviewRoutePath({
        reviewId: derived.reviewId,
        route: 'policy',
        repo: resolved.resolvedProvenance.repo,
        branch: resolved.resolvedProvenance.branch,
      }),
      policyMode,
      status: 'policy_ready',
    };
    await emitEvent({
      type: 'completed',
      ...result,
      detail: 'Policy review is ready. Opening the policy screen.',
    });
    return result;
  }

  throwIfAborted();
  const derived = await deriveReviewPolicy(workerUrl, {
    workspaceId: resolved.workspaceId,
    deploymentId: resolved.deploymentId,
    policyMode: 'auto',
    reviewBasis: 'checkpoint',
    provenance: resolved.resolvedProvenance,
  });
  // Once the review exists, finish the handoff even if the client disconnects.
  abortBeforeReviewCreation = false;
  await emitEvent({
    type: 'stage',
    stage: 'review_creation',
    state: 'completed',
    label: 'Review created',
    detail: `Review ${derived.reviewId} was created and is ready to queue.`,
  });
  await emitEvent({
    type: 'stage',
    stage: 'policy',
    state: 'active',
    label: 'Approving policy',
    detail: 'Applying the derived policy so Nimbus can start analysis.',
  });
  await approveReviewPolicy(workerUrl, derived.reviewId, {
    approvedPolicy: derived.derivedPolicy,
  });
  await emitEvent({
    type: 'stage',
    stage: 'policy',
    state: 'completed',
    label: 'Review queued',
    detail: `Review ${derived.reviewId} is queued and ready to stream live activity.`,
  });

  const result: StudioNewReviewStartResult = {
    reviewId: derived.reviewId,
    routePath: buildStudioReviewRoutePath({
      reviewId: derived.reviewId,
      route: 'reports',
      repo: resolved.resolvedProvenance.repo,
      branch: resolved.resolvedProvenance.branch,
    }),
    policyMode,
    status: 'queued',
  };
  await emitEvent({
    type: 'completed',
    ...result,
    detail: 'Review queued. Opening the live results route.',
  });
  return result;
}

export function shouldAbortStudioStartForTests(
  signal: AbortSignal | undefined,
  abortBeforeReviewCreation: boolean
): boolean {
  return shouldAbortStudioStart(signal, abortBeforeReviewCreation);
}

export async function emitStudioStartEventForTests(input: {
  signal?: AbortSignal;
  onEvent?: (event: StudioNewReviewStartStreamEvent) => void | Promise<void>;
  event: StudioNewReviewStartStreamEvent;
}): Promise<void> {
  if (input.signal?.aborted) {
    const error = new Error('Studio review start aborted before completion.');
    error.name = 'AbortError';
    throw error;
  }
  try {
    await input.onEvent?.(input.event);
  } catch {
    // Best-effort only in tests as well.
  }
}
