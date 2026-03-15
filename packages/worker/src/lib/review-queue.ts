const REVIEW_ID_REGEX = /^[a-z0-9_]+$/;

export interface ReviewQueueMessage {
  type: 'review_requested';
  reviewId: string;
  queuedAt: string;
  cochangeGithubToken?: string;
  openrouterApiKey?: string;
}

export function createReviewQueueMessage(
  reviewId: string,
  cochangeGithubToken?: string | null,
  openrouterApiKey?: string | null
): ReviewQueueMessage {
  const message: ReviewQueueMessage = {
    type: 'review_requested',
    reviewId,
    queuedAt: new Date().toISOString(),
  };
  if (typeof cochangeGithubToken === 'string' && cochangeGithubToken.trim()) {
    message.cochangeGithubToken = cochangeGithubToken.trim();
  }
  if (typeof openrouterApiKey === 'string' && openrouterApiKey.trim()) {
    message.openrouterApiKey = openrouterApiKey.trim();
  }
  return message;
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
  if (record.cochangeGithubToken !== undefined && (typeof record.cochangeGithubToken !== 'string' || !record.cochangeGithubToken.trim())) {
    throw new Error('Invalid review queue payload cochangeGithubToken');
  }
  if (record.openrouterApiKey !== undefined && (typeof record.openrouterApiKey !== 'string' || !record.openrouterApiKey.trim())) {
    throw new Error('Invalid review queue payload openrouterApiKey');
  }

  const parsed: ReviewQueueMessage = {
    type: 'review_requested',
    reviewId: record.reviewId,
    queuedAt: record.queuedAt,
  };
  if (typeof record.cochangeGithubToken === 'string' && record.cochangeGithubToken.trim()) {
    parsed.cochangeGithubToken = record.cochangeGithubToken.trim();
  }
  if (typeof record.openrouterApiKey === 'string' && record.openrouterApiKey.trim()) {
    parsed.openrouterApiKey = record.openrouterApiKey.trim();
  }
  return parsed;
}
