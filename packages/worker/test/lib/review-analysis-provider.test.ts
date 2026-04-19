import { strict as assert } from 'assert';
import {
  buildHistoryForPromptForTests,
  CloudflareAiGatewayReviewProvider,
  CloudflareAgentSdkReviewProvider,
  CloudflareWorkersAiReviewProvider,
  OpenRouterReviewProvider,
  readResponseTextWithIdleTimeout,
  selectReviewAgentProvider,
} from '../../src/lib/review-analysis/provider.js';
import { validateReviewAgentAction } from '../../src/lib/review-analysis/tools.js';

export async function runReviewAnalysisProviderTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let capturedBody: any = null;

  try {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
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
              },
            ],
          }),
      } as Response;
    }) as typeof fetch;

    const provider = new OpenRouterReviewProvider(
      'test-key',
      validateReviewAgentAction,
      'https://nimbus.dayhaysoos.com',
      'Nimbus Review Harness'
    );

    const result = await provider.next({
      prompt: 'test prompt',
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      maxSteps: 8,
      step: 1,
      history: [],
    });

    assert.equal(result.type, 'complete');
    assert.equal(capturedBody?.model, 'gpt-5.4');
    assert.deepEqual(capturedBody?.reasoning, { effort: 'medium' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  capturedBody = null;

  try {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      return {
        ok: true,
        json: async () => ({
          action: {
            type: 'complete',
            tool: null,
            args: null,
            summary: null,
            finalOutput: {
              findings: [],
              summary: 'No actionable findings identified.',
              furtherPassesLowYield: true,
            },
          },
        }),
      } as Response;
    }) as typeof fetch;

    const provider = new CloudflareAgentSdkReviewProvider(
      'https://example.com/agent',
      null,
      null,
      null,
      null,
      null,
      validateReviewAgentAction
    );

    const result = await provider.next({
      prompt: 'test prompt',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      maxSteps: 8,
      step: 2,
      history: [],
      forceComplete: true,
    });

    assert.equal(result.type, 'complete');
    assert.equal(capturedBody?.mode, 'review_analysis');
    assert.equal(capturedBody?.model, 'gpt-5.4');
    assert.equal(capturedBody?.reasoningEffort, 'high');
    assert.equal(capturedBody?.forceComplete, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let capturedModel = '';
  let capturedAiInput: Record<string, unknown> | null = null;

  {
    const historyPrompt = buildHistoryForPromptForTests([
      ...Array.from({ length: 16 }, (_, index) => ({
        role: 'tool' as const,
        tool: 'read_file',
        output: {
          request: { path: `packages/file-${index}.ts`, maxBytes: 48000 },
          result: {
            content: `export const value${index} = '${'x'.repeat(1200)}';`,
            bytes: 1219,
            truncated: false,
          },
        },
      })),
      {
        role: 'assistant' as const,
        content: 'analysis_guard: focus on the retry path in the latest review turn.',
      },
    ]);

    const parsedPrompt = JSON.parse(historyPrompt) as { omitted: Record<string, unknown> | null; recent: unknown[] };
    assert.equal(Array.isArray(parsedPrompt.recent), true);
    assert.equal(parsedPrompt.recent.length <= 10, true);
    assert.equal(typeof parsedPrompt.omitted?.omittedEntryCount, 'number');
    assert.equal(historyPrompt.includes('packages/file-15.ts'), true);
  }

  {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"first":'));
        controller.enqueue(new TextEncoder().encode('"chunk"}'));
        controller.close();
      },
    });

    const text = await readResponseTextWithIdleTimeout(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }),
      { idleTimeoutMs: 100, maxBytes: 1024 }
    );

    assert.equal(text, '{"first":"chunk"}');
  }

  {
    const provider = new CloudflareWorkersAiReviewProvider(
      {
        async run(model: string, inputs: Record<string, unknown>) {
          capturedModel = model;
          capturedAiInput = inputs;
          return {
            response: JSON.stringify({
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
          };
        },
      },
      validateReviewAgentAction
    );

    const result = await provider.next({
      prompt: 'test prompt',
      model: 'openai/gpt-5.3-codex',
      reasoningEffort: 'medium',
      maxSteps: 8,
      step: 1,
      history: [],
      forceComplete: true,
    });

    assert.equal(result.type, 'complete');
    assert.equal(capturedModel, '@cf/qwen/qwen2.5-coder-32b-instruct');
    if (!capturedAiInput) {
      assert.fail('Expected Workers AI input to be captured');
    }
    const requestInput = capturedAiInput as unknown as Record<string, unknown>;
    assert.equal((requestInput.response_format as { type?: string } | undefined)?.type, 'json_schema');
    assert.equal(Array.isArray(requestInput.messages), true);
    assert.equal(typeof requestInput.max_tokens, 'number');
    assert.equal(Number(requestInput.max_tokens) <= 4096, true);
  }

  let capturedGatewayHeaders: Record<string, string> | null = null;
  let capturedGatewayBody: Record<string, unknown> | null = null;
  let capturedGatewayUrl = '';

  try {
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedGatewayUrl = String(input);
      const headers = new Headers(init?.headers);
      capturedGatewayHeaders = {
        cfAigAuthorization: headers.get('cf-aig-authorization') ?? '',
        cfAigByokAlias: headers.get('cf-aig-byok-alias') ?? '',
        cfAigCollectLogPayload: headers.get('cf-aig-collect-log-payload') ?? '',
      };
      capturedGatewayBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
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

    const provider = new CloudflareAiGatewayReviewProvider(
      {
        baseUrl: 'https://gateway.ai.cloudflare.com/v1/account/default/compat',
        authToken: 'cf_gateway_token',
        byokAlias: 'org-default',
        collectLogPayload: false,
      },
      'provider_request_key',
      validateReviewAgentAction
    );

    const result = await provider.next({
      prompt: 'test prompt',
      model: 'openai/gpt-5.3-codex',
      reasoningEffort: 'medium',
      maxSteps: 8,
      step: 1,
      history: [],
      forceComplete: true,
    });

    assert.equal(result.type, 'complete');
    const gatewayHeaders = capturedGatewayHeaders as unknown as Record<string, string>;
    const gatewayBody = capturedGatewayBody as unknown as Record<string, unknown>;
    assert.equal(capturedGatewayUrl, 'https://gateway.ai.cloudflare.com/v1/account/default/openai/responses');
    assert.equal(gatewayHeaders.cfAigAuthorization, 'Bearer cf_gateway_token');
    assert.equal(gatewayHeaders.cfAigByokAlias, 'org-default');
    assert.equal(gatewayHeaders.cfAigCollectLogPayload, 'false');
    assert.equal(gatewayBody.model, 'gpt-5.3-codex');
    assert.deepEqual(gatewayBody.reasoning, { effort: 'medium' });
    assert.equal((gatewayBody.text as { format?: { type?: string } } | undefined)?.format?.type, 'json_schema');
  } finally {
    globalThis.fetch = originalFetch;
  }

  {
    const selection = selectReviewAgentProvider({
      env: {
        AI: {
          async run() {
            return {};
          },
        },
        CF_ACCOUNT_ID: 'cf-account',
        AI_GATEWAY_AUTH_TOKEN: 'cf_gateway_token',
        AI_GATEWAY_BYOK_ALIAS: 'org-default',
      } as never,
      model: 'openai/gpt-5.3-codex',
      endpoint: 'https://agent.example.com',
      openrouterApiKey: 'or_request_key',
    });

    assert.equal(selection?.providerName, 'cloudflare_ai_gateway');
    assert.equal(selection?.model, 'openai/gpt-5.3-codex');
    assert.equal(selection?.gatewayConfig?.byokAlias, 'org-default');
  }
}
