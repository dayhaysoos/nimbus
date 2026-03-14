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
}
