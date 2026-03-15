import { strict as assert } from 'assert';
import { createReviewQueueMessage } from './lib/review-queue.js';
import { dispatchReviewToRunner, handleReviewQueueDispatch } from './lib/review-dispatch.js';

function createReviewMessage(body: unknown) {
  let retryCount = 0;
  return {
    message: {
      body,
      retry() {
        retryCount += 1;
      },
    },
    getRetryCount() {
      return retryCount;
    },
  };
}

export async function runReviewQueueDispatchTests(): Promise<void> {
  {
    const handoffBodies: Array<Record<string, unknown>> = [];
    const ids: string[] = [];
    const { message, getRetryCount } = createReviewMessage(
      createReviewQueueMessage('rev_abcd1234', 'ghp_user_token_123', 'or_user_token_123')
    );
    const env = {
      ReviewRunner: {
        idFromName(name: string) {
          ids.push(name);
          return `do-${name}`;
        },
        get() {
          return {
            async fetch(_input: RequestInfo | URL, init?: RequestInit) {
              const body = typeof init?.body === 'string' ? init.body : '{}';
              handoffBodies.push(JSON.parse(body) as Record<string, unknown>);
              return new Response(JSON.stringify({ accepted: true }), { status: 202 });
            },
          };
        },
      },
    } as unknown as Record<string, unknown>;

    await dispatchReviewToRunner(env as never, message.body as never);

    assert.deepEqual(ids, ['rev_abcd1234']);
    assert.equal(handoffBodies.length, 1);
    assert.equal(handoffBodies[0]?.reviewId, 'rev_abcd1234');
    assert.equal(handoffBodies[0]?.cochangeGithubToken, 'ghp_user_token_123');
    assert.equal(handoffBodies[0]?.openrouterApiKey, 'or_user_token_123');
    assert.equal(getRetryCount(), 0);
  }

  {
    const { message, getRetryCount } = createReviewMessage(createReviewQueueMessage('rev_retry123'));
    const env = {
      ReviewRunner: {
        idFromName(name: string) {
          return `do-${name}`;
        },
        get() {
          return {
            async fetch() {
              return new Response('handoff failed', { status: 503 });
            },
          };
        },
      },
    } as unknown as Record<string, unknown>;

    await handleReviewQueueDispatch(env as never, message.body as never, message as never);
    assert.equal(getRetryCount(), 1);
  }

  {
    const { message, getRetryCount } = createReviewMessage(createReviewQueueMessage('rev_missing_binding'));
    const env = {} as unknown as Record<string, unknown>;

    await handleReviewQueueDispatch(env as never, message.body as never, message as never);
    assert.equal(getRetryCount(), 1);
  }
}
