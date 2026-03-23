import * as p from '@clack/prompts';
import { createHash } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import {
  createReview,
  getReview,
  getWorkerUrl,
  streamReviewEvents,
} from '../../lib/api.js';
import { detectRepoSlugFromGitOrigin } from '../../lib/git.js';
import { workspaceDeployCommand } from '../workspace/deploy.js';
import { createWorkspaceFromResolvedSource, resolveWorkspaceSource } from '../workspace/create.js';
import { resolveCochangeFromLocalGit } from '../../lib/entire/context.js';
import { formatEvent } from './events.js';
import {
  setReviewPreflightCommitResolverForTests,
  type ReviewEntireContextResolution,
  validateReviewCochangeTokenReadiness,
  validateReviewCommitCheckpoint,
  validateReviewEntireIntentContext,
} from './preflight.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import type {
  WorkspaceDeploymentResponse,
  WorkspaceResponse,
} from '../../lib/types.js';

const MAX_COMMIT_DIFF_PATCH_CHARS = 120_000;
const COCHANGE_LOOKBACK_SESSIONS = 5;
const COCHANGE_TOP_N = 20;

function isExpectedLocalCochangeResolutionError(message: string): boolean {
  return (
    /not a git repository/i.test(message) ||
    /unable to resolve entire checkpoints branch reference/i.test(message) ||
    /failed to resolve git repository/i.test(message) ||
    /unknown revision/i.test(message) ||
    /bad revision/i.test(message)
  );
}

function parseChangedPathsFromDiff(patch: string): string[] {
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

function buildIdempotencyKey(workspaceId: string, deploymentId: string): string {
  const seed = `${workspaceId}:${deploymentId}:${Date.now()}:${Math.random()}`;
  return `review-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
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

function resolveReviewGitProvenance(): { repo: string; branch: string } {
  let branchCandidate = '';
  try {
    branchCandidate = new GitRepo(process.cwd()).getCurrentBranchRef() ?? '';
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
    repo = detectRepoSlugFromGitOrigin();
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve git repo slug from origin: ${details}`);
  }

  return { repo: repo.trim(), branch };
}

export async function createReviewCommand(
  workspaceId: string,
  deploymentId: string,
  options?: {
    idempotencyKey?: string;
    severityThreshold?: 'low' | 'medium' | 'high' | 'critical';
    maxFindings?: number;
    model?: string;
    intentSummaryModel?: string;
    includeProvenance?: boolean;
    includeValidationEvidence?: boolean;
  }
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  await validateReviewCochangeTokenReadiness();

  const gitProvenance = resolveReviewGitProvenance();

  const response = await createReview(workerUrl, options?.idempotencyKey?.trim() || buildIdempotencyKey(workspaceId, deploymentId), {
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
    provenance: {
      repo: gitProvenance.repo,
      branch: gitProvenance.branch,
      ...(options?.intentSummaryModel?.trim() ? { intentSummaryModel: options.intentSummaryModel.trim() } : {}),
    },
  });

  p.log.success(`Review queued: ${response.reviewId}`);
  p.log.message(`Status: ${response.status}`);
  p.log.message(`Result URL: ${response.resultUrl}`);
  p.log.message(`Events URL: ${response.eventsUrl}`);
}

interface CommitResolution {
  commitSha: string;
  checkpointId: string | null;
  commitDiffPatch: string;
}

