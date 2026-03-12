import * as p from '@clack/prompts';
import { createHash } from 'crypto';
import { createReview, getWorkerUrl } from '../../lib/api.js';

function buildIdempotencyKey(workspaceId: string, deploymentId: string): string {
  const seed = `${workspaceId}:${deploymentId}:${Date.now()}:${Math.random()}`;
  return `review-${createHash('sha256').update(seed).digest('hex').slice(0, 20)}`;
}

export async function createReviewCommand(
  workspaceId: string,
  deploymentId: string,
  options?: { idempotencyKey?: string }
): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  const response = await createReview(workerUrl, options?.idempotencyKey?.trim() || buildIdempotencyKey(workspaceId, deploymentId), {
    target: {
      type: 'workspace_deployment',
      workspaceId,
      deploymentId,
    },
    mode: 'report_only',
  });

  p.log.success(`Review queued: ${response.reviewId}`);
  p.log.message(`Status: ${response.status}`);
  p.log.message(`Result URL: ${response.resultUrl}`);
  p.log.message(`Events URL: ${response.eventsUrl}`);
}
