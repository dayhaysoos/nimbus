import * as p from '@clack/prompts';
import {
  createReviewSessionPass,
  getReview,
  getReviewSession,
  streamReviewEvents,
} from '../../clients/worker/reviews.js';
import { getWorkerUrl } from '../../clients/worker/shared.js';
import { formatEvent } from '../../commands/review/events.js';
import {
  buildStudioReviewRoutePath,
  followReviewChain,
  formatReviewExecutionFailure,
  normalizeResultUrl,
} from './create-shared.js';
import { startReviewStudioCommand } from './open.js';
import { printReviewSessionOutcome } from './session-outcome.js';

let createReviewSessionPassForFlow: typeof createReviewSessionPass = createReviewSessionPass;
let getReviewForFlow: typeof getReview = getReview;
let getReviewSessionForFlow: typeof getReviewSession = getReviewSession;
let streamReviewEventsForFlow: typeof streamReviewEvents = streamReviewEvents;

export function setReviewSessionCreateFlowForTests(
  overrides:
    | {
        createReviewSessionPass?: typeof createReviewSessionPassForFlow;
        getReview?: typeof getReviewForFlow;
        getReviewSession?: typeof getReviewSessionForFlow;
        streamReviewEvents?: typeof streamReviewEventsForFlow;
      }
    | null
): void {
  createReviewSessionPassForFlow = overrides?.createReviewSessionPass ?? createReviewSessionPass;
  getReviewForFlow = overrides?.getReview ?? getReview;
  getReviewSessionForFlow = overrides?.getReviewSession ?? getReviewSession;
  streamReviewEventsForFlow = overrides?.streamReviewEvents ?? streamReviewEvents;
}

export async function createReviewSessionCommand(
  sessionId: string,
  options?: {
    idempotencyKey?: string;
    openStudio?: boolean;
    openStudioPort?: number;
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

  let reviewId = '';
  let reviewResultUrl = '';
  const spinner = p.spinner();

  spinner.start('Creating environment review pass...');
  try {
    const response = await createReviewSessionPassForFlow(
      workerUrl,
      sessionId,
      {
        reviewBasis: 'environment',
        policy: {
          severityThreshold: options?.severityThreshold ?? 'low',
          maxFindings: options?.maxFindings,
          includeProvenance: options?.includeProvenance ?? true,
          includeValidationEvidence: options?.includeValidationEvidence ?? true,
        },
        model: options?.model,
      },
      {
        idempotencyKey: options?.idempotencyKey,
      }
    );
    reviewId = response.reviewId;
    reviewResultUrl = normalizeResultUrl(workerUrl, response.resultUrl);
    spinner.stop(`Environment review queued: ${reviewId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.stop('Environment review creation failed');
    throw new Error(`Review flow failed at review creation: ${message}`);
  }

  p.log.message(`Review session: ${sessionId}`);
  p.log.message('Review basis: environment');

  if (options?.openStudio) {
    const { session } = await getReviewSessionForFlow(workerUrl, sessionId);
    await startReviewStudioCommand({
      port: options.openStudioPort,
      routePath: buildStudioReviewRoutePath({
        reviewId,
        route: 'reports',
        repo: session.repo,
        branch: session.branch,
      }),
      detach: true,
    });
  }

  p.log.info(`Streaming review events for ${reviewId}`);
  const final = await followReviewChain({
    workerUrl,
    initialReviewId: reviewId,
    initialResultUrl: reviewResultUrl,
    streamReviewEvents: streamReviewEventsForFlow,
    getReview: getReviewForFlow,
    getReviewSession: getReviewSessionForFlow,
    formatEvent,
    onStreamWarning: (message) => p.log.warning(message),
    onFollowupReview: (nextReviewId) => p.log.info(`Continuing review session with follow-up pass ${nextReviewId}`),
  });

  if (final.finalReview.review.status !== 'succeeded') {
    if (
      final.finalReview.review.status === 'policy_pending' ||
      final.finalReview.review.status === 'policy_ready'
    ) {
      p.log.message('Review is waiting on policy approval before execution can continue.');
      console.log(`Report URL: ${final.finalResultUrl}`);
      return;
    }
    if (final.finalReview.review.status === 'policy_approved') {
      p.log.message('Policy is approved; execution is starting. Continue watching review events for completion.');
      console.log(`Report URL: ${final.finalResultUrl}`);
      return;
    }
    throw new Error(formatReviewExecutionFailure(final.finalReview.review.status, final.finalReview.review, final.lastFailureEvent));
  }

  p.log.success(`Review completed: ${final.finalReviewId}`);
  if (final.finalReview.session) {
    printReviewSessionOutcome(final.finalReview.session, { detailed: false, heading: 'Session Outcome:' });
  }
  console.log(`Report URL: ${final.finalResultUrl}`);
}
