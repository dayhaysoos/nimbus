import { strict as assert } from 'assert';
import worker from '../src/index.js';

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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  type: 'tool',
                  tool: 'write_file',
                  args: {
                    path: 'src/normalize-port.js',
                    content: 'export function normalizePort(raw) { return raw; }\n',
                    command: null,
                    maxBytes: null,
                    timeoutMs: null,
                  },
                  summary: null,
                }),
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
          },
          body: JSON.stringify({ mode: 'workspace_task', prompt: 'General coding task prompt', history: [] }),
        }),
        {
          AGENT_SDK_AUTH_TOKEN: 'expected-token',
          OPENROUTER_API_KEY: 'test-key',
        }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { action?: { type?: string; tool?: string } };
      assert.equal(body.action?.type, 'tool');
      assert.equal(body.action?.tool, 'write_file');
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    const originalFetch = globalThis.fetch;
    let capturedGatewayAuth = '';
    let capturedProviderAuth = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      capturedGatewayAuth = headers.get('cf-aig-authorization') ?? '';
      capturedProviderAuth = headers.get('Authorization') ?? '';
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    type: 'complete',
                    tool: null,
                    args: null,
                    summary: null,
                    finalOutput: {
                      findings: [],
                      summary: 'ok',
                      furtherPassesLowYield: true,
                    },
                  }),
                },
              ],
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
            'X-Provider-Api-Key': 'provider-key',
            'X-AI-Gateway-Auth-Token': 'cf_gateway_token',
          },
          body: JSON.stringify({
            mode: 'review_analysis',
            prompt: 'You are Nimbus Review. Investigate the current diff for concrete correctness issues.',
            model: 'openai/gpt-5.3-codex',
            history: [],
          }),
        }),
        {
          AGENT_SDK_AUTH_TOKEN: 'expected-token',
          AI_GATEWAY_ACCOUNT_ID: 'cf-account',
          AI_GATEWAY_ID: 'default',
          AI_GATEWAY_COLLECT_LOG_PAYLOAD: 'false',
        }
      );
      assert.equal(response.status, 200);
      assert.equal(capturedGatewayAuth, 'Bearer cf_gateway_token');
      assert.equal(capturedProviderAuth, 'Bearer provider-key');
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
