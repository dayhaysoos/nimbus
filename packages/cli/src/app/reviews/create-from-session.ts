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
  formatReviewExecutionFailure,
  normalizeResultUrl,
  sleep,
} from './create-shared.js';
import { startReviewStudioCommand } from './open.js';

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

async function pollReviewUntilTerminalStatus(
  workerUrl: string,
  reviewId: string,
  options?: { intervalMs?: number; timeoutMs?: number }
): Promise<Awaited<ReturnType<typeof getReviewForFlow>>> {
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
    const latest = await getReviewForFlow(workerUrl, reviewId);
    if (latest.review.status !== 'queued' && latest.review.status !== 'running') {
      return latest;
    }
    if (Date.now() >= deadline) {
      return latest;
    }
    await sleep(intervalMs);
  }
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
  let lastFailureEvent: Record<string, unknown> | null = null;
  let terminalStatus: string | null = null;
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
  try {
    await streamReviewEventsForFlow(workerUrl, reviewId, (event) => {
      const data = event.data ?? {};
      if (data.type === 'terminal' && typeof data.status === 'string') {
        terminalStatus = data.status;
      }
      if (data.type === 'error') {
        lastFailureEvent = data;
      }
      const line = formatEvent(event);
      if (line) {
        console.log(line);
      }
    });
  } catch (error) {
    p.log.warning(`Review event stream ended early: ${error instanceof Error ? error.message : String(error)}`);
  }

  const finalReview = await pollReviewUntilTerminalStatus(workerUrl, reviewId);
  terminalStatus = finalReview.review.status;
  if (finalReview.review.status !== 'succeeded') {
    throw new Error(formatReviewExecutionFailure(finalReview.review.status, finalReview.review, lastFailureEvent));
  }

  p.log.success(`Review completed: ${reviewId}`);
  console.log(`Report URL: ${reviewResultUrl}`);
}
