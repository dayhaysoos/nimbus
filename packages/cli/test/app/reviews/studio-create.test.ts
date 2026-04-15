import { strict as assert } from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  emitResolveReviewProgressForTests,
  preserveResolveReviewAbortForTests,
  throwIfResolveReviewAbortedForTests,
} from '../../../src/app/reviews/context.js';
import { buildStudioReviewRoutePath } from '../../../src/app/reviews/create-shared.js';
import {
  emitStudioStartEventForTests,
  resolveStudioCheckpointWindowForTests,
  resolveStudioNewReviewPreflight,
  shouldAbortStudioStartForTests,
  studioBranchContextMatchesExpected,
} from '../../../src/app/reviews/studio-create.js';
import {
  setReviewPreflightCommitResolverForTests,
  setReviewPreflightContextResolverForTests,
  setReviewPreflightLastCheckpointResolverForTests,
} from '../../../src/commands/review/preflight.js';

export async function runStudioCreateTests(): Promise<void> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'nimbus-studio-create-'));
  try {
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
            sessionId: 'session_123',
            routePath: '/reports/rev_123',
            policyMode: 'auto',
            contextMode: 'basic',
            requestedLastCheckpoints: 2,
            effectiveLastCheckpoints: 1,
            status: 'queued',
            detail: 'done',
          },
        }),
      /aborted/i
    );

    setReviewPreflightCommitResolverForTests(() => ({
      commitSha: 'abcdef1234567890',
      checkpointId: null,
      commitDiffPatch: 'diff --git a/app.ts b/app.ts\n+console.log("x")\n',
      includedCheckpoints: undefined,
      checkpointSelectionMode: 'latest',
    }));
    setReviewPreflightLastCheckpointResolverForTests(() => ({
      commitSha: '8d16d31abcdef0000',
      subject: 'docs: add review session implementation handoff',
      commitsAgo: 1,
      checkpointId: 'fba364e3d99d',
    }));
    setReviewPreflightContextResolverForTests(async () => {
      throw new Error('should not request Entire context in basic mode');
    });

    const checkpointWindow = resolveStudioCheckpointWindowForTests(repoRoot, 2);
    assert.equal(checkpointWindow.checkpointId, null);
    assert.equal(checkpointWindow.checkpointReady, false);
    assert.equal(checkpointWindow.effectiveLastCheckpoints, 1);
    assert.equal(checkpointWindow.checkpointDetail.includes('basic diff/code-aware mode'), true);

    const preflight = await resolveStudioNewReviewPreflight({
      repoRoot,
      lastCheckpoints: 2,
    });
    assert.equal(preflight.ready, true);
    assert.equal(preflight.startability, 'basic');
    assert.equal(preflight.contextMode, 'basic');
    assert.equal(preflight.requestedLastCheckpoints, 2);
    assert.equal(preflight.effectiveLastCheckpoints, 1);
    assert.equal(preflight.checkpointSelectionMode, 'latest');
    assert.equal(preflight.capabilities.canStart, true);
    assert.equal(preflight.capabilities.canStartInIntentAwareMode, false);
    assert.equal(preflight.blockingIssues.length, 0);
    assert.equal(preflight.warnings.length >= 1, true);
    assert.equal(preflight.checks[0]?.ok, false);
    assert.equal(preflight.checks[1]?.ok, false);
    assert.equal(preflight.checks[1]?.detail.includes('basic diff/code-aware mode'), true);
  } finally {
    setReviewPreflightCommitResolverForTests(null);
    setReviewPreflightContextResolverForTests(null);
    setReviewPreflightLastCheckpointResolverForTests(null);
    await rm(repoRoot, { recursive: true, force: true });
  }
}
