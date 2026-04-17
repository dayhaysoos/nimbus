import * as p from '@clack/prompts';
import { workspaceDeployCommand } from '../../commands/workspace/deploy.js';
import { createWorkspaceFromResolvedSource, resolveWorkspaceSource } from '../../commands/workspace/create.js';
import {
  getWorkspace as getWorkspaceFromWorker,
  WorkspaceCreateInProgressError,
} from '../../clients/worker/workspaces.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { resolveCochangeFromLocalGit } from '../../lib/entire/context.js';
import {
  type IncludedCheckpointSummary,
  setReviewPreflightCommitResolverForTests,
  type ReviewEntireContextResolution,
  type ReviewContextMode,
  resolveReviewCommitTarget,
  validateReviewCochangeTokenReadiness,
  validateReviewEntireIntentContext,
} from '../../commands/review/preflight.js';
import type { WorkspaceDeploymentResponse } from '../../lib/types.js';
import {
  COCHANGE_LOOKBACK_SESSIONS,
  COCHANGE_TOP_N,
  ReviewCreateProvenance,
  buildWorkspaceIdempotencyKey,
  deriveIdempotencyKey,
  isExpectedLocalCochangeResolutionError,
  normalizeCommitDiffPatch,
  parseChangedPathsFromDiff,
  resolveReviewGitProvenance,
  sleep,
} from './create-shared.js';

interface CommitResolution {
  commitSha: string;
  checkpointId: string | null;
  commitDiffPatch: string;
}

type SpinnerLike = {
  start: (message: string) => void;
  message: (message: string) => void;
  stop: (message?: string) => void;
};

export interface ResolveReviewContextOptions {
  commitish?: string;
  baseRef?: string;
  lastCheckpoints?: number;
  checkpointRange?: string;
  projectRoot?: string;
  idempotencyKey?: string;
  pollIntervalMs?: number;
  workspaceReadyTimeoutMs?: number;
  intentSummaryModel?: string;
  signal?: AbortSignal;
  onProgress?: (event: ResolveReviewContextProgressEvent) => void | Promise<void>;
}

const DEFAULT_WORKSPACE_READY_TIMEOUT_MS = 10 * 60_000;

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function mergeCheckpointContexts(input: {
  contexts: ReviewEntireContextResolution[];
  includedCheckpoints: IncludedCheckpointSummary[];
}): ReviewEntireContextResolution {
  const earliest = input.contexts[0];
  const latest = input.contexts[input.contexts.length - 1];
  const sessionIds = Array.from(new Set(input.contexts.flatMap((entry) => entry.context.sessionIds)));
  const intentSessionContext = Array.from(
    new Set(input.contexts.flatMap((entry) => entry.context.intentSessionContext.map((line) => line.trim()).filter(Boolean)))
  );
  const rawSessionPrompts = input.contexts
    .map((entry) => entry.context.rawSessionPrompts)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n---\n\n');

  return {
    context: {
      note: `Review context merged from ${input.includedCheckpoints.length} checkpoints (${input.includedCheckpoints
        .map((entry) => entry.checkpointId)
        .join(' -> ')}).`,
      sessionIds,
      transcriptUrl: latest.context.transcriptUrl ?? earliest.context.transcriptUrl,
      intentSessionContext,
      rawSessionPrompts: rawSessionPrompts || null,
    },
    contextResolution: latest.contextResolution,
    originalCheckpointId: earliest.originalCheckpointId,
    resolvedCheckpointId: latest.resolvedCheckpointId,
    resolvedCommitSha: latest.resolvedCommitSha,
    resolvedCommitSubject: latest.resolvedCommitSubject,
    commitsAgo: latest.commitsAgo,
    fallbackReason: latest.fallbackReason,
  };
}

export interface ResolveReviewContextResult {
  workspaceId: string;
  deploymentId: string;
  resolvedProvenance: ReviewCreateProvenance;
}

export interface ResolveReviewContextProgressEvent {
  stage: 'checkpoint' | 'entire_context' | 'cochange' | 'workspace' | 'deployment';
  state: 'active' | 'completed';
  label: string;
  detail: string;
}

