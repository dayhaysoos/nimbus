import { strict as assert } from 'assert';
import { createReviewQueueMessage, parseReviewQueueMessage } from './review-queue.js';

export async function runReviewQueueTests(): Promise<void> {
  const message = createReviewQueueMessage('rev_abcd1234');
  assert.equal(message.type, 'review_requested');
  assert.equal(message.reviewId, 'rev_abcd1234');
  assert.equal(Number.isNaN(Date.parse(message.queuedAt)), false);

  const parsed = parseReviewQueueMessage(message);
  assert.deepEqual(parsed, message);

  const tokenMessage = createReviewQueueMessage('rev_abcd1234', 'ghp_user_token_123');
  assert.equal(tokenMessage.cochangeGithubToken, 'ghp_user_token_123');
  assert.deepEqual(parseReviewQueueMessage(tokenMessage), tokenMessage);

  assert.throws(() => parseReviewQueueMessage({ type: 'review_requested', reviewId: 'bad id' }), /reviewId/);
  assert.throws(
    () => parseReviewQueueMessage({ type: 'review_requested', reviewId: 'rev_abcd1234', queuedAt: new Date().toISOString(), cochangeGithubToken: '' }),
    /cochangeGithubToken/
  );
}
