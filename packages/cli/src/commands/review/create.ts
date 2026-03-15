import * as p from '@clack/prompts';
import { createHash } from 'crypto';
import {
  createReview,
  getReview,
  getWorkerUrl,
  streamReviewEvents,
} from '../../lib/api.js';
import { workspaceDeployCommand } from '../workspace/deploy.js';
import { createWorkspaceFromResolvedSource, resolveWorkspaceSource } from '../workspace/create.js';
import { formatEvent } from './events.js';
import {
  setReviewPreflightCommitResolverForTests,
  type ReviewEntireContextResolution,
  validateReviewCochangeTokenReadiness,
  validateReviewCommitCheckpoint,
  validateReviewEntireIntentContext,
} from './preflight.js';
import type {
  WorkspaceDeploymentResponse,
  WorkspaceResponse,
} from '../../lib/types.js';

const MAX_COMMIT_DIFF_PATCH_CHARS = 120_000;

function buildIdempotencyKey(workspaceId: string, deploymentId: string): string {
  const seed = `${workspaceId}:${deploymentId}:${Date.now()}:${Math.random()}`;
  return `review-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

export async function createReviewCommand(
  workspaceId: string,
  deploymentId: string,
  options?: {
    idempotencyKey?: string;
    severityThreshold?: 'low' | 'medium' | 'high' | 'critical';
    maxFindings?: number;
    model?: string;
    includeProvenance?: boolean;
    includeValidationEvidence?: boolean;
  }
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  await validateReviewCochangeTokenReadiness();

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

export function setReviewCommitResolverForTests(resolver: ((commitish: string) => CommitResolution) | null): void {
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
      }
    | null
): void {
  createWorkspaceForCommitFlow = overrides?.createWorkspace ?? createWorkspaceFromResolvedSource;
  resolveWorkspaceSourceForCommitFlow = overrides?.resolveWorkspaceSource ?? resolveWorkspaceSource;
  deployWorkspaceForCommitFlow = overrides?.deployWorkspace ?? workspaceDeployCommand;
  createReviewForCommitFlow = overrides?.createReview ?? createReview;
  streamReviewEventsForCommitFlow = overrides?.streamReviewEvents ?? streamReviewEvents;
  getReviewForCommitFlow = overrides?.getReview ?? getReview;
}

function buildWorkspaceIdempotencyKey(commitSha: string): string {
  return `workspace-${createHash('sha256').update(`${commitSha}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 20)}`;
}

function deriveIdempotencyKey(base: string, scope: 'deploy' | 'review'): string {
  return `${scope}-${createHash('sha256').update(`${base}:${scope}`).digest('hex').slice(0, 20)}`;
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
    projectRoot?: string;
    idempotencyKey?: string;
    severityThreshold?: 'low' | 'medium' | 'high' | 'critical';
    maxFindings?: number;
    model?: string;
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

  try {
    spinner.start('Resolving checkpoint...');
    try {
      const resolvedCommit = validateReviewCommitCheckpoint(commitish, process.cwd());
      commitSha = resolvedCommit.commitSha;
      checkpointId = resolvedCommit.checkpointId;
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

    spinner.start('Checking co-change token readiness...');
    try {
      const readiness = await validateReviewCochangeTokenReadiness();
      if (readiness === 'legacy_unknown') {
        spinner.stop('Co-change token readiness unknown on legacy worker (continuing)');
      } else {
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
          },
        }
      );
      reviewId = response.reviewId;
      reviewResultUrl = normalizeResultUrl(workerUrl, response.resultUrl);
      spinner.stop(`Review queued: ${reviewId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.stop('Review creation failed');
      throw new Error(`Review flow failed at review creation: ${message}`);
    }

    p.log.info(`Streaming review events for ${reviewId}`);
    let terminalStatus: string | null = null;
    let lastFailureEvent: Record<string, unknown> | null = null;
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

    const final = await getReviewForCommitFlow(workerUrl, reviewId);
    const status = typeof terminalStatus === 'string' ? terminalStatus : final.review.status;
    if (status !== 'succeeded') {
      throw new Error(formatReviewExecutionFailure(status, final.review, lastFailureEvent));
    }

    console.log(`Report URL: ${reviewResultUrl}`);
  } catch (error) {
    throw error;
  }
}
