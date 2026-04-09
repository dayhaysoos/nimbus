import { strict as assert } from 'assert';
import { OpenRouterReviewProvider } from '../../src/lib/review-analysis/provider.js';
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
}
