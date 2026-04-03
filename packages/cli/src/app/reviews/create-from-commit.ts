import * as p from '@clack/prompts';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import { approveReviewPolicy, createReview, deriveReviewPolicy, getReview, streamReviewEvents } from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { formatEvent } from '../../commands/review/events.js';
import { GitRepo } from '../../lib/checkpoint/git.js';
import {
  resolveReviewContext,
  setReviewCommitResolverForTests,
  setReviewContextFlowForTests,
  type ReviewContextFlowOverrides,
} from './context.js';
import {
  buildIdempotencyKey,
  deriveIdempotencyKey,
  formatReviewExecutionFailure,
  normalizeResultUrl,
  ReviewCreateProvenance,
  sleep,
} from './create-shared.js';
import { startReviewStudioCommand } from './open.js';

let createReviewForCommitFlow: typeof createReview = createReview;
let deriveReviewPolicyForCommitFlow: typeof deriveReviewPolicy = deriveReviewPolicy;
let approveReviewPolicyForCommitFlow: typeof approveReviewPolicy = approveReviewPolicy;
let streamReviewEventsForCommitFlow: typeof streamReviewEvents = streamReviewEvents;
let getReviewForCommitFlow: typeof getReview = getReview;

export { setReviewCommitResolverForTests };

export function setReviewCreateFlowForTests(
  overrides:
    | {
        createWorkspace?: ReviewContextFlowOverrides['createWorkspace'];
        resolveWorkspaceSource?: ReviewContextFlowOverrides['resolveWorkspaceSource'];
        deployWorkspace?: ReviewContextFlowOverrides['deployWorkspace'];
        createReview?: typeof createReviewForCommitFlow;
        streamReviewEvents?: typeof streamReviewEventsForCommitFlow;
        getReview?: typeof getReviewForCommitFlow;
        resolveLocalCochange?: ReviewContextFlowOverrides['resolveLocalCochange'];
        deriveReviewPolicy?: typeof deriveReviewPolicyForCommitFlow;
        approveReviewPolicy?: typeof approveReviewPolicyForCommitFlow;
      }
    | null
): void {
  setReviewContextFlowForTests(
    overrides
      ? {
          createWorkspace: overrides.createWorkspace,
          resolveWorkspaceSource: overrides.resolveWorkspaceSource,
          deployWorkspace: overrides.deployWorkspace,
          resolveLocalCochange: overrides.resolveLocalCochange,
        }
      : null
  );
  createReviewForCommitFlow = overrides?.createReview ?? createReview;
  deriveReviewPolicyForCommitFlow = overrides?.deriveReviewPolicy ?? deriveReviewPolicy;
  approveReviewPolicyForCommitFlow = overrides?.approveReviewPolicy ?? approveReviewPolicy;
  streamReviewEventsForCommitFlow = overrides?.streamReviewEvents ?? streamReviewEvents;
  getReviewForCommitFlow = overrides?.getReview ?? getReview;
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

export async function createReviewFromCommitCommand(
  options?: {
    commitish?: string;
    baseRef?: string;
    outputReviewIdPath?: string;
    projectRoot?: string;
    idempotencyKey?: string;
    policyMode?: 'none' | 'auto' | 'review';
    reviewBasis?: 'checkpoint' | 'environment';
    openStudio?: boolean;
    openStudioPort?: number;
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
  const policyMode = options?.policyMode ?? 'none';
  const reviewBasis = options?.reviewBasis ?? 'checkpoint';
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
    if (policyMode === 'none') {
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
        policyMode,
        reviewBasis,
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
    } else {
      const derived = await deriveReviewPolicyForCommitFlow(workerUrl, {
        workspaceId,
        deploymentId,
        policyMode,
        reviewBasis,
        provenance: resolvedProvenance ?? undefined,
      });
      reviewId = derived.reviewId;
      reviewResultUrl = normalizeResultUrl(workerUrl, `/api/reviews/${encodeURIComponent(reviewId)}`);
      if (policyMode === 'auto') {
        await approveReviewPolicyForCommitFlow(workerUrl, reviewId, { approvedPolicy: derived.derivedPolicy });
        spinner.stop(`Policy auto-approved; review queued: ${reviewId}`);
      } else {
        spinner.stop(`Policy ready for review: ${reviewId}`);
      }
    }

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

  if (options?.openStudio) {
    await startReviewStudioCommand({
      port: options.openStudioPort,
      routePath:
        policyMode === 'review'
          ? `/policy/${encodeURIComponent(reviewId)}`
          : `/reports/${encodeURIComponent(reviewId)}`,
      detach: true,
    });
  }

  if (policyMode === 'review') {
    p.log.message('Policy review is required before execution. Open the policy page and approve to start the run.');
    console.log(`Report URL: ${reviewResultUrl}`);
    return;
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
