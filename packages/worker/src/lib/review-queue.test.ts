import { strict as assert } from 'assert';
import { createReviewQueueMessage, parseReviewQueueMessage } from './review-queue.js';

export async function runReviewQueueTests(): Promise<void> {
  const message = createReviewQueueMessage('rev_abcd1234');
  assert.equal(message.type, 'review_requested');
  assert.equal(message.reviewId, 'rev_abcd1234');
  assert.equal(Number.isNaN(Date.parse(message.queuedAt)), false);

  const parsed = parseReviewQueueMessage(message);
  assert.deepEqual(parsed, message);

  assert.throws(() => parseReviewQueueMessage({ type: 'review_requested', reviewId: 'bad id' }), /reviewId/);
}
