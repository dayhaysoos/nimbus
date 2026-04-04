import { strict as assert } from 'assert';
import { buildStudioReviewRoutePath } from '../../../src/app/reviews/create-shared.js';
import { studioBranchContextMatchesExpected } from '../../../src/app/reviews/studio-create.js';

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
}
