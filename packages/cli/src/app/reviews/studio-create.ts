import { approveReviewPolicy, deriveReviewPolicy } from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { validateReviewCommitCheckpoint, validateReviewEntireIntentContext } from '../../commands/review/preflight.js';
import { resolveReviewContext } from './context.js';
import { resolveReviewGitProvenance } from './create-shared.js';
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

export async function resolveStudioNewReviewPreflight(): Promise<StudioNewReviewPreflightResult> {
  const preferences = await readStudioPreferences();
  const policyMode = normalizeStudioPolicyMode(preferences.policyMode);
  let repo: string | null = null;
  let branch: string | null = null;
  try {
    const gitProvenance = resolveReviewGitProvenance();
    repo = gitProvenance.repo;
    branch = gitProvenance.branch;
  } catch {
    repo = null;
    branch = null;
  }

  let commitSha: string | null = null;
  let checkpointId: string | null = null;
  try {
    const checkpoint = validateReviewCommitCheckpoint('HEAD', process.cwd());
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
      process.cwd()
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
}): Promise<StudioNewReviewStartResult> {
  const policyMode = normalizeStudioPolicyMode(options.policyMode);
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  await updateStudioPolicyMode(policyMode);
  const resolved = await resolveReviewContext({
    commitish: 'HEAD',
    projectRoot: '.',
  });

  if (policyMode === 'review') {
    const derived = await deriveReviewPolicy(workerUrl, {
      workspaceId: resolved.workspaceId,
      deploymentId: resolved.deploymentId,
      policyMode: 'review',
      reviewBasis: 'checkpoint',
      provenance: resolved.resolvedProvenance,
    });

    return {
      reviewId: derived.reviewId,
      routePath: `/policy/${encodeURIComponent(derived.reviewId)}`,
      policyMode,
      status: 'policy_ready',
    };
  }

  const derived = await deriveReviewPolicy(workerUrl, {
    workspaceId: resolved.workspaceId,
    deploymentId: resolved.deploymentId,
    policyMode: 'auto',
    reviewBasis: 'checkpoint',
    provenance: resolved.resolvedProvenance,
  });
  await approveReviewPolicy(workerUrl, derived.reviewId, {
    approvedPolicy: derived.derivedPolicy,
  });

  return {
    reviewId: derived.reviewId,
    routePath: `/reports/${encodeURIComponent(derived.reviewId)}`,
    policyMode,
    status: 'queued',
  };
}
