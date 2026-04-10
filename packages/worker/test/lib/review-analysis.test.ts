import { strict as assert } from 'assert';
import {
  accumulateSearchEvidenceForTests,
  collectMissingEvidenceRequirementsForTests,
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

  const selfContainedMissingEvidence = collectMissingEvidenceRequirementsForTests({
    changedPaths: ['packages/cli/src/app/reviews/context.ts'],
    requiresCrossFileIntegrationEvidence: false,
    diffSummaryUsed: true,
    readChangedPaths: ['packages/cli/src/app/reviews/context.ts'],
    searchUsed: true,
    searchMatchedChangedPath: true,
    searchMatchedCrossFilePath: false,
  });
  assert.equal(
    selfContainedMissingEvidence.includes(
      'Read at least one non-changed file that defines or handles an integration boundary touched by the diff.'
    ),
    false
  );

  const crossFileMissingEvidence = collectMissingEvidenceRequirementsForTests({
    changedPaths: ['packages/cli/src/app/reviews/ui-proxy.ts'],
    requiresCrossFileIntegrationEvidence: true,
    diffSummaryUsed: true,
    readChangedPaths: ['packages/cli/src/app/reviews/ui-proxy.ts'],
    searchUsed: true,
    searchMatchedChangedPath: true,
    searchMatchedCrossFilePath: false,
  });
  assert.equal(
    crossFileMissingEvidence.includes(
      'Read at least one non-changed file that defines or handles an integration boundary touched by the diff.'
    ),
    true
  );

  const unmatchedCrossFileEvidence = collectMissingEvidenceRequirementsForTests({
    changedPaths: ['packages/cli/src/app/reviews/ui-proxy.ts'],
    requiresCrossFileIntegrationEvidence: true,
    diffSummaryUsed: true,
    readChangedPaths: ['packages/cli/src/app/reviews/ui-proxy.ts'],
    searchUsed: true,
    searchMatchedChangedPath: true,
    searchMatchedCrossFilePath: true,
  });
  assert.equal(
    unmatchedCrossFileEvidence.includes(
      'Read at least one non-changed file that defines or handles an integration boundary touched by the diff.'
    ),
    true
  );

  assert.deepEqual(
    accumulateSearchEvidenceForTests({
      changedPaths: ['packages/cli/src/app/reviews/ui-proxy.ts'],
      searches: [
        [{ path: 'packages/cli/src/app/reviews/studio-create.ts' }],
        [{ path: 'packages/cli/src/app/reviews/ui-proxy.ts' }],
      ],
    }),
    {
      searchMatchedChangedPath: true,
      searchMatchedCrossFilePath: true,
    }
  );

  const satisfiedCrossFileEvidence = collectMissingEvidenceRequirementsForTests({
    changedPaths: ['packages/cli/src/app/reviews/ui-proxy.ts'],
    requiresCrossFileIntegrationEvidence: true,
    diffSummaryUsed: true,
    readChangedPaths: ['packages/cli/src/app/reviews/ui-proxy.ts'],
    readCrossFilePaths: ['packages/cli/src/app/reviews/studio-create.ts'],
    searchUsed: true,
    searchMatchedChangedPath: true,
    searchMatchedCrossFilePath: false,
  });
  assert.equal(
    satisfiedCrossFileEvidence.includes(
      'Read at least one non-changed file that defines or handles an integration boundary touched by the diff.'
    ),
    false
  );
}