export interface ReviewContextFlowOverrides {
  createWorkspace?: typeof createWorkspaceForCommitFlow;
  resolveWorkspaceSource?: typeof resolveWorkspaceSourceForCommitFlow;
  deployWorkspace?: typeof deployWorkspaceForCommitFlow;
  resolveLocalCochange?: typeof resolveLocalCochangeForCommitFlow;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildReviewFlowStageError(stage: string, error: unknown): Error {
  return new Error(`Review flow failed at ${stage}: ${toErrorMessage(error)}`);
}

function throwIfResolveReviewAbortError(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') {
    throw error;
  }
}

async function emitResolveReviewProgress(
  options: ResolveReviewContextOptions | undefined,
  event: ResolveReviewContextProgressEvent
): Promise<void> {
  try {
    await options?.onProgress?.(event);
  } catch {
    // Progress listeners are best-effort only and must not abort review setup.
  }
}

function throwIfResolveReviewAborted(options: ResolveReviewContextOptions | undefined): void {
  if (!options?.signal?.aborted) {
    return;
  }
  const error = new Error('Review flow aborted before completion.');
  error.name = 'AbortError';
  throw error;
}

export async function emitResolveReviewProgressForTests(
  options: ResolveReviewContextOptions | undefined,
  event: ResolveReviewContextProgressEvent
): Promise<void> {
  await emitResolveReviewProgress(options, event);
}

export function preserveResolveReviewAbortForTests(error: unknown): void {
  throwIfResolveReviewAbortError(error);
}

export function throwIfResolveReviewAbortedForTests(options: ResolveReviewContextOptions | undefined): void {
  throwIfResolveReviewAborted(options);
}

let createWorkspaceForCommitFlow: (source: {
  commitSha: string;
  checkpointId: string | null;
  sourceRef: string | null;
  projectRoot: string;
}, options?: { idempotencyKey?: string }) => Promise<Awaited<ReturnType<typeof createWorkspaceFromResolvedSource>>> =
  createWorkspaceFromResolvedSource;
let resolveWorkspaceSourceForCommitFlow: typeof resolveWorkspaceSource = resolveWorkspaceSource;
let deployWorkspaceForCommitFlow: (
  workspaceId: string,
  options: Parameters<typeof workspaceDeployCommand>[1]
) => Promise<WorkspaceDeploymentResponse | null> = workspaceDeployCommand;
let resolveLocalCochangeForCommitFlow: typeof resolveCochangeFromLocalGit = resolveCochangeFromLocalGit;

export function setReviewCommitResolverForTests(
  resolver:
    | ((
        commitish: string,
        options?: {
          baseRef?: string;
          lastCheckpoints?: number;
          checkpointRange?: string;
        }
      ) => CommitResolution)
    | null
): void {
  setReviewPreflightCommitResolverForTests(resolver);
}

export function setReviewContextFlowForTests(overrides: ReviewContextFlowOverrides | null): void {
  createWorkspaceForCommitFlow = overrides?.createWorkspace ?? createWorkspaceFromResolvedSource;
  resolveWorkspaceSourceForCommitFlow = overrides?.resolveWorkspaceSource ?? resolveWorkspaceSource;
  deployWorkspaceForCommitFlow = overrides?.deployWorkspace ?? workspaceDeployCommand;
  resolveLocalCochangeForCommitFlow = overrides?.resolveLocalCochange ?? resolveCochangeFromLocalGit;
}

