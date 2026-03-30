import * as p from '@clack/prompts';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import { createReview, getReview, getWorkerUrl, streamReviewEvents } from '../../lib/api.js';
import { workspaceDeployCommand } from '../../commands/workspace/deploy.js';
import { createWorkspaceFromResolvedSource, resolveWorkspaceSource } from '../../commands/workspace/create.js';
import { resolveCochangeFromLocalGit } from '../../lib/entire/context.js';
import { formatEvent } from '../../commands/review/events.js';
import {
  setReviewPreflightCommitResolverForTests,
  type ReviewEntireContextResolution,
  validateReviewCochangeTokenReadiness,
  validateReviewCommitCheckpoint,
  validateReviewEntireIntentContext,
} from '../../commands/review/preflight.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import type { WorkspaceDeploymentResponse, WorkspaceResponse } from '../../lib/types.js';
import {
  buildIdempotencyKey,
  buildWorkspaceIdempotencyKey,
  COCHANGE_LOOKBACK_SESSIONS,
  COCHANGE_TOP_N,
  deriveIdempotencyKey,
  formatReviewExecutionFailure,
  isExpectedLocalCochangeResolutionError,
  normalizeCommitDiffPatch,
  normalizeResultUrl,
  parseChangedPathsFromDiff,
  resolveReviewGitProvenance,
  ReviewCreateProvenance,
  sleep,
} from './create-shared.js';

interface CommitResolution {
  commitSha: string;
  checkpointId: string | null;
  commitDiffPatch: string;
}

export interface ResolveReviewContextOptions {
  commitish?: string;
  baseRef?: string;
  projectRoot?: string;
  idempotencyKey?: string;
  pollIntervalMs?: number;
  intentSummaryModel?: string;
}

export interface ResolveReviewContextResult {
  workspaceId: string;
  deploymentId: string;
  resolvedProvenance: ReviewCreateProvenance;
}

let createWorkspaceForCommitFlow: (source: {
  commitSha: string;
  checkpointId: string | null;
  sourceRef: string | null;
  projectRoot: string;
}) => Promise<{ workspace: WorkspaceResponse }> = createWorkspaceFromResolvedSource;
let resolveWorkspaceSourceForCommitFlow: typeof resolveWorkspaceSource = resolveWorkspaceSource;
let deployWorkspaceForCommitFlow: (
  workspaceId: string,
  options: Parameters<typeof workspaceDeployCommand>[1]
) => Promise<WorkspaceDeploymentResponse | null> = workspaceDeployCommand;
let createReviewForCommitFlow: typeof createReview = createReview;
let streamReviewEventsForCommitFlow: typeof streamReviewEvents = streamReviewEvents;
let getReviewForCommitFlow: typeof getReview = getReview;
let resolveLocalCochangeForCommitFlow: typeof resolveCochangeFromLocalGit = resolveCochangeFromLocalGit;

export function setReviewCommitResolverForTests(
  resolver: ((commitish: string, options?: { baseRef?: string }) => CommitResolution) | null
): void {
  setReviewPreflightCommitResolverForTests(resolver);
}

export function setReviewCreateFlowForTests(
  overrides:
    | {
        createWorkspace?: typeof createWorkspaceForCommitFlow;
        resolveWorkspaceSource?: typeof resolveWorkspaceSourceForCommitFlow;
        deployWorkspace?: typeof deployWorkspaceForCommitFlow;
        createReview?: typeof createReviewForCommitFlow;
        streamReviewEvents?: typeof streamReviewEventsForCommitFlow;
        getReview?: typeof getReviewForCommitFlow;
        resolveLocalCochange?: typeof resolveLocalCochangeForCommitFlow;
      }
    | null
): void {
  createWorkspaceForCommitFlow = overrides?.createWorkspace ?? createWorkspaceFromResolvedSource;
  resolveWorkspaceSourceForCommitFlow = overrides?.resolveWorkspaceSource ?? resolveWorkspaceSource;
  deployWorkspaceForCommitFlow = overrides?.deployWorkspace ?? workspaceDeployCommand;
  createReviewForCommitFlow = overrides?.createReview ?? createReview;
  streamReviewEventsForCommitFlow = overrides?.streamReviewEvents ?? streamReviewEvents;
  getReviewForCommitFlow = overrides?.getReview ?? getReview;
  resolveLocalCochangeForCommitFlow = overrides?.resolveLocalCochange ?? resolveCochangeFromLocalGit;
}

