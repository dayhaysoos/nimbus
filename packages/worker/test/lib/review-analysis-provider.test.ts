import { strict as assert } from 'assert';
import { CloudflareAgentSdkReviewProvider, OpenRouterReviewProvider } from '../../src/lib/review-analysis/provider.js';
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
    assert.equal(capturedBody?.model, 'gpt-5.4');
    assert.equal(capturedBody?.reasoningEffort, 'high');
    assert.equal(capturedBody?.forceComplete, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