async function waitForWorkspaceReadyFromIdempotentInProgress(
  workspaceId: string,
  options?: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal }
): Promise<Awaited<ReturnType<typeof createWorkspaceFromResolvedSource>>> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required for workspace creation.');
  }

  const pollIntervalMs = Math.max(250, options?.pollIntervalMs ?? 1500);
  const timeoutMs =
    typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_WORKSPACE_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (options?.signal?.aborted) {
      throw createAbortError();
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace ${workspaceId} to become ready`);
    }

    const workspace = await getWorkspaceFromWorker(workerUrl, workspaceId);
    if (workspace.status === 'ready') {
      return { workspace, reused: true };
    }
    if (workspace.status === 'failed' || workspace.status === 'deleted') {
      throw new Error(`Workspace ${workspaceId} ended in non-ready state: ${workspace.status}`);
    }
    await sleepWithAbort(pollIntervalMs, options?.signal);
  }
}

/**
 * Orchestrates review context setup from a commit by validating Entire metadata,
 * creating a workspace, deploying it, then assembling provenance for review creation.
 */
export async function resolveReviewContext(
  options?: ResolveReviewContextOptions
): Promise<ResolveReviewContextResult> {
  throwIfResolveReviewAborted(options);
  const commitish = options?.commitish?.trim() || 'HEAD';
  const projectRoot = options?.projectRoot?.trim() || '.';
  const spinner: SpinnerLike =
    process.stdout.isTTY && process.stderr.isTTY
      ? p.spinner()
      : {
          start: () => undefined,
          message: () => undefined,
          stop: () => undefined,
        };

  let commitSha = '';
  let checkpointId: string | null = null;
  let commitDiffPatch = '';
  let includedCheckpoints: IncludedCheckpointSummary[] = [];
  let checkpointSelectionMode: 'latest' | 'last_n' | 'range' = 'latest';
  let workspaceId = '';
  let deploymentId = '';
  let commitDiffPatchSha256 = '';
  let commitDiffPatchTruncated = false;
  let commitDiffPatchOriginalChars = 0;
  let entireContextResolution: ReviewEntireContextResolution | null = null;
  let reviewContextMode: ReviewContextMode = 'intent_aware';
  let localCochange:
    | {
        source: 'local_git';
        checkpointsRef: string;
        lookbackSessions: number;
        topN: number;
        sessionsScanned: number;
        relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
      }
    | null = null;
  let changedPaths: string[] = [];
  let gitProvenance: { repo: string; branch: string } = { repo: '', branch: '' };

  spinner.start('Resolving checkpoint...');
  try {
    throwIfResolveReviewAborted(options);
    await emitResolveReviewProgress(options, {
      stage: 'checkpoint',
      state: 'active',
      label: 'Resolving checkpoint',
      detail: 'Matching the latest checkpoint to the Home branch target.',
    });
    gitProvenance = resolveReviewGitProvenance();
    const resolvedCommit = resolveReviewCommitTarget(commitish, process.cwd(), {
      baseRef: options?.baseRef,
      lastCheckpoints: options?.lastCheckpoints,
      checkpointRange: options?.checkpointRange,
    });
    commitSha = resolvedCommit.commitSha;
    checkpointId = resolvedCommit.checkpointId;
    includedCheckpoints = resolvedCommit.includedCheckpoints ?? [];
    checkpointSelectionMode = resolvedCommit.checkpointSelectionMode ?? 'latest';
    changedPaths = parseChangedPathsFromDiff(resolvedCommit.commitDiffPatch);
    const normalizedPatch = normalizeCommitDiffPatch(resolvedCommit.commitDiffPatch);
    commitDiffPatch = normalizedPatch.patch;
    commitDiffPatchSha256 = normalizedPatch.sha256;
    commitDiffPatchTruncated = normalizedPatch.truncated;
    commitDiffPatchOriginalChars = normalizedPatch.originalChars;
    if (!checkpointId) {
      reviewContextMode = 'basic';
    }
    spinner.stop(
      checkpointId
        ? `Resolved checkpoint ${checkpointId} from ${commitSha.slice(0, 12)}`
        : `Resolved commit ${commitSha.slice(0, 12)} (basic review mode)`
    );
    await emitResolveReviewProgress(options, {
      stage: 'checkpoint',
      state: 'completed',
      label: checkpointId ? 'Checkpoint resolved' : 'Commit resolved',
      detail: checkpointId
        ? `Resolved checkpoint ${checkpointId} from ${commitSha.slice(0, 12)}.`
        : `Resolved commit ${commitSha.slice(0, 12)} without Entire checkpoint metadata; continuing in basic review mode.`,
    });
  } catch (error) {
    spinner.stop('Checkpoint resolution failed');
    throw buildReviewFlowStageError('checkpoint resolution', error);
  }

  if (checkpointId) {
    spinner.start('Validating Entire session metadata...');
    try {
      throwIfResolveReviewAborted(options);
      await emitResolveReviewProgress(options, {
        stage: 'entire_context',
        state: 'active',
        label: 'Reading session context',
        detail: 'Checking that Entire session metadata is readable for this review target.',
      });
      if (includedCheckpoints.length > 1) {
        const contexts: ReviewEntireContextResolution[] = [];
        for (const checkpoint of includedCheckpoints) {
          const context = await validateReviewEntireIntentContext(
            {
              commitSha: checkpoint.commitSha,
              checkpointId: checkpoint.checkpointId,
            },
            {
              summarizeSession: 'auto',
              allowBranchFallback: true,
            },
            process.cwd()
          );
          contexts.push(context);
        }
        entireContextResolution = mergeCheckpointContexts({
          contexts,
          includedCheckpoints,
        });
      } else {
        entireContextResolution = await validateReviewEntireIntentContext(
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
      }

      spinner.stop(
        entireContextResolution.contextResolution === 'branch_fallback'
          ? `Entire session metadata resolved via branch fallback (${entireContextResolution.resolvedCheckpointId})`
          : 'Entire session metadata is readable'
      );
      await emitResolveReviewProgress(options, {
        stage: 'entire_context',
        state: 'completed',
        label: 'Session context ready',
        detail:
          entireContextResolution.contextResolution === 'branch_fallback'
            ? `Using fallback checkpoint ${entireContextResolution.resolvedCheckpointId} from ${entireContextResolution.commitsAgo} commit(s) ago.`
            : 'Readable Entire session metadata found for the current checkpoint.',
      });
      if (entireContextResolution.contextResolution === 'branch_fallback') {
        p.log.warning(
          `Using fallback Entire context from commit ${entireContextResolution.resolvedCommitSha.slice(0, 7)} ('${entireContextResolution.resolvedCommitSubject}') ${entireContextResolution.commitsAgo} commits ago.`
        );
      }
    } catch (error) {
      throwIfResolveReviewAbortError(error);
      reviewContextMode = 'basic';
      entireContextResolution = null;
      spinner.stop('Entire session metadata unavailable; continuing in basic review mode');
      p.log.warning(
        `Entire session context was not available for checkpoint ${checkpointId}. Nimbus will continue with a basic diff/code-aware review.`
      );
      p.log.warning(toErrorMessage(error));
      await emitResolveReviewProgress(options, {
        stage: 'entire_context',
        state: 'completed',
        label: 'Session context unavailable',
        detail: `Entire session metadata could not be read for checkpoint ${checkpointId}; continuing in basic review mode.`,
      });
    }
  } else {
    await emitResolveReviewProgress(options, {
      stage: 'entire_context',
      state: 'completed',
      label: 'Session context skipped',
      detail: 'No Entire checkpoint metadata is available for this commit; continuing in basic review mode.',
    });
  }

  if (reviewContextMode === 'intent_aware') {
    spinner.start('Resolving local co-change context...');
    try {
      throwIfResolveReviewAborted(options);
      await emitResolveReviewProgress(options, {
        stage: 'cochange',
        state: 'active',
        label: 'Loading related context',
        detail: 'Collecting local co-change context and validating fallback readiness.',
      });
      localCochange = resolveLocalCochangeForCommitFlow(changedPaths, process.cwd(), {
        lookbackSessions: COCHANGE_LOOKBACK_SESSIONS,
        topN: COCHANGE_TOP_N,
      });
      if (localCochange) {
        spinner.stop(
          `Resolved local co-change context from ${localCochange.checkpointsRef} (${localCochange.sessionsScanned} sessions scanned)`
        );
      } else {
        spinner.stop('Local co-change context unavailable (worker will use GitHub fallback)');
      }
    } catch (error) {
      localCochange = null;
      const message = toErrorMessage(error);
      if (!isExpectedLocalCochangeResolutionError(message)) {
        p.log.warning(`Local co-change resolution error: ${message}`);
      }
      spinner.stop('Local co-change context unavailable (worker will use GitHub fallback)');
    }

    spinner.start('Checking co-change token readiness...');
    try {
      throwIfResolveReviewAborted(options);
      if (localCochange) {
        spinner.stop('Co-change token check skipped (using local co-change context)');
        await emitResolveReviewProgress(options, {
          stage: 'cochange',
          state: 'completed',
          label: 'Related context ready',
          detail: `Loaded local co-change context from ${localCochange.checkpointsRef} across ${localCochange.sessionsScanned} session(s).`,
        });
      } else {
        await validateReviewCochangeTokenReadiness();
        spinner.stop('Co-change token readiness confirmed');
        await emitResolveReviewProgress(options, {
          stage: 'cochange',
          state: 'completed',
          label: 'Related context ready',
          detail: 'Local co-change context was unavailable, so worker fallback is ready to use GitHub context.',
        });
      }
    } catch (error) {
      spinner.stop('Co-change token readiness check failed');
      throwIfResolveReviewAbortError(error);
      throw buildReviewFlowStageError('checkpoint resolution', error);
    }
  } else {
    spinner.start('Skipping co-change context...');
    spinner.stop('Co-change skipped (basic review mode)');
    await emitResolveReviewProgress(options, {
      stage: 'cochange',
      state: 'completed',
      label: 'Related context skipped',
      detail: 'Basic review mode skips Entire co-change context and uses diff/code context only.',
    });
  }

  spinner.start('Creating workspace...');
  try {
    throwIfResolveReviewAborted(options);
    await emitResolveReviewProgress(options, {
      stage: 'workspace',
      state: 'active',
      label: 'Preparing workspace',
      detail: 'Creating an isolated workspace for the review target.',
    });
    throwIfResolveReviewAborted(options);
    const sourceResolved = resolveWorkspaceSourceForCommitFlow(commitSha, { projectRoot });
    const source = {
      ...sourceResolved,
      checkpointId,
    };
    const workspaceIdempotencyKey = options?.idempotencyKey?.trim()
      ? deriveIdempotencyKey(options.idempotencyKey, 'workspace')
      : buildWorkspaceIdempotencyKey({
          repo: gitProvenance.repo,
          commitSha,
          checkpointId,
          projectRoot,
        });
    let created: Awaited<ReturnType<typeof createWorkspaceFromResolvedSource>>;
    try {
      created = await createWorkspaceForCommitFlow(source, {
        idempotencyKey: workspaceIdempotencyKey,
      });
    } catch (error) {
      if (!(error instanceof WorkspaceCreateInProgressError)) {
        throw error;
      }
      if (!error.retryable) {
        throw error;
      }
      spinner.message(`Workspace ${error.workspaceId} is still creating; waiting for readiness...`);
      created = await waitForWorkspaceReadyFromIdempotentInProgress(error.workspaceId, {
        pollIntervalMs: options?.pollIntervalMs,
        timeoutMs: options?.workspaceReadyTimeoutMs,
        signal: options?.signal,
      });
    }
    workspaceId = created.workspace.id;
    spinner.stop(`${created.reused ? 'Reusing workspace' : 'Workspace created'}: ${workspaceId}`);
    await emitResolveReviewProgress(options, {
      stage: 'workspace',
      state: 'completed',
      label: 'Workspace ready',
      detail: `Workspace ${workspaceId} ${created.reused ? 'reused' : 'created'} for the review target.`,
    });
  } catch (error) {
    spinner.stop('Workspace creation failed');
    throwIfResolveReviewAbortError(error);
    throw buildReviewFlowStageError('workspace creation', error);
  }

  spinner.start('Deploying workspace...');
  try {
    throwIfResolveReviewAborted(options);
    await emitResolveReviewProgress(options, {
      stage: 'deployment',
      state: 'active',
      label: 'Preparing deployment',
      detail: 'Deploying the workspace so Nimbus can run the review against the latest target.',
    });
    throwIfResolveReviewAborted(options);
    const deploymentIdempotencyKey = options?.idempotencyKey?.trim()
      ? deriveIdempotencyKey(options.idempotencyKey, 'deploy')
      : deriveIdempotencyKey(
          buildWorkspaceIdempotencyKey({
            repo: gitProvenance.repo,
            commitSha,
            checkpointId,
            projectRoot,
          }),
          'deploy'
        );
    const deployment = await deployWorkspaceForCommitFlow(workspaceId, {
      idempotencyKey: deploymentIdempotencyKey,
      runTestsIfPresent: true,
      runBuildIfPresent: true,
      autoFix: false,
      pollIntervalMs: options?.pollIntervalMs,
      reporter: {
        message: (text) => spinner.message(text),
        success: (text) => spinner.message(text),
        warning: (text) => spinner.message(text),
        error: (text) => spinner.message(text),
      },
      entireIntentContextOverride: reviewContextMode === 'intent_aware' ? (entireContextResolution ?? undefined) : null,
    });
    // Once deployment exists, finish attaching it to the review instead of aborting
    // and leaving unattached startup artifacts behind.
    if (!deployment) {
      throw new Error('Workspace deploy returned no deployment result.');
    }
    deploymentId = deployment.id;
    spinner.stop(`Deployment succeeded: ${deploymentId}`);
    await emitResolveReviewProgress(options, {
      stage: 'deployment',
      state: 'completed',
      label: 'Deployment ready',
      detail: `Deployment ${deploymentId} succeeded and is ready for review.`,
    });
  } catch (error) {
    spinner.stop('Workspace deploy failed');
    throwIfResolveReviewAbortError(error);
    throw buildReviewFlowStageError('workspace deploy', error);
  }

  const resolvedProvenance: ReviewCreateProvenance = {
    note:
      reviewContextMode === 'intent_aware'
        ? `Review with Entire checkpoint intent context (${entireContextResolution?.resolvedCheckpointId ?? checkpointId ?? 'unknown'}).`
        : checkpointId
          ? `Basic code-aware review for checkpoint ${checkpointId} without Entire session context.`
          : 'Basic code-aware review without Entire checkpoint/session context.',
    reviewContextMode,
    sessionIds: reviewContextMode === 'intent_aware' ? (entireContextResolution?.context.sessionIds ?? []) : [],
    intentSessionContext:
      reviewContextMode === 'intent_aware' ? (entireContextResolution?.context.intentSessionContext ?? []) : [],
    rawSessionPrompts: reviewContextMode === 'intent_aware' ? (entireContextResolution?.context.rawSessionPrompts ?? null) : null,
    commitSha,
    commitDiffPatch,
    commitDiffPatchSha256,
    commitDiffPatchTruncated,
    commitDiffPatchOriginalChars,
    ...(reviewContextMode === 'intent_aware'
      ? {
          contextResolution: entireContextResolution?.contextResolution ?? 'direct',
          contextResolutionOriginalCheckpointId: entireContextResolution?.originalCheckpointId ?? checkpointId ?? undefined,
          contextResolutionResolvedCheckpointId: entireContextResolution?.resolvedCheckpointId ?? checkpointId ?? undefined,
          contextResolutionResolvedCommitSha: entireContextResolution?.resolvedCommitSha ?? commitSha,
          contextResolutionResolvedCommitMessage: entireContextResolution?.resolvedCommitSubject,
        }
      : {}),
    checkpointSelectionMode,
    includedCheckpoints,
    repo: gitProvenance.repo,
    branch: gitProvenance.branch,
    ...(options?.intentSummaryModel?.trim() ? { intentSummaryModel: options.intentSummaryModel.trim() } : {}),
    localCochange: reviewContextMode === 'intent_aware' && localCochange
      ? {
          source: localCochange.source,
          checkpointsRef: localCochange.checkpointsRef,
          lookbackSessions: localCochange.lookbackSessions,
          topN: localCochange.topN,
          sessionsScanned: localCochange.sessionsScanned,
          relatedByChangedPath: localCochange.relatedByChangedPath,
        }
      : undefined,
  };

  return {
    workspaceId,
    deploymentId,
    resolvedProvenance,
  };
}
