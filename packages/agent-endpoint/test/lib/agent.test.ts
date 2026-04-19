import { strict as assert } from 'assert';
import { AgentEndpointError, callOpenRouter, nextAgentAction, nextAgentActionWithInference } from '../../src/lib/agent.js';
import worker from '../../src/index.js';

type WorkerModule = {
  fetch(request: Request, env: Record<string, string | undefined>): Promise<Response>;
};

const handler = worker as WorkerModule;

export async function runAgentTests(): Promise<void> {
  {
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedBody = '';
    let capturedGatewayAuth = '';
    let capturedProviderAuth = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(input);
      capturedBody = typeof init?.body === 'string' ? init.body : '';
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
                      summary: 'No actionable findings identified.',
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
      const action = await nextAgentActionWithInference(
        {
          mode: 'review_analysis',
          prompt: 'You are Nimbus Review. Investigate the current diff for concrete correctness issues.',
          model: 'openai/gpt-5.3-codex',
          reasoningEffort: 'medium',
          step: 2,
          maxSteps: 8,
          history: [
            { role: 'assistant', content: 'analysis_focus: inspect queue retry behavior.' },
            { role: 'tool', tool: 'read_file', output: { request: { path: 'src/retry.ts' }, result: { content: 'export const retry = true;' } } },
          ],
        },
        {
          AI_GATEWAY_ACCOUNT_ID: 'cf-account',
          AI_GATEWAY_ID: 'default',
          AI_GATEWAY_COLLECT_LOG_PAYLOAD: 'false',
        },
        {
          providerApiKey: 'provider_request_key',
          aiGatewayAuthToken: 'cf_gateway_token',
        }
      );

      assert.equal(action.type, 'complete');
      assert.equal(capturedUrl, 'https://gateway.ai.cloudflare.com/v1/cf-account/default/openai/responses');
      assert.equal(capturedGatewayAuth, 'Bearer cf_gateway_token');
      assert.equal(capturedProviderAuth, 'Bearer provider_request_key');
      const requestBody = JSON.parse(capturedBody) as Record<string, unknown>;
      assert.equal(requestBody.model, 'gpt-5.3-codex');
      assert.deepEqual(requestBody.reasoning, { effort: 'medium' });
      assert.equal((requestBody.text as { format?: { type?: string } } | undefined)?.format?.type, 'json_schema');
      assert.equal(typeof requestBody.input, 'string');
      assert.equal(String(requestBody.input).includes('Agent loop instructions:'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

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
      const responseFormat = requestBody.response_format as { type?: string; json_schema?: Record<string, unknown> };
      assert.equal(responseFormat?.type, 'json_schema');
      assert.equal(typeof responseFormat?.json_schema, 'object');
      const plugins = requestBody.plugins as Array<{ id?: string }>;
      assert.equal(Array.isArray(plugins), true);
      assert.equal(plugins.some((plugin) => plugin.id === 'response-healing'), true);
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
      return new Response(JSON.stringify({ error: { message: 'Invalid request body' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
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
      assert.fail('Expected openrouter_request_rejected error');
    } catch (error) {
      assert.equal(error instanceof AgentEndpointError, true);
      const typed = error as AgentEndpointError;
      assert.equal(typed.code, 'openrouter_request_rejected');
      assert.equal(typed.status, 422);
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
    const originalFetch = globalThis.fetch;
    let capturedBody = '';
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
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
      const action = await nextAgentActionWithInference(
        {
          mode: 'workspace_task',
          prompt: 'General coding task prompt',
          step: 1,
          maxSteps: 6,
          history: [],
        },
        { OPENROUTER_API_KEY: 'test-key', DEFAULT_MODEL: 'anthropic/claude-sonnet-4-5' }
      );
      assert.equal(action.type, 'tool');
      assert.equal(action.tool, 'write_file');
      assert.equal(action.args.path, 'src/normalize-port.js');

      const requestBody = JSON.parse(capturedBody) as Record<string, unknown>;
      const responseFormat = requestBody.response_format as { json_schema?: { name?: string } };
      assert.equal(responseFormat?.json_schema?.name, 'WorkspaceTaskAction');
      const messages = requestBody.messages as Array<{ content?: string }>;
      assert.equal(typeof messages?.[0]?.content, 'string');
      assert.equal((messages?.[0]?.content ?? '').includes('Task loop instructions:'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    const action = nextAgentAction({
      mode: 'workspace_task',
      prompt: 'General coding task prompt',
      history: [],
    });
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
