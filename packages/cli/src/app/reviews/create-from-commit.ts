import * as p from '@clack/prompts';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import { approveReviewPolicy, createReview, deriveReviewPolicy, getReview, getReviewSession, streamReviewEvents } from '../../clients/worker/reviews.js';
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
  buildStudioReviewRoutePath,
  buildIdempotencyKey,
  deriveIdempotencyKey,
  followReviewChain,
  formatReviewExecutionFailure,
  normalizeResultUrl,
  ReviewCreateProvenance,
} from './create-shared.js';
import { startReviewStudioCommand } from './open.js';
import { isTerminalReviewSessionPhase, maybeOfferReviewSessionAdoption } from './adoption.js';
import { printReviewSessionOutcome } from './session-outcome.js';

let createReviewForCommitFlow: typeof createReview = createReview;
let deriveReviewPolicyForCommitFlow: typeof deriveReviewPolicy = deriveReviewPolicy;
let approveReviewPolicyForCommitFlow: typeof approveReviewPolicy = approveReviewPolicy;
let streamReviewEventsForCommitFlow: typeof streamReviewEvents = streamReviewEvents;
let getReviewForCommitFlow: typeof getReview = getReview;
let getReviewSessionForCommitFlow: typeof getReviewSession = getReviewSession;

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
        getReviewSession?: typeof getReviewSessionForCommitFlow;
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
  getReviewSessionForCommitFlow = overrides?.getReviewSession ?? getReviewSession;
}

