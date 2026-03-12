import * as p from '@clack/prompts';
import { getWorkerUrl, streamReviewEvents } from '../../lib/api.js';
import type { ReviewEventEnvelope } from '../../lib/types.js';

function formatEvent(event: ReviewEventEnvelope): string {
  const type = typeof event.data.type === 'string' ? event.data.type : 'event';
  if (type === 'snapshot') {
    const status = typeof event.data.status === 'string' ? event.data.status : 'unknown';
    return `[snapshot] status=${status}`;
  }
  if (type === 'terminal') {
    const status = typeof event.data.status === 'string' ? event.data.status : 'unknown';
    return `[terminal] status=${status}`;
  }
  if (type === 'heartbeat') {
    return '';
  }
  if (type === 'error') {
    const message = typeof event.data.message === 'string' ? event.data.message : 'unknown error';
    return `[error] ${message}`;
  }

  const seq = typeof event.data.seq === 'number' ? event.data.seq : event.id ?? '?';
  const createdAt = typeof event.data.createdAt === 'string' ? ` ${event.data.createdAt}` : '';
  return `[${seq}] ${type}${createdAt}`;
}

export async function reviewEventsCommand(reviewId: string): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    throw new Error('NIMBUS_WORKER_URL environment variable is required');
  }

  p.log.info(`Streaming review events for ${reviewId}`);
  await streamReviewEvents(workerUrl, reviewId, async (event) => {
    const line = formatEvent(event);
    if (!line) {
      return;
    }
    console.log(line);
  });
}
