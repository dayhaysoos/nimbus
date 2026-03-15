import type { Env } from '../types.js';
import type { ReviewQueueMessage } from './review-queue.js';
import { shouldRetryReviewError } from './review-runner.js';

export async function dispatchReviewToRunner(env: Env, payload: ReviewQueueMessage): Promise<void> {
  if (!env.ReviewRunner) {
    throw new Error('ReviewRunner durable object binding is missing');
  }

  const doId = env.ReviewRunner.idFromName(payload.reviewId);
  const doStub = env.ReviewRunner.get(doId);
  const handoffResponse = await doStub.fetch('https://review-runner/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewId: payload.reviewId,
      cochangeGithubToken: payload.cochangeGithubToken,
    }),
  });

  if (!handoffResponse.ok) {
    throw new Error(`review runner handoff failed: ${handoffResponse.status}`);
  }
}

export async function handleReviewQueueDispatch(
  env: Env,
  payload: ReviewQueueMessage,
  message: { retry: () => void }
): Promise<void> {
  try {
    await dispatchReviewToRunner(env, payload);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(`[review-queue] message handling failed: ${details}`);
    // Retry all DO dispatch failures to avoid dropping queued reviews.
    message.retry();
  }
}
