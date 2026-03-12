const REVIEW_ID_REGEX = /^[a-z0-9_]+$/;

export interface ReviewQueueMessage {
  type: 'review_requested';
  reviewId: string;
  queuedAt: string;
}

export function createReviewQueueMessage(reviewId: string): ReviewQueueMessage {
  return {
    type: 'review_requested',
    reviewId,
    queuedAt: new Date().toISOString(),
  };
}

export function parseReviewQueueMessage(payload: unknown): ReviewQueueMessage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid review queue payload: expected object');
  }

  const record = payload as Record<string, unknown>;
  if (record.type !== 'review_requested') {
    throw new Error('Invalid review queue payload type');
  }
  if (typeof record.reviewId !== 'string' || !REVIEW_ID_REGEX.test(record.reviewId)) {
    throw new Error('Invalid review queue payload reviewId');
  }
  if (typeof record.queuedAt !== 'string' || Number.isNaN(Date.parse(record.queuedAt))) {
    throw new Error('Invalid review queue payload queuedAt');
  }

  return {
    type: 'review_requested',
    reviewId: record.reviewId,
    queuedAt: record.queuedAt,
  };
}