function formatReviewExecutionFailure(
  status: string,
  finalReview: { error?: { code: string; message: string } },
  lastFailureEvent: Record<string, unknown> | null
): string {
  const details: string[] = [];

  if (finalReview.error?.code && finalReview.error?.message) {
    details.push(`${finalReview.error.code}: ${finalReview.error.message}`);
  }

  if (lastFailureEvent) {
    const eventType = typeof lastFailureEvent.type === 'string' ? lastFailureEvent.type : null;
    const reason = typeof lastFailureEvent.reason === 'string' ? lastFailureEvent.reason : null;
    const githubResponseBody =
      typeof lastFailureEvent.githubResponseBody === 'string' ? lastFailureEvent.githubResponseBody : null;
    const code = typeof lastFailureEvent.code === 'string' ? lastFailureEvent.code : null;
    const message = typeof lastFailureEvent.message === 'string' ? lastFailureEvent.message : null;

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

function buildWorkspaceIdempotencyKey(commitSha: string): string {
  return `workspace-${createHash('sha256').update(`${commitSha}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 20)}`;
}

function deriveIdempotencyKey(base: string, scope: 'deploy' | 'review'): string {
  return `${scope}-${createHash('sha256').update(`${base}:${scope}`).digest('hex').slice(0, 20)}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeResultUrl(workerUrl: string, resultUrl: string): string {
  try {
    return new URL(resultUrl, workerUrl).toString();
  } catch {
    return resultUrl;
  }
}

function normalizeCommitDiffPatch(patch: string): {
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

  const commitish = options?.commitish?.trim() || 'HEAD';
  const projectRoot = options?.projectRoot?.trim() || '.';
  const spinner = p.spinner();

  let commitSha = '';
  let checkpointId = '';
  let commitDiffPatch = '';
  let workspaceId = '';
  let deploymentId = '';
  let reviewId = '';
  let reviewResultUrl = '';
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

  try {
    spinner.start('Resolving checkpoint...');
    try {
      gitProvenance = resolveReviewGitProvenance();
      const resolvedCommit = validateReviewCommitCheckpoint(commitish, process.cwd(), {
        baseRef: options?.baseRef,
        allowBranchCheckpointFallback: Boolean(options?.baseRef),
      });
      commitSha = resolvedCommit.commitSha;
      checkpointId = resolvedCommit.checkpointId;
      changedPaths = parseChangedPathsFromDiff(resolvedCommit.commitDiffPatch);
      const normalizedPatch = normalizeCommitDiffPatch(resolvedCommit.commitDiffPatch);
      commitDiffPatch = normalizedPatch.patch;
      commitDiffPatchSha256 = normalizedPatch.sha256;
      commitDiffPatchTruncated = normalizedPatch.truncated;
      commitDiffPatchOriginalChars = normalizedPatch.originalChars;
      if (resolvedCommit.checkpointResolution === 'branch_fallback') {
        const fallbackSha = (resolvedCommit.checkpointResolvedFromCommitSha ?? '').slice(0, 12);
        const commitsAgo = resolvedCommit.checkpointResolvedCommitsAgo;
        const suffix = Number.isInteger(commitsAgo) ? ` (${commitsAgo} commits ago)` : '';
        spinner.stop(`Resolved checkpoint ${checkpointId} via branch fallback from ${fallbackSha}${suffix}`);
      } else {
        spinner.stop(`Resolved checkpoint ${checkpointId} from ${commitSha.slice(0, 12)}`);
      }
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
        },
        process.cwd()
      );
      if (entireContextResolution.contextResolution === 'branch_fallback') {
        spinner.stop(
          `Entire session metadata resolved via branch fallback (${entireContextResolution.resolvedCheckpointId} from ${entireContextResolution.resolvedCommitSha.slice(0, 12)})`
        );
      } else {
        spinner.stop('Entire session metadata is readable');
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
      const source = resolveWorkspaceSourceForCommitFlow(commitSha, { projectRoot });
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

    spinner.start('Creating review...');
    try {
      const reviewIdempotencyKey = options?.idempotencyKey?.trim()
        ? deriveIdempotencyKey(options.idempotencyKey, 'review')
        : buildIdempotencyKey(workspaceId, deploymentId);
      const response = await createReviewForCommitFlow(
        workerUrl,
        reviewIdempotencyKey,
        {
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
          provenance: {
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
            contextResolutionResolvedCommitMessage:
              entireContextResolution?.contextResolution === 'branch_fallback'
                ? entireContextResolution.resolvedCommitSubject
                : undefined,
            repo: gitProvenance.repo,
            branch: gitProvenance.branch,
            ...(options?.intentSummaryModel?.trim()
              ? { intentSummaryModel: options.intentSummaryModel.trim() }
              : {}),
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
          },
        }
      );
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

  } catch (error) {
    throw error;
  }
}
