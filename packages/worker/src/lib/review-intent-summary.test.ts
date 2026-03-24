import { strict as assert } from 'assert';
import { runIntentSummarizationPrePass } from './review-runner.js';

type OpenRouterChatRequest = {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
};

export async function runReviewIntentSummaryTests(): Promise<void> {
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
