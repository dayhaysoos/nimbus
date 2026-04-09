import { emitResolveReviewProgressForTests } from '../../../src/app/reviews/context.js';
import { strict as assert } from 'assert';
import { buildStudioReviewRoutePath } from '../../../src/app/reviews/create-shared.js';
import { emitStudioStartEventForTests, studioBranchContextMatchesExpected } from '../../../src/app/reviews/studio-create.js';

export async function runStudioCreateTests(): Promise<void> {
  assert.equal(
    buildStudioReviewRoutePath({
      reviewId: 'rev_123',
      route: 'reports',
      repo: 'acme/web',
      branch: 'feature/home',
    }),
    '/branches/acme%2Fweb/feature%2Fhome/reports/rev_123'
  );

  assert.equal(
    buildStudioReviewRoutePath({
      reviewId: 'rev_456',
      route: 'policy',
      repo: 'acme/web',
      branch: 'feature/home',
    }),
    '/branches/acme%2Fweb/feature%2Fhome/policy/rev_456'
  );

  assert.equal(
    buildStudioReviewRoutePath({
      reviewId: 'rev_789',
      route: 'reports',
    }),
    '/reports/rev_789'
  );

  assert.equal(
    studioBranchContextMatchesExpected(
      { repo: 'acme/web', branch: 'feature/home' },
      { repo: 'acme/web', branch: 'feature/home' }
    ),
    true
  );

  assert.equal(
    studioBranchContextMatchesExpected(
      { repo: 'acme/web', branch: 'feature/home' },
      { repo: 'acme/web', branch: 'main' }
    ),
    false
  );

  assert.equal(
    studioBranchContextMatchesExpected(
      { repo: 'acme/web', branch: 'feature/home' },
      undefined
    ),
    true
  );

  await assert.doesNotReject(async () => {
    await emitResolveReviewProgressForTests(
      {
        onProgress: async () => {
          throw new Error('listener failed');
        },
      },
      {
        stage: 'checkpoint',
        state: 'active',
        label: 'Resolving checkpoint',
        detail: 'detail',
      }
    );
  });

  await assert.doesNotReject(async () => {
    await emitStudioStartEventForTests({
      onEvent: async () => {
        throw new Error('stream failed');
      },
      event: {
        type: 'stage',
        stage: 'policy',
        state: 'active',
        label: 'Approving policy',
        detail: 'detail',
      },
    });
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      emitStudioStartEventForTests({
        signal: controller.signal,
        event: {
          type: 'completed',
          reviewId: 'rev_123',
          routePath: '/reports/rev_123',
          policyMode: 'auto',
          status: 'queued',
          detail: 'done',
        },
      }),
    /aborted/i
  );
}
