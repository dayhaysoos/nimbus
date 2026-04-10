import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { proxyApiRequest, setUiProxyHooksForTests } from '../../../src/app/reviews/ui-proxy.js';

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, string>();
  body = '';

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders(): void {}

  write(chunk: string): void {
    this.body += chunk;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
  }
}

export async function runUiProxyTests(): Promise<void> {
  let capturedSignal: AbortSignal | undefined;

  setUiProxyHooksForTests({
    startStudioNewReview: async (options) => {
      capturedSignal = options.signal;
      await options.onEvent?.({
        type: 'stage',
        stage: 'review_creation',
        state: 'active',
        label: 'Creating review',
        detail: 'detail',
      });
      return {
        reviewId: 'rev_123',
        routePath: '/reports/rev_123',
        policyMode: options.policyMode,
        status: options.policyMode === 'review' ? 'policy_ready' : 'queued',
      };
    },
  });

  try {
    const request = {
      method: 'GET',
      url: '/api/studio/new-review/start/events?policyMode=auto',
    } as IncomingMessage;
    const response = new MockResponse() as unknown as ServerResponse;

    const handled = await proxyApiRequest(
      request,
      response,
      'https://worker.example.com',
      null,
      null,
      null
    );

    assert.equal(handled, true);
    assert.equal(Boolean(capturedSignal), true);
    assert.match((response as unknown as MockResponse).body, /"type":"stage"/);
  } finally {
    setUiProxyHooksForTests(null);
  }

  let abortOnCloseSignal: AbortSignal | undefined;
  setUiProxyHooksForTests({
    startStudioNewReview: async (options) => {
      abortOnCloseSignal = options.signal;
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        reviewId: 'rev_456',
        routePath: '/reports/rev_456',
        policyMode: options.policyMode,
        status: 'queued',
      };
    },
  });

  try {
    const request = {
      method: 'GET',
      url: '/api/studio/new-review/start/events?policyMode=auto',
    } as IncomingMessage;
    const response = new MockResponse() as unknown as ServerResponse;

    const handledPromise = proxyApiRequest(
      request,
      response,
      'https://worker.example.com',
      null,
      null,
      null
    );

    await new Promise((resolve) => setImmediate(resolve));
    (response as unknown as MockResponse).emit('close');
    const handled = await handledPromise;
    assert.equal(handled, true);
    assert.equal(abortOnCloseSignal?.aborted, true);
  } finally {
    setUiProxyHooksForTests(null);
  }
}
