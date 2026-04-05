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
  checkpointId: string | null;
  commitSha: string | null;
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
}): Promise<StudioNewReviewPreflightResult> {
  const repoRoot = resolveStudioRepoRoot(options?.repoRoot);
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
  try {
    const checkpoint = validateReviewCommitCheckpoint('HEAD', repoRoot);
    commitSha = checkpoint.commitSha;
    checkpointId = checkpoint.checkpointId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repo,
      branch,
      policyMode,
      checkpointId: null,
      commitSha: null,
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
      checkpointId,
      commitSha,
      ready: true,
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint target',
          ok: true,
          detail: `Resolved checkpoint ${checkpointId} from ${commitSha.slice(0, 12)}.`,
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
      checkpointId,
      commitSha,
      ready: false,
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint target',
          ok: true,
          detail: `Resolved checkpoint ${checkpointId} from ${commitSha.slice(0, 12)}.`,
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
  repoRoot?: string;
  expectedRepo?: string | null;
  expectedBranch?: string | null;
  onEvent?: (event: StudioNewReviewStartStreamEvent) => void | Promise<void>;
}): Promise<StudioNewReviewStartResult> {
  const policyMode = normalizeStudioPolicyMode(options.policyMode);
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
    onProgress: (event) => options.onEvent?.({
      type: 'stage',
      stage: event.stage,
      state: event.state,
      label: event.label,
      detail: event.detail,
    }),
  });

  await options.onEvent?.({
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
    const derived = await deriveReviewPolicy(workerUrl, {
      workspaceId: resolved.workspaceId,
      deploymentId: resolved.deploymentId,
      policyMode: 'review',
      reviewBasis: 'checkpoint',
      provenance: resolved.resolvedProvenance,
    });

    await options.onEvent?.({
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
    await options.onEvent?.({
      type: 'completed',
      ...result,
      detail: 'Policy review is ready. Opening the policy screen.',
    });
    return result;
  }

  const derived = await deriveReviewPolicy(workerUrl, {
    workspaceId: resolved.workspaceId,
    deploymentId: resolved.deploymentId,
    policyMode: 'auto',
    reviewBasis: 'checkpoint',
    provenance: resolved.resolvedProvenance,
  });
  await options.onEvent?.({
    type: 'stage',
    stage: 'review_creation',
    state: 'completed',
    label: 'Review created',
    detail: `Review ${derived.reviewId} was created and is ready to queue.`,
  });
  await options.onEvent?.({
    type: 'stage',
    stage: 'policy',
    state: 'active',
    label: 'Approving policy',
    detail: 'Applying the derived policy so Nimbus can start analysis.',
  });
  await approveReviewPolicy(workerUrl, derived.reviewId, {
    approvedPolicy: derived.derivedPolicy,
  });
  await options.onEvent?.({
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
  await options.onEvent?.({
    type: 'completed',
    ...result,
    detail: 'Review queued. Opening the live results route.',
  });
  return result;
}
