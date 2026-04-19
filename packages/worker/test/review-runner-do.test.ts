import { strict as assert } from 'assert';
import { ReviewRunner, setReviewRunnerExecutorForTests } from '../src/review-runner-do.js';

type StoredValue = Record<string, unknown>;

function createDurableObjectState() {
  const storage = new Map<string, StoredValue>();
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    state: {
      storage: {
        async get<T>(key: string): Promise<T | undefined> {
          return storage.get(key) as T | undefined;
        },
        async put(key: string, value: StoredValue): Promise<void> {
          storage.set(key, value);
        },
      },
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    } as unknown as DurableObjectState,
    storage,
    waitUntilPromises,
  };
}

function readStatus(storage: Map<string, StoredValue>): string | null {
  const state = storage.get('state');
  return typeof state?.status === 'string' ? state.status : null;
}

function createReviewStateDb(statusProvider: () => string) {
  return {
    prepare(sql: string) {
      if (/SELECT \* FROM review_runs WHERE id = \?/i.test(sql)) {
        return {
          bind() {
            return {
              async first<T>() {
                return { status: statusProvider() } as T;
              },
            };
          },
        };
      }
      throw new Error(`Unexpected SQL in ReviewRunner DO test DB: ${sql}`);
    },
  };
}

export async function runReviewRunnerDurableObjectTests(): Promise<void> {
  {
    const durable = createDurableObjectState();
    let started = false;
    let release: (() => void) | null = null;
    setReviewRunnerExecutorForTests(async (_env, reviewId, _maxCycles, options) => {
      assert.equal(reviewId, 'rev_abcd1234');
      assert.equal(options?.cochangeGithubToken, 'ghp_user_token_123');
      assert.equal(options?.openrouterApiKey, 'or_user_token_123');
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const runner = new ReviewRunner(durable.state, {} as never);
    const response = await runner.fetch(
      new Request('https://review-runner/run', {
        method: 'POST',
        body: JSON.stringify({
          reviewId: 'rev_abcd1234',
          cochangeGithubToken: 'ghp_user_token_123',
          openrouterApiKey: 'or_user_token_123',
        }),
      })
    );

    assert.equal(response.status, 202);
    await Promise.resolve();
    assert.equal(started, true);
    assert.equal(readStatus(durable.storage), 'running');

    if (!release) {
      throw new Error('expected release callback to be set');
    }
    const releaseFn: () => void = release;
    releaseFn();
    await Promise.all(durable.waitUntilPromises);
    assert.equal(readStatus(durable.storage), 'completed');
    setReviewRunnerExecutorForTests(null);
  }

  {
    const durable = createDurableObjectState();
    let reviewStatus = 'running';
    setReviewRunnerExecutorForTests(async () => {
      await new Promise(() => {
        // Keep running to simulate duplicate handoff while active.
      });
    });

    const runner = new ReviewRunner(durable.state, { DB: createReviewStateDb(() => reviewStatus) } as never);
    const first = await runner.fetch(
      new Request('https://review-runner/run', {
        method: 'POST',
        body: JSON.stringify({ reviewId: 'rev_dup' }),
      })
    );
    assert.equal(first.status, 202);

    const second = await runner.fetch(
      new Request('https://review-runner/run', {
        method: 'POST',
        body: JSON.stringify({ reviewId: 'rev_dup' }),
      })
    );
    assert.equal(second.status, 202);
    const payload = (await second.json()) as { status?: string };
    assert.equal(payload.status, 'already_running');
    setReviewRunnerExecutorForTests(null);
  }

  {
    const durable = createDurableObjectState();
    let reviewStatus = 'running';
    let callCount = 0;
    let releaseFirst: (() => void) | null = null;
    setReviewRunnerExecutorForTests(async () => {
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        throw new Error('superseded attempt failed after retry started');
      }
    });

    const runner = new ReviewRunner(durable.state, { DB: createReviewStateDb(() => reviewStatus) } as never);
    const first = await runner.fetch(
      new Request('https://review-runner/run', {
        method: 'POST',
        body: JSON.stringify({ reviewId: 'rev_recovered' }),
      })
    );
    assert.equal(first.status, 202);
    await Promise.resolve();
    assert.equal(callCount, 1);
    assert.equal(readStatus(durable.storage), 'running');

    reviewStatus = 'queued';
    const second = await runner.fetch(
      new Request('https://review-runner/run', {
        method: 'POST',
        body: JSON.stringify({ reviewId: 'rev_recovered' }),
      })
    );
    assert.equal(second.status, 202);
    const payload = (await second.json()) as { status?: string };
    assert.equal(payload.status, 'started');
    await Promise.resolve();
    assert.equal(callCount, 2);

    if (!releaseFirst) {
      throw new Error('expected release callback to be set for superseded retry test');
    }
    const releaseFirstExecution: () => void = releaseFirst;
    releaseFirstExecution();
    await Promise.all(durable.waitUntilPromises);

    const finalState = durable.storage.get('state');
    assert.equal(finalState?.status, 'completed');
    assert.equal(finalState?.lastError, null);
    setReviewRunnerExecutorForTests(null);
  }
}
