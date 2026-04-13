import { strict as assert } from 'assert';
import { buildReviewRequestPayload, normalizeReviewContextMode } from '../../src/api/reviews/request-shared.js';

export async function runReviewRequestSharedTests(): Promise<void> {
  assert.equal(normalizeReviewContextMode('intent_aware'), 'intent_aware');
  assert.equal(normalizeReviewContextMode('basic'), 'basic');

  assert.equal(normalizeReviewContextMode(undefined), 'basic');
  assert.equal(normalizeReviewContextMode('invalid-mode'), 'basic');

  assert.equal(
    normalizeReviewContextMode(undefined, {
      sessionIds: ['sess_123'],
      rawSessionPrompts: null,
      intentSessionContext: [],
    }),
    'intent_aware'
  );

  assert.equal(
    normalizeReviewContextMode(undefined, {
      sessionIds: [],
      rawSessionPrompts: 'Prompt context',
      intentSessionContext: [],
    }),
    'intent_aware'
  );

  {
    const { requestPayload } = buildReviewRequestPayload({
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      policyMode: 'none',
      reviewBasis: 'checkpoint',
      policy: {},
      format: {},
      provenance: { note: 'No explicit context mode' },
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      model: undefined,
    });
    const provenance = (requestPayload.provenance ?? {}) as Record<string, unknown>;
    assert.equal(provenance.reviewContextMode, undefined);
  }

  {
    const { requestPayload } = buildReviewRequestPayload({
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      policyMode: 'none',
      reviewBasis: 'checkpoint',
      policy: {},
      format: {},
      provenance: {
        sessionIds: ['sess_123'],
      },
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      model: undefined,
    });
    const provenance = (requestPayload.provenance ?? {}) as Record<string, unknown>;
    assert.equal(provenance.reviewContextMode, 'intent_aware');
  }
}
