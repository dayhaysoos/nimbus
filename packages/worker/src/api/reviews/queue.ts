import { appendReviewEvent, hasReviewEvent } from '../../lib/db.js';
import { createReviewQueueMessage } from '../../lib/review-queue.js';
import type { Env } from '../../types.js';
import { validateRecoveredReviewRetryAuth } from './recovery.js';
import { jsonResponse } from './shared.js';

interface QueueableReview {
  id: string;
  status: string;
  attemptCount: number;
  error?: { code?: string | null } | null;
}

export async function enqueueReviewRunIfNeeded(
  env: Env,
  review: QueueableReview,
  options: {
    reused: boolean;
    reviewGithubToken: string | null;
    providerApiKey: string | null;
    openrouterApiKey: string | null;
  }
): Promise<Response | null> {
  if (review.status !== 'queued') {
    return null;
  }

  const alreadyEnqueued = await hasReviewEvent(env.DB, review.id, 'review_enqueued');
  const shouldReenqueueRecoveredReview =
    options.reused && (review.error?.code === 'retry_scheduled' || review.attemptCount > 0);
  const requiresOpenrouterRetryKey = review.error?.code === 'missing_openrouter_api_key';
  const requiresProviderRetryKey = review.error?.code === 'missing_provider_api_key';

  if (alreadyEnqueued && !shouldReenqueueRecoveredReview) {
    return null;
  }

  const authRetryError = await validateRecoveredReviewRetryAuth(
    env,
    review.id,
    shouldReenqueueRecoveredReview,
    options.reviewGithubToken
  );
  if (authRetryError) {
    return authRetryError;
  }

  if (shouldReenqueueRecoveredReview && requiresOpenrouterRetryKey && !options.openrouterApiKey) {
    return jsonResponse(
      {
        error: 'OpenRouter API key required for retry',
        code: 'missing_openrouter_api_key',
      },
      409
    );
  }
  if (shouldReenqueueRecoveredReview && requiresProviderRetryKey && !options.providerApiKey) {
    return jsonResponse(
      {
        error: 'Provider API key required for retry',
        code: 'missing_provider_api_key',
      },
      409
    );
  }

  await env.REVIEWS_QUEUE?.send(
    createReviewQueueMessage(review.id, options.reviewGithubToken, options.providerApiKey, options.openrouterApiKey)
  );
  await appendReviewEvent(env.DB, {
    reviewId: review.id,
    eventType: 'review_enqueued',
    payload: {
      mode: 'queue',
      reused: options.reused,
      recovered: shouldReenqueueRecoveredReview,
    },
  });

  return null;
}

export async function enqueueApprovedReviewRun(
  env: Env,
  reviewId: string,
  reviewGithubToken: string | null,
  providerApiKey: string | null,
  openrouterApiKey: string | null
): Promise<void> {
  await env.REVIEWS_QUEUE?.send(createReviewQueueMessage(reviewId, reviewGithubToken, providerApiKey, openrouterApiKey));
  await appendReviewEvent(env.DB, {
    reviewId,
    eventType: 'review_enqueued',
    payload: {
      mode: 'queue',
      policyApproved: true,
    },
  });
}
