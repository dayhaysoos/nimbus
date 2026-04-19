import { strict as assert } from 'assert';
import { runIntentSummarizationPrePass } from '../../src/lib/review-runner.js';

type OpenRouterChatRequest = {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
};

export async function runReviewIntentSummaryTests(): Promise<void> {
  {
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> | null = null;
    let capturedBody: OpenRouterChatRequest | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(input);
      const headers = new Headers(init?.headers);
      capturedHeaders = {
        cfAigAuthorization: headers.get('cf-aig-authorization') ?? '',
        cfAigByokAlias: headers.get('cf-aig-byok-alias') ?? '',
        cfAigCollectLogPayload: headers.get('cf-aig-collect-log-payload') ?? '',
      };
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as OpenRouterChatRequest;
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
                    goal: 'Stabilize review orchestration on Cloudflare AI Gateway.',
                    prohibitions: ['Do not expose provider API keys to Nimbus runtime headers.'],
                    constraints: ['Keep the request format compatible with multiple providers.'],
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
      const summary = await runIntentSummarizationPrePass(
        {
          CF_ACCOUNT_ID: 'cf-account',
          AI_GATEWAY_AUTH_TOKEN: 'cf_gateway_token',
          AI_GATEWAY_BYOK_ALIAS: 'org-default',
          AI_GATEWAY_COLLECT_LOG_PAYLOAD: 'false',
          REVIEW_INTENT_SUMMARY_MODEL: 'openai/gpt-5.3-codex',
        } as never,
        'raw prompt text'
      );

      const gatewayHeaders = capturedHeaders as unknown as Record<string, string>;
      const gatewayBody = capturedBody as unknown as Record<string, unknown>;
      assert.equal(capturedUrl, 'https://gateway.ai.cloudflare.com/v1/cf-account/default/openai/responses');
      assert.equal(gatewayHeaders.cfAigAuthorization, 'Bearer cf_gateway_token');
      assert.equal(gatewayHeaders.cfAigByokAlias, 'org-default');
      assert.equal(gatewayHeaders.cfAigCollectLogPayload, 'false');
      assert.equal(gatewayBody.model, 'gpt-5.3-codex');
      assert.equal((gatewayBody.text as { format?: { type?: string } } | undefined)?.format?.type, 'json_schema');
      assert.deepEqual(summary, {
        goal: 'Stabilize review orchestration on Cloudflare AI Gateway.',
        prohibitions: ['Do not expose provider API keys to Nimbus runtime headers.'],
        constraints: ['Keep the request format compatible with multiple providers.'],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  {
    let capturedModel = '';
    let capturedMessages: Array<{ role?: string; content?: string }> = [];
    const summary = await runIntentSummarizationPrePass(
      {
        AI: {
          async run(model: string, inputs: Record<string, unknown>) {
            capturedModel = model;
            capturedMessages = Array.isArray(inputs.messages)
              ? (inputs.messages as Array<{ role?: string; content?: string }>)
              : [];
            return {
              response: JSON.stringify({
                goal: 'Harden the auth flow without leaking credentials.',
                prohibitions: ['Do not log auth tokens.'],
                constraints: ['Preserve the existing checkpoint flow.'],
              }),
            };
          },
        },
      } as never,
      'raw prompt text'
    );

    assert.equal(capturedModel, '@cf/meta/llama-3.1-8b-instruct-fast');
    assert.equal(Array.isArray(capturedMessages), true);
    assert.equal(capturedMessages.length, 2);
    assert.deepEqual(summary, {
      goal: 'Harden the auth flow without leaking credentials.',
      prohibitions: ['Do not log auth tokens.'],
      constraints: ['Preserve the existing checkpoint flow.'],
    });
  }

  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as OpenRouterChatRequest;
      assert.equal(body.model, 'anthropic/claude-sonnet-4.5');
      assert.equal(Array.isArray(body.messages), true);

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `\`\`\`json
{
  "goal": "Step 1: run migrations before committing.",
  "prohibitions": [
    "Do not maintain backwards compatibility with legacy payload hash aliases.",
    "Do not implement more than one step at a time without showing output first.",
    "F-002 · medium · logic"
  ],
  "constraints": [
    "Use existing GitRepo.getCurrentBranchRef() helper from packages/cli/src/lib/checkpoint/git.ts.",
    "Run migrations and deploy to worker before push.",
    "Fix: ensure sequence is required"
  ]
}
\`\`\`
diagnostics: non-json trailing text`,
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const summary = await runIntentSummarizationPrePass(
        {
          OPENROUTER_API_KEY: 'or_env_key',
        } as never,
        'raw prompt text',
        {
          openrouterApiKey: 'or_request_key',
        }
      );

      assert.deepEqual(summary, {
        goal: null,
        prohibitions: ['Do not maintain backwards compatibility with legacy payload hash aliases.'],
        constraints: ['Use existing GitRepo.getCurrentBranchRef() helper from packages/cli/src/lib/checkpoint/git.ts.'],
      });
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
                  goal: 'Step 2: commit and push.',
                  prohibitions: [
                    'F-002 · medium · logic',
                    'Do not implement more than one step at a time without showing output first.',
                  ],
                  constraints: [
                    'Run migrations and test locally before moving to the next step.',
                    'Fix: ensure sequence is required',
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const summary = await runIntentSummarizationPrePass(
        {
          OPENROUTER_API_KEY: 'or_env_key',
        } as never,
        'raw prompt text',
        {
          openrouterApiKey: 'or_request_key',
        }
      );

      assert.equal(summary, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}
