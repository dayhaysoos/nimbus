import { strict as assert } from 'assert';
import { buildReviewAgentPrompt } from '../../src/lib/review-analysis/prompt.js';
import { resolveReviewAnalysisModel } from '../../src/lib/review-runner/context-helpers.js';

export function runReviewPromptTests(): void {
  {
    const prompt = buildReviewAgentPrompt({
      reviewId: 'rev_test',
      workspaceId: 'ws_test',
      deploymentId: 'dep_test',
      sourceBundleKey: 'bundle',
      goal: 'Review the current implementation for correctness issues.',
      constraints: [],
      decisions: [],
      intentSessionContext: [],
      evidenceCatalog: [],
      deploymentSummary: {
        provider: 'simulated',
        deployedUrl: null,
        validationSummary: 'not run',
      },
      reviewContext: {
        id: 'rctx_test',
        reviewId: 'rev_test',
        workspaceId: 'ws_test',
        deploymentId: 'dep_test',
        commitSha: 'a'.repeat(40),
        assembledAt: '2026-04-06T00:00:00.000Z',
        checkpoint: {
          checkpointId: 'chk_test',
          branch: 'entire/checkpoints/v1',
          attributionTrailer: null,
          session: {
            sessionId: 'ses_test',
            agentType: null,
            sessionIntent: null,
          },
        },
        retrieval: {
          changedFiles: [],
          diffHunks: [],
          relatedFiles: [],
          conventionFiles: [],
          coChange: {
            source: 'entire/checkpoints/v1',
            lookbackSessions: 5,
            sessionsScanned: 0,
            filesConsidered: 0,
            topN: 20,
            coChangeSkipped: false,
            coChangeSkipReason: null,
            coChangeAvailable: false,
          },
        },
        stats: {
          totalFilesIncluded: 0,
          totalBytesIncluded: 0,
          estimatedTokens: 0,
          tokenBudget: null,
        },
      },
      rootListing: [],
      diffSnapshot: {},
    });

    assert.equal(prompt.includes('Look for retry, recovery, idempotency, and duplicate-execution bugs.'), true);
    assert.equal(prompt.includes('Look for stale in-flight work that can overwrite newer state or race with replacement work.'), true);
    assert.equal(prompt.includes('Look for partial-failure paths where the system can end in the wrong terminal state.'), true);
    assert.equal(prompt.includes('For invalid-input findings, explain whether the bad input is rejected, ignored, or causes destructive state changes.'), true);
    assert.equal(prompt.includes('Prefer omission over speculation, but do not omit a finding just because it requires cross-file reasoning.'), true);
  }

  {
    assert.equal(resolveReviewAnalysisModel({}, {} as never), 'gpt-5.1');
    assert.equal(resolveReviewAnalysisModel({}, { REVIEW_MODEL: 'review-model' } as never), 'review-model');
    assert.equal(resolveReviewAnalysisModel({}, { REVIEW_MODEL: '   ', AGENT_MODEL: 'agent-model' } as never), 'agent-model');
    assert.equal(resolveReviewAnalysisModel({ model: ' request-model ' }, { REVIEW_MODEL: 'review-model' } as never), 'request-model');
  }
}
