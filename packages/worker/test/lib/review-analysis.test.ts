import { strict as assert } from 'assert';
import {
  computeReviewStepBudgetsForTests,
  extractDeterministicSearchQueriesForTests,
  extractIntegrationSearchQueriesForTests,
} from '../../src/lib/review-analysis.js';

export function runReviewAnalysisTests(): void {
  assert.deepEqual(computeReviewStepBudgetsForTests(8), {
    deterministicMaxSteps: 2,
    providerMaxSteps: 6,
  });
  assert.deepEqual(computeReviewStepBudgetsForTests(18), {
    deterministicMaxSteps: 12,
    providerMaxSteps: 6,
  });

  const queries = extractDeterministicSearchQueriesForTests([
    {
      path: 'packages/worker/src/api/reviews/recovery.ts',
      content: `
import { updateReviewRunStatus, replaceReviewFindings } from '../../lib/db.js';
import { createReviewQueueMessage } from '../../lib/review-queue.js';

export async function manuallyRecoverReviewRun() {
  await updateReviewRunStatus();
  await replaceReviewFindings();
  return createReviewQueueMessage();
}
      `,
      byteSize: 240,
      source: 'changed',
    },
  ]);

  assert.deepEqual(
    queries,
    ['updateReviewRunStatus', 'replaceReviewFindings', 'createReviewQueueMessage']
  );

  const integrationQueries = extractIntegrationSearchQueriesForTests([
    {
      path: 'packages/report-ui/src/components/ReportPage.tsx',
      content: `
const response = await fetch(\`${'${API_BASE}'}/api/reviews/\${encodeURIComponent(reviewId)}/recover\`, {
  method: 'POST',
});
if (review.status === 'running') {
  return null;
}
      `,
      byteSize: 240,
      source: 'changed',
    },
    {
      path: 'packages/cli/src/app/reviews/ui-proxy.ts',
      content: `
import { startStudioNewReview } from './studio-create.js';

await startStudioNewReview({
  onEvent: async (event) => {
    return event;
  },
});
      `,
      byteSize: 240,
      source: 'changed',
    },
    {
      path: 'packages/cli/src/app/reviews/context.ts',
      content: `
export async function emitResolveReviewProgress(options, event) {
  await options?.onProgress?.(event);
}
      `,
      byteSize: 120,
      source: 'changed',
    },
  ]);

  assert.deepEqual(
    integrationQueries,
    ['/recover', 'startStudioNewReview', 'onEvent']
  );
}
