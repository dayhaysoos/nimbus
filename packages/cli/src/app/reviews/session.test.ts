import { strict as assert } from 'assert';
import { resolveReviewUiRuntimeContext } from './session.js';

export async function runReviewUiSessionTests(): Promise<void> {
  const originalNimbusApiKey = process.env.NIMBUS_API_KEY;
  const originalReviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN;
  const originalOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
  const originalWorkerUrl = process.env.NIMBUS_WORKER_URL;

  try {
    process.env.NIMBUS_WORKER_URL = 'https://worker.example.com';

    {
      const warnings: string[] = [];
      delete process.env.NIMBUS_API_KEY;
      process.env.REVIEW_CONTEXT_GITHUB_TOKEN = 'ghs_test';
      process.env.OPENROUTER_API_KEY = 'or_test';

      const runtime = resolveReviewUiRuntimeContext({
        reporter: {
          warning: (message) => warnings.push(message),
        },
      });

      assert.equal(runtime.port, 2000);
      assert.equal(runtime.workerUrl, 'https://worker.example.com');
      assert.equal(runtime.apiKey, null);
      assert.equal(runtime.reviewGithubToken, 'ghs_test');
      assert.equal(runtime.openrouterApiKey, 'or_test');
      assert.equal(warnings.length, 1);
    }

    {
      process.env.NIMBUS_API_KEY = 'nmb_live_test';
      const runtime = resolveReviewUiRuntimeContext({ port: 4321 });
      assert.equal(runtime.port, 4321);
      assert.equal(runtime.apiKey, 'nmb_live_test');
    }

    assert.throws(() => resolveReviewUiRuntimeContext({ port: 0 }), /Invalid port/);
    assert.throws(() => resolveReviewUiRuntimeContext({ port: 70000 }), /Invalid port/);
  } finally {
    if (originalNimbusApiKey === undefined) {
      delete process.env.NIMBUS_API_KEY;
    } else {
      process.env.NIMBUS_API_KEY = originalNimbusApiKey;
    }
    if (originalReviewGithubToken === undefined) {
      delete process.env.REVIEW_CONTEXT_GITHUB_TOKEN;
    } else {
      process.env.REVIEW_CONTEXT_GITHUB_TOKEN = originalReviewGithubToken;
    }
    if (originalOpenrouterApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalOpenrouterApiKey;
    }
    if (originalWorkerUrl === undefined) {
      delete process.env.NIMBUS_WORKER_URL;
    } else {
      process.env.NIMBUS_WORKER_URL = originalWorkerUrl;
    }
  }
}
