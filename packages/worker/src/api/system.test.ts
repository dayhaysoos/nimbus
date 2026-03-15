import { strict as assert } from 'assert';
import { handleGetReviewReadiness } from './system.js';

export async function runSystemApiTests(): Promise<void> {
  {
    const env = {
      REVIEWS_QUEUE: {},
      ReviewRunner: {},
      REVIEW_CONTEXT_GITHUB_TOKEN: 'ghp_worker_token_123',
    } as never;
    const response = await handleGetReviewReadiness(env);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      checks: Array<{ code: string; ok: boolean }>;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.checks.find((check) => check.code === 'queue_binding_reviews')?.ok, true);
    assert.equal(payload.checks.find((check) => check.code === 'durable_object_binding_review_runner')?.ok, true);
    assert.equal(payload.checks.find((check) => check.code === 'review_context_github_token_configured')?.ok, true);
  }

  {
    const env = {
      REVIEW_CONTEXT_GITHUB_TOKEN: '',
    } as never;
    const response = await handleGetReviewReadiness(env);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      ok: boolean;
      checks: Array<{ code: string; ok: boolean }>;
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.checks.find((check) => check.code === 'queue_binding_reviews')?.ok, false);
    assert.equal(payload.checks.find((check) => check.code === 'durable_object_binding_review_runner')?.ok, false);
    assert.equal(payload.checks.find((check) => check.code === 'review_context_github_token_configured')?.ok, false);
  }
}
