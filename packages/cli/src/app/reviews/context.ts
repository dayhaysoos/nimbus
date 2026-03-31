import * as p from '@clack/prompts';
import { workspaceDeployCommand } from '../../commands/workspace/deploy.js';
import { createWorkspaceFromResolvedSource, resolveWorkspaceSource } from '../../commands/workspace/create.js';
import { resolveCochangeFromLocalGit } from '../../lib/entire/context.js';
import {
  setReviewPreflightCommitResolverForTests,
  type ReviewEntireContextResolution,
  validateReviewCochangeTokenReadiness,
  validateReviewCommitCheckpoint,
  validateReviewEntireIntentContext,
} from '../../commands/review/preflight.js';
import type { WorkspaceDeploymentResponse, WorkspaceResponse } from '../../lib/types.js';
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
let resolveLocalCochangeForCommitFlow: typeof resolveCochangeFromLocalGit = resolveCochangeFromLocalGit;

export function setReviewCommitResolverForTests(
  resolver: ((commitish: string, options?: { baseRef?: string }) => CommitResolution) | null
): void {
  setReviewPreflightCommitResolverForTests(resolver);
}

export function setReviewContextFlowForTests(overrides: ReviewContextFlowOverrides | null): void {
  createWorkspaceForCommitFlow = overrides?.createWorkspace ?? createWorkspaceFromResolvedSource;
  resolveWorkspaceSourceForCommitFlow = overrides?.resolveWorkspaceSource ?? resolveWorkspaceSource;
  deployWorkspaceForCommitFlow = overrides?.deployWorkspace ?? workspaceDeployCommand;
  resolveLocalCochangeForCommitFlow = overrides?.resolveLocalCochange ?? resolveCochangeFromLocalGit;
}

/**
 * Orchestrates review context setup from a commit by validating Entire metadata,
 * creating a workspace, deploying it, then assembling provenance for review creation.
 */
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
    spinner.stop('Checkpoint resolution failed');
    throw buildReviewFlowStageError('checkpoint resolution', error);
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
    spinner.stop('Entire session metadata validation failed');
    throw buildReviewFlowStageError('checkpoint resolution', error);
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
    const message = toErrorMessage(error);
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
    spinner.stop('Co-change token readiness check failed');
    throw buildReviewFlowStageError('checkpoint resolution', error);
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
    spinner.stop('Workspace creation failed');
    throw buildReviewFlowStageError('workspace creation', error);
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
    spinner.stop('Workspace deploy failed');
    throw buildReviewFlowStageError('workspace deploy', error);
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