export async function createReviewFromCommitCommand(
  options?: {
    commitish?: string;
    baseRef?: string;
    lastCheckpoints?: number;
    checkpointRange?: string;
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
    workspaceReadyTimeoutMs?: number;
  }
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  let workspaceId = '';
  let deploymentId = '';
  let reviewId = '';
  let reviewSessionId: string | null = null;
  let reviewResultUrl = '';
  let resolvedProvenance: ReviewCreateProvenance | null = null;
  const outputReviewIdRaw = options?.outputReviewIdPath;
  const outputReviewIdPath = outputReviewIdRaw?.trim();
  if (outputReviewIdRaw !== undefined && !outputReviewIdPath) {
    p.log.warning('Ignoring --output-review-id because the provided path is empty.');
  }
  const writeOutputReviewId = async (resolvedReviewId: string): Promise<void> => {
    if (!outputReviewIdPath) {
      return;
    }
    try {
      const repoRoot = new GitRepo(process.cwd()).getRepoRoot();
      const workspaceDir =
        typeof process.env.GITHUB_WORKSPACE === 'string' && process.env.GITHUB_WORKSPACE.trim()
          ? process.env.GITHUB_WORKSPACE.trim()
          : null;
      let baseDir = repoRoot;
      if (workspaceDir) {
        const resolvedWorkspaceDir = resolve(workspaceDir);
        const resolvedRepoRoot = resolve(repoRoot);
        if (resolvedWorkspaceDir === resolvedRepoRoot || resolvedWorkspaceDir.startsWith(`${resolvedRepoRoot}/`)) {
          baseDir = resolvedWorkspaceDir;
        } else {
          p.log.warning(
            `Ignoring GITHUB_WORKSPACE=${workspaceDir} because it is outside the repository root; resolving --output-review-id from repo root instead.`
          );
        }
      }
      const absolutePath = isAbsolute(outputReviewIdPath) ? outputReviewIdPath : resolve(baseDir, outputReviewIdPath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, `${resolvedReviewId}\n`, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not write review ID file at ${outputReviewIdPath}: ${message}. Review creation failed because downstream automation expects this file.`
      );
    }
  };
  const policyMode = options?.policyMode ?? 'none';
  const reviewBasis = options?.reviewBasis ?? 'checkpoint';
  const spinner = p.spinner();

  const resolved = await resolveReviewContext({
    commitish: options?.commitish,
    baseRef: options?.baseRef,
    lastCheckpoints: options?.lastCheckpoints,
    checkpointRange: options?.checkpointRange,
    projectRoot: options?.projectRoot,
    idempotencyKey: options?.idempotencyKey,
    pollIntervalMs: options?.pollIntervalMs,
    workspaceReadyTimeoutMs: options?.workspaceReadyTimeoutMs,
    intentSummaryModel: options?.intentSummaryModel,
  });
  workspaceId = resolved.workspaceId;
  deploymentId = resolved.deploymentId;
  resolvedProvenance = resolved.resolvedProvenance;
  const effectivePolicyMode =
    resolvedProvenance?.reviewContextMode === 'basic' && policyMode !== 'none'
      ? (p.log.warning('Entire intent context is unavailable for this target; skipping policy derivation and continuing with a basic review.'), 'none' as const)
      : policyMode;

  spinner.start('Creating review...');
  try {
    if (effectivePolicyMode === 'none') {
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
        policyMode: effectivePolicyMode,
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
      reviewSessionId = response.sessionId ?? null;
      reviewResultUrl = normalizeResultUrl(workerUrl, response.resultUrl);
      spinner.stop(`Review queued: ${reviewId}`);
    } else {
      const derived = await deriveReviewPolicyForCommitFlow(workerUrl, {
        workspaceId,
        deploymentId,
        policyMode: effectivePolicyMode,
        reviewBasis,
        provenance: resolvedProvenance ?? undefined,
      });
      reviewId = derived.reviewId;
      reviewSessionId = derived.sessionId ?? null;
      reviewResultUrl = normalizeResultUrl(workerUrl, `/api/reviews/${encodeURIComponent(reviewId)}`);
      if (policyMode === 'auto') {
        await approveReviewPolicyForCommitFlow(workerUrl, reviewId, { approvedPolicy: derived.derivedPolicy });
        spinner.stop(`Policy auto-approved; review queued: ${reviewId}`);
      } else {
        spinner.stop(`Policy ready for review: ${reviewId}`);
      }
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Review creation failed');
    throw new Error(`Review flow failed at review creation: ${message}`);
  }

  if (reviewSessionId) {
    p.log.message(`Review session: ${reviewSessionId}`);
  }

  if (options?.openStudio) {
    await startReviewStudioCommand({
      port: options.openStudioPort,
      routePath: buildStudioReviewRoutePath({
        reviewId,
        route: 'reports',
        repo: resolvedProvenance?.repo,
        branch: resolvedProvenance?.branch,
      }),
      detach: true,
    });
  }

  if (effectivePolicyMode === 'review') {
    await writeOutputReviewId(reviewId);
    p.log.message('Policy review is required before execution. Open the Review Run page and approve policy to start the run.');
    console.log(`Report URL: ${reviewResultUrl}`);
    return;
  }

  p.log.info(`Streaming review events for ${reviewId}`);
  const final = await followReviewChain({
    workerUrl,
    initialReviewId: reviewId,
    initialResultUrl: reviewResultUrl,
    streamReviewEvents: streamReviewEventsForCommitFlow,
    getReview: getReviewForCommitFlow,
    getReviewSession: getReviewSessionForCommitFlow,
    formatEvent,
    onStreamWarning: (message) => p.log.warning(message),
    onFollowupReview: (nextReviewId) => p.log.info(`Continuing review session with follow-up pass ${nextReviewId}`),
    pollIntervalMs: options?.pollIntervalMs,
  });

  if (final.finalReview.review.status !== 'succeeded') {
    if (
      final.finalReview.review.status === 'policy_pending' ||
      final.finalReview.review.status === 'policy_ready'
    ) {
      await writeOutputReviewId(final.finalReviewId);
      p.log.message('Review is waiting on policy approval before execution can continue.');
      console.log(`Report URL: ${final.finalResultUrl}`);
      return;
    }
    if (final.finalReview.review.status === 'policy_approved') {
      await writeOutputReviewId(final.finalReviewId);
      p.log.message('Policy is approved; execution is starting. Continue watching review events for completion.');
      console.log(`Report URL: ${final.finalResultUrl}`);
      return;
    }
    await writeOutputReviewId(final.finalReviewId);
    throw new Error(formatReviewExecutionFailure(final.finalReview.review.status, final.finalReview.review, final.lastFailureEvent));
  }

  await writeOutputReviewId(final.finalReviewId);
  const finalSession = final.finalSession ?? final.finalReview.session ?? null;
  if (finalSession && isTerminalReviewSessionPhase(finalSession.phase) && !final.sessionContinuationPending) {
    printReviewSessionOutcome(finalSession, { detailed: false, heading: 'Session Outcome:' });
  }
  console.log(`Report URL: ${final.finalResultUrl}`);
  if (finalSession && (!isTerminalReviewSessionPhase(finalSession.phase) || final.sessionContinuationPending)) {
    p.log.message(`Review session ${finalSession.id} is still active. Continue watching with \`nimbus review session show ${finalSession.id}\`.`);
    return;
  }
  await maybeOfferReviewSessionAdoption(finalSession);
}
