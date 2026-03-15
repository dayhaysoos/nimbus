import { strict as assert } from 'assert';
import worker from './index.js';

type WorkerModule = {
  fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>;
};

const handler = worker as WorkerModule;

export async function runIndexTests(): Promise<void> {
  {
    const response = await handler.fetch(
      new Request('https://example.workers.dev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'x' }),
      }),
      {
        AGENT_SDK_AUTH_TOKEN: 'expected-token',
        OPENROUTER_API_KEY: 'test-key',
      }
    );
    assert.equal(response.status, 401);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, 'unauthorized');
  }

  {
    const response = await handler.fetch(
      new Request('https://example.workers.dev', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer expected-token',
        },
        body: JSON.stringify({ mode: 'workspace_task', prompt: 'General coding task prompt', history: [] }),
      }),
      {
        AGENT_SDK_AUTH_TOKEN: 'expected-token',
        OPENROUTER_API_KEY: 'test-key',
      }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof body.action, 'object');
  }

  {
    const originalFetch = globalThis.fetch;
    let capturedOpenRouterAuth = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      capturedOpenRouterAuth = headers.get('Authorization') ?? '';
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ findings: [], summary: 'ok', furtherPassesLowYield: true }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const response = await handler.fetch(
        new Request('https://example.workers.dev', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer expected-token',
            'X-Openrouter-Api-Key': 'request-key',
          },
          body: JSON.stringify({
            mode: 'workspace_task',
            prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
            history: [],
          }),
        }),
        {
          AGENT_SDK_AUTH_TOKEN: 'expected-token',
          OPENROUTER_API_KEY: 'env-key',
        }
      );
      assert.equal(response.status, 200);
      assert.equal(capturedOpenRouterAuth, 'Bearer request-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const response = await handler.fetch(
      new Request('https://example.workers.dev', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer expected-token',
        },
        body: JSON.stringify({
          mode: 'workspace_task',
          prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
          history: [],
        }),
      }),
      {
        AGENT_SDK_AUTH_TOKEN: 'expected-token',
      }
    );
    assert.equal(response.status, 500);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, 'missing_openrouter_api_key');
    assert.equal(JSON.stringify(body).includes('request-key'), false);
  }
}
