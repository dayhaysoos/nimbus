import { strict as assert } from 'assert';
import { AgentEndpointError, callOpenRouter, nextAgentActionWithInference } from './agent.js';
import worker from '../index.js';

type WorkerModule = {
  fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>;
};

const handler = worker as WorkerModule;

export async function runAgentTests(): Promise<void> {
  {
    const originalFetch = globalThis.fetch;
    let capturedBody = '';
    let capturedReferer = '';
    let capturedTitle = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      const headers = new Headers(init?.headers);
      capturedReferer = headers.get('HTTP-Referer') ?? '';
      capturedTitle = headers.get('X-Title') ?? '';
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [],
                  summary: 'Model produced strict V2 output.',
                  furtherPassesLowYield: false,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const action = await nextAgentActionWithInference(
      {
      mode: 'workspace_task',
      prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
      model: 'anthropic/claude-sonnet-4-5',
      history: [],
    },
      {
        OPENROUTER_API_KEY: 'test-key',
        DEFAULT_MODEL: 'anthropic/claude-sonnet-4-5',
        OPENROUTER_HTTP_REFERER: 'https://example-review-worker.workers.dev',
        OPENROUTER_X_TITLE: 'Nimbus Review',
      }
    );

    try {
      assert.equal(action.type, 'final');
      const parsed = JSON.parse(action.summary) as Record<string, unknown>;
      assert.equal(Array.isArray(parsed.findings), true);
      assert.equal(parsed.summary, 'Model produced strict V2 output.');
      assert.equal(parsed.furtherPassesLowYield, false);

      const requestBody = JSON.parse(capturedBody) as Record<string, unknown>;
      assert.equal(requestBody.model, 'anthropic/claude-sonnet-4-5');
      assert.equal(Array.isArray(requestBody.messages), true);
      assert.equal(capturedReferer, 'https://example-review-worker.workers.dev');
      assert.equal(capturedTitle, 'Nimbus Review');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error('upstream failed for Bearer token-abc sk-secret123 nmb_live_secret999');
    }) as typeof fetch;

    try {
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
          OPENROUTER_API_KEY: 'env-key',
        }
      );

      assert.equal(response.status, 500);
      const payload = (await response.json()) as {
        details?: { message?: string };
      };
      const message = payload.details?.message ?? '';
      assert.equal(message.includes('Bearer token-abc'), false);
      assert.equal(message.includes('sk-secret123'), false);
      assert.equal(message.includes('nmb_live_secret999'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      throw new Error('sk-onlysecretvalue');
    }) as typeof fetch;

    try {
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
          OPENROUTER_API_KEY: 'env-key',
        }
      );

      assert.equal(response.status, 500);
      const payload = (await response.json()) as {
        details?: { message?: string };
      };
      assert.equal(payload.details?.message, 'upstream error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let capturedAuthHeader = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      capturedAuthHeader = headers.get('Authorization') ?? '';
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
      await nextAgentActionWithInference(
        {
          mode: 'workspace_task',
          prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
          model: 'anthropic/claude-sonnet-4-5',
          history: [],
        },
        { OPENROUTER_API_KEY: 'env-key', DEFAULT_MODEL: 'anthropic/claude-sonnet-4-5' },
        { openrouterApiKey: 'request-key' }
      );
      assert.equal(capturedAuthHeader, 'Bearer request-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const originalFetch = globalThis.fetch;
    let capturedAuthHeader = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      capturedAuthHeader = headers.get('Authorization') ?? '';
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
      await nextAgentActionWithInference(
        {
          mode: 'workspace_task',
          prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
          model: 'anthropic/claude-sonnet-4-5',
          history: [],
        },
        { OPENROUTER_API_KEY: 'env-fallback-key', DEFAULT_MODEL: 'anthropic/claude-sonnet-4-5' }
      );
      assert.equal(capturedAuthHeader, 'Bearer env-fallback-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    try {
      await nextAgentActionWithInference(
        {
          mode: 'workspace_task',
          prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
          model: 'anthropic/claude-sonnet-4-5',
          history: [],
        },
        { DEFAULT_MODEL: 'anthropic/claude-sonnet-4-5' }
      );
      assert.fail('Expected missing_openrouter_api_key error');
    } catch (error) {
      assert.equal(error instanceof AgentEndpointError, true);
      const typed = error as AgentEndpointError;
      assert.equal(typed.code, 'missing_openrouter_api_key');
    }
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as typeof fetch;

    try {
      await nextAgentActionWithInference(
        {
          mode: 'workspace_task',
          prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
          model: 'anthropic/claude-sonnet-4-5',
          history: [],
        },
        { OPENROUTER_API_KEY: 'test-key', DEFAULT_MODEL: 'anthropic/claude-sonnet-4-5' }
      );
      assert.fail('Expected openrouter_request_timeout error');
    } catch (error) {
      assert.equal(error instanceof AgentEndpointError, true);
      const typed = error as AgentEndpointError;
      assert.equal(typed.code, 'openrouter_request_timeout');
      assert.equal(typed.status, 504);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  'Analysis complete. Returning JSON:\n{"findings":[],"summary":"Recovered from mixed prose output.","furtherPassesLowYield":true}',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const action = await nextAgentActionWithInference(
        {
          mode: 'workspace_task',
          prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
          model: 'anthropic/claude-sonnet-4-5',
          history: [],
        },
        { OPENROUTER_API_KEY: 'test-key', DEFAULT_MODEL: 'anthropic/claude-sonnet-4-5' }
      );
      assert.equal(action.type, 'final');
      const parsed = JSON.parse(action.summary) as Record<string, unknown>;
      assert.equal(parsed.summary, 'Recovered from mixed prose output.');
      assert.equal(parsed.furtherPassesLowYield, true);
      assert.equal(Array.isArray(parsed.findings), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
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
                  findings: [],
                  summary: { riskLevel: 'low' },
                  furtherPassesLowYield: 'false',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      await nextAgentActionWithInference(
        {
          mode: 'workspace_task',
          prompt: 'You are Nimbus Review. Return your final answer as raw JSON with furtherPassesLowYield.',
          model: 'anthropic/claude-sonnet-4-5',
          history: [],
        },
        { OPENROUTER_API_KEY: 'test-key', DEFAULT_MODEL: 'anthropic/claude-sonnet-4-5' }
      );
      assert.fail('Expected invalid_model_output error');
    } catch (error) {
      assert.equal(error instanceof AgentEndpointError, true);
      const typed = error as AgentEndpointError;
      assert.equal(typed.code, 'invalid_model_output');
      assert.equal(typed.status, 422);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const action = await nextAgentActionWithInference({
      mode: 'workspace_task',
      prompt: 'General coding task prompt',
      history: [],
    }, { OPENROUTER_API_KEY: 'test-key' });
    assert.equal(action.type, 'tool');
    assert.equal(action.tool, 'list_files');
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const content = await callOpenRouter({
        apiKey: 'test-key',
        model: 'anthropic/claude-sonnet-4-5',
        prompt: 'test prompt',
      });
      assert.equal(content, 'ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}
