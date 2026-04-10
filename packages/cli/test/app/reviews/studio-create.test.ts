import {
  emitResolveReviewProgressForTests,
  preserveResolveReviewAbortForTests,
  throwIfResolveReviewAbortedForTests,
} from '../../../src/app/reviews/context.js';
import { strict as assert } from 'assert';
import { buildStudioReviewRoutePath } from '../../../src/app/reviews/create-shared.js';
import {
  emitStudioStartEventForTests,
  shouldAbortStudioStartForTests,
  studioBranchContextMatchesExpected,
} from '../../../src/app/reviews/studio-create.js';

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

  const studioAbortController = new AbortController();
  studioAbortController.abort();
  assert.equal(shouldAbortStudioStartForTests(studioAbortController.signal, true), true);
  assert.equal(shouldAbortStudioStartForTests(studioAbortController.signal, false), false);

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

  const alreadyAbortedProgressController = new AbortController();
  alreadyAbortedProgressController.abort();
  await assert.doesNotReject(async () => {
    await emitResolveReviewProgressForTests(
      {
        signal: alreadyAbortedProgressController.signal,
        onProgress: async () => {},
      },
      {
        stage: 'workspace',
        state: 'active',
        label: 'Preparing workspace',
        detail: 'detail',
      }
    );
  });

  const progressAbortController = new AbortController();
  await assert.doesNotReject(async () => {
    await emitResolveReviewProgressForTests(
      {
        signal: progressAbortController.signal,
        onProgress: async () => {
          progressAbortController.abort();
          throw new Error('stream failed');
        },
      },
      {
        stage: 'workspace',
        state: 'active',
        label: 'Preparing workspace',
        detail: 'detail',
      }
    );
  });

  const abortError = new Error('Review flow aborted before completion.');
  abortError.name = 'AbortError';
  assert.throws(() => preserveResolveReviewAbortForTests(abortError), /Review flow aborted before completion\./);
  assert.doesNotThrow(() => preserveResolveReviewAbortForTests(new Error('ordinary failure')));
  assert.throws(
    () => throwIfResolveReviewAbortedForTests({ signal: alreadyAbortedProgressController.signal }),
    /Review flow aborted before completion\./
  );
  assert.doesNotThrow(() => throwIfResolveReviewAbortedForTests(undefined));

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