async function pollReviewUntilTerminalStatus(
  workerUrl: string,
  reviewId: string,
  options?: { intervalMs?: number; timeoutMs?: number }
): Promise<Awaited<ReturnType<typeof getReviewForCommitFlow>>> {
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
    const latest = await getReviewForCommitFlow(workerUrl, reviewId);
    if (latest.review.status !== 'queued' && latest.review.status !== 'running') {
      return latest;
    }
    if (Date.now() >= deadline) {
      return latest;
    }
    await sleep(intervalMs);
  }
}

export async function resolveReviewContext(
  options?: ResolveReviewContextOptions
): Promise<ResolveReviewContextResult> {
  const commitish = options?.commitish?.trim() || 'HEAD';
  const projectRoot = options?.projectRoot?.trim() || '.';
  const spinner = p.spinner();

  let commitSha = '';
  let checkpointId = '';
  let commitDiffPatch = '';
  let workspaceId = '';
  let deploymentId = '';
  let commitDiffPatchSha256 = '';
  let commitDiffPatchTruncated = false;
  let commitDiffPatchOriginalChars = 0;
  let entireContextResolution: ReviewEntireContextResolution | null = null;
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
    gitProvenance = resolveReviewGitProvenance();
    const resolvedCommit = validateReviewCommitCheckpoint(commitish, process.cwd(), {
      baseRef: options?.baseRef,
    });
    commitSha = resolvedCommit.commitSha;
    checkpointId = resolvedCommit.checkpointId;
    changedPaths = parseChangedPathsFromDiff(resolvedCommit.commitDiffPatch);
    const normalizedPatch = normalizeCommitDiffPatch(resolvedCommit.commitDiffPatch);
    commitDiffPatch = normalizedPatch.patch;
    commitDiffPatchSha256 = normalizedPatch.sha256;
    commitDiffPatchTruncated = normalizedPatch.truncated;
    commitDiffPatchOriginalChars = normalizedPatch.originalChars;
    spinner.stop(`Resolved checkpoint ${checkpointId} from ${commitSha.slice(0, 12)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Checkpoint resolution failed');
    throw new Error(`Review flow failed at checkpoint resolution: ${message}`);
  }

  spinner.start('Validating Entire session metadata...');
  try {
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

    spinner.stop(
      entireContextResolution.contextResolution === 'branch_fallback'
        ? `Entire session metadata resolved via branch fallback (${entireContextResolution.resolvedCheckpointId})`
        : 'Entire session metadata is readable'
    );
    if (entireContextResolution.contextResolution === 'branch_fallback') {
      p.log.warning(
        `Using fallback Entire context from commit ${entireContextResolution.resolvedCommitSha.slice(0, 7)} ('${entireContextResolution.resolvedCommitSubject}') ${entireContextResolution.commitsAgo} commits ago.`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Entire session metadata validation failed');
    throw new Error(`Review flow failed at checkpoint resolution: ${message}`);
  }

  spinner.start('Resolving local co-change context...');
  try {
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
    const message = error instanceof Error ? error.message : String(error);
    if (!isExpectedLocalCochangeResolutionError(message)) {
      p.log.warning(`Local co-change resolution error: ${message}`);
    }
    spinner.stop('Local co-change context unavailable (worker will use GitHub fallback)');
  }

  spinner.start('Checking co-change token readiness...');
  try {
    if (localCochange) {
      spinner.stop('Co-change token check skipped (using local co-change context)');
    } else {
      await validateReviewCochangeTokenReadiness();
      spinner.stop('Co-change token readiness confirmed');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Co-change token readiness check failed');
    throw new Error(`Review flow failed at checkpoint resolution: ${message}`);
  }

  spinner.start('Creating workspace...');
  try {
    const sourceResolved = resolveWorkspaceSourceForCommitFlow(commitSha, { projectRoot });
    const source = {
      ...sourceResolved,
      checkpointId,
    };
    const created = await createWorkspaceForCommitFlow(source);
    workspaceId = created.workspace.id;
    spinner.stop(`Workspace created: ${workspaceId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Workspace creation failed');
    throw new Error(`Review flow failed at workspace creation: ${message}`);
  }

  spinner.start('Deploying workspace...');
  try {
    const deploymentIdempotencyKey = options?.idempotencyKey?.trim()
      ? deriveIdempotencyKey(options.idempotencyKey, 'deploy')
      : buildWorkspaceIdempotencyKey(commitSha);
    const deployment = await deployWorkspaceForCommitFlow(workspaceId, {
      idempotencyKey: deploymentIdempotencyKey,
      runTestsIfPresent: false,
      runBuildIfPresent: false,
      autoFix: false,
      pollIntervalMs: options?.pollIntervalMs,
      reporter: {
        message: (text) => spinner.message(text),
        success: (text) => spinner.message(text),
        warning: (text) => spinner.message(text),
        error: (text) => spinner.message(text),
      },
      entireIntentContextOverride: entireContextResolution ?? undefined,
    });
    if (!deployment) {
      throw new Error('Workspace deploy returned no deployment result.');
    }
    deploymentId = deployment.id;
    spinner.stop(`Deployment succeeded: ${deploymentId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Workspace deploy failed');
    throw new Error(`Review flow failed at workspace deploy: ${message}`);
  }

  const resolvedProvenance: ReviewCreateProvenance = {
    note: `Review with Entire checkpoint intent context (${entireContextResolution?.resolvedCheckpointId ?? checkpointId}).`,
    sessionIds: entireContextResolution?.context.sessionIds ?? [],
    intentSessionContext: entireContextResolution?.context.intentSessionContext ?? [],
    rawSessionPrompts: entireContextResolution?.context.rawSessionPrompts ?? null,
    commitSha,
    commitDiffPatch,
    commitDiffPatchSha256,
    commitDiffPatchTruncated,
    commitDiffPatchOriginalChars,
    contextResolution: entireContextResolution?.contextResolution ?? 'direct',
    contextResolutionOriginalCheckpointId: entireContextResolution?.originalCheckpointId ?? checkpointId,
    contextResolutionResolvedCheckpointId: entireContextResolution?.resolvedCheckpointId ?? checkpointId,
    contextResolutionResolvedCommitSha: entireContextResolution?.resolvedCommitSha ?? commitSha,
    contextResolutionResolvedCommitMessage: entireContextResolution?.resolvedCommitSubject,
    repo: gitProvenance.repo,
    branch: gitProvenance.branch,
    ...(options?.intentSummaryModel?.trim() ? { intentSummaryModel: options.intentSummaryModel.trim() } : {}),
    localCochange: localCochange
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

export async function createReviewFromCommitCommand(
  options?: {
    commitish?: string;
    baseRef?: string;
    outputReviewIdPath?: string;
    projectRoot?: string;
    idempotencyKey?: string;
    severityThreshold?: 'low' | 'medium' | 'high' | 'critical';
    maxFindings?: number;
    model?: string;
    intentSummaryModel?: string;
    includeProvenance?: boolean;
    includeValidationEvidence?: boolean;
    pollIntervalMs?: number;
  }
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  let workspaceId = '';
  let deploymentId = '';
  let reviewId = '';
  let reviewResultUrl = '';
  let resolvedProvenance: ReviewCreateProvenance | null = null;
  const spinner = p.spinner();

  const resolved = await resolveReviewContext({
    commitish: options?.commitish,
    baseRef: options?.baseRef,
    projectRoot: options?.projectRoot,
    idempotencyKey: options?.idempotencyKey,
    pollIntervalMs: options?.pollIntervalMs,
    intentSummaryModel: options?.intentSummaryModel,
  });
  workspaceId = resolved.workspaceId;
  deploymentId = resolved.deploymentId;
  resolvedProvenance = resolved.resolvedProvenance;

  spinner.start('Creating review...');
  try {
    const reviewIdempotencyKey = options?.idempotencyKey?.trim()
      ? deriveIdempotencyKey(options.idempotencyKey, 'review')
      : buildIdempotencyKey(workspaceId, deploymentId);
    const response = await createReviewForCommitFlow(workerUrl, reviewIdempotencyKey, {
      target: {
        type: 'workspace_deployment',
        workspaceId,
        deploymentId,
      },
      mode: 'report_only',
      policy: {
        severityThreshold: options?.severityThreshold ?? 'low',
        maxFindings: options?.maxFindings,
        includeProvenance: options?.includeProvenance ?? true,
        includeValidationEvidence: options?.includeValidationEvidence ?? true,
      },
      model: options?.model,
      provenance: resolvedProvenance ?? undefined,
    });
    reviewId = response.reviewId;
    reviewResultUrl = normalizeResultUrl(workerUrl, response.resultUrl);
    spinner.stop(`Review queued: ${reviewId}`);

    const outputReviewIdRaw = options?.outputReviewIdPath;
    const outputReviewIdPath = outputReviewIdRaw?.trim();
    if (outputReviewIdRaw !== undefined && !outputReviewIdPath) {
      p.log.warning('Ignoring --output-review-id because the provided path is empty.');
    }
    if (outputReviewIdPath) {
      try {
        const repoRoot = new GitRepo(process.cwd()).getRepoRoot();
        const workspaceDir = typeof process.env.GITHUB_WORKSPACE === 'string' && process.env.GITHUB_WORKSPACE.trim()
          ? process.env.GITHUB_WORKSPACE.trim()
          : null;
        let baseDir = repoRoot;
        if (workspaceDir) {
          const resolvedWorkspaceDir = resolve(workspaceDir);
          const resolvedRepoRoot = resolve(repoRoot);
          if (
            resolvedWorkspaceDir === resolvedRepoRoot ||
            resolvedWorkspaceDir.startsWith(`${resolvedRepoRoot}/`)
          ) {
            baseDir = resolvedWorkspaceDir;
          } else {
            p.log.warning(
              `Ignoring GITHUB_WORKSPACE=${workspaceDir} because it is outside the repository root; resolving --output-review-id from repo root instead.`
            );
          }
        }
        const absolutePath = isAbsolute(outputReviewIdPath)
          ? outputReviewIdPath
          : resolve(baseDir, outputReviewIdPath);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, `${reviewId}\n`, 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not write review ID file at ${outputReviewIdPath}: ${message}. Review creation failed because downstream automation expects this file.`
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Review creation failed');
    throw new Error(`Review flow failed at review creation: ${message}`);
  }

  p.log.info(`Streaming review events for ${reviewId}`);
  let terminalStatus: string | null = null;
  let lastFailureEvent: Record<string, unknown> | null = null;
  let streamErrorMessage: string | null = null;
  try {
    await streamReviewEventsForCommitFlow(workerUrl, reviewId, async (event) => {
      const line = formatEvent(event);
      if (line) {
        console.log(line);
      }
      if (
        event.data.type === 'review_context_cochange_failed' ||
        event.data.type === 'review_context_assembly_failed' ||
        event.data.type === 'review_failed'
      ) {
        lastFailureEvent = event.data;
      }
      if (event.data.type === 'terminal' && typeof event.data.status === 'string') {
        terminalStatus = event.data.status;
      }
    });
  } catch (error) {
    streamErrorMessage = error instanceof Error ? error.message : String(error);
    p.log.warning(`Event stream interrupted before terminal status: ${streamErrorMessage}`);
  }

  let final = await getReviewForCommitFlow(workerUrl, reviewId);
  if (!terminalStatus && (final.review.status === 'queued' || final.review.status === 'running')) {
    p.log.warning('Review still in progress after event stream ended; falling back to status polling.');
    final = await pollReviewUntilTerminalStatus(workerUrl, reviewId, {
      intervalMs: options?.pollIntervalMs,
    });
  }

  const status = typeof terminalStatus === 'string' ? terminalStatus : final.review.status;
  if (status !== 'succeeded') {
    if (streamErrorMessage) {
      p.log.warning(`Latest stream interruption detail: ${streamErrorMessage}`);
    }
    throw new Error(formatReviewExecutionFailure(status, final.review, lastFailureEvent));
  }

  console.log(`Report URL: ${reviewResultUrl}`);
}
