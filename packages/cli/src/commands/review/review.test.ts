import { strict as assert } from 'assert';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createReviewCommand,
  createReviewFromCommitCommand,
  setReviewCommitResolverForTests,
  setReviewCreateFlowForTests,
} from './create.js';
import { reviewEventsCommand } from './events.js';
import { showReviewCommand } from './show.js';
import { exportReviewCommand } from './export.js';
import {
  reviewPreflightCommand,
  setReviewPreflightCommitResolverForTests,
  setReviewPreflightContextResolverForTests,
  setReviewPreflightLastCheckpointResolverForTests,
  setReviewPreflightLastValidContextResolverForTests,
  setReviewPreflightTokenReadinessResolverForTests,
} from './preflight.js';

function createReviewResponseBody() {
  return {
    review: {
      id: 'rev_abcd1234',
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      target: {
        type: 'workspace_deployment',
        workspaceId: 'ws_abc12345',
        deploymentId: 'dep_abcd1234',
      },
      mode: 'report_only',
      status: 'succeeded',
      idempotencyKey: 'idem-review',
      attemptCount: 1,
      startedAt: '2026-03-11T00:00:00.000Z',
      finishedAt: '2026-03-11T00:01:00.000Z',
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:01:00.000Z',
      summary: {
        riskLevel: 'low',
        findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
        recommendation: 'approve',
      },
      findings: [],
      intent: {
        goal: 'Assess deployment readiness.',
        constraints: ['Non-mutating review only.'],
        decisions: ['Deployment provider: simulated.'],
      },
      evidence: [
        {
          id: 'ev_deployed_url',
          type: 'deploy_probe',
          label: 'Deployed URL present',
          status: 'passed',
          metadata: { url: 'https://example.com' },
        },
      ],
      provenance: {
        sessionIds: [],
        promptSummary: 'Review generated for deployment dep_abcd1234.',
        transcriptUrl: null,
      },
      markdownSummary: '## Review Summary\n\n- Recommendation: approve\n- Risk level: low\n- Findings: 0',
    },
  };
}

export async function runReviewCommandTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWorkerUrl = process.env.NIMBUS_WORKER_URL;
  const originalReviewGithubToken = process.env.REVIEW_CONTEXT_GITHUB_TOKEN;
  process.env.NIMBUS_WORKER_URL = 'https://worker.example.com';

  try {
    setReviewPreflightTokenReadinessResolverForTests(async () => true);
    {
      setReviewPreflightCommitResolverForTests(() => ({
        commitSha: '1'.repeat(40),
        checkpointId: null,
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightLastCheckpointResolverForTests(() => ({
        commitSha: 'abc1234def567890123456789012345678901234',
        subject: 'feat: working checkpoint commit',
        commitsAgo: 3,
      }));
      await assert.rejects(
        () => reviewPreflightCommand('HEAD'),
        /This commit has no Entire-Checkpoint trailer\. The last commit on this branch with valid checkpoint context was abc1234 \('feat: working checkpoint commit'\) 3 commits ago\./
      );
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightLastCheckpointResolverForTests(null);
    }

    {
      setReviewPreflightCommitResolverForTests(() => ({
        commitSha: '2'.repeat(40),
        checkpointId: null,
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightLastCheckpointResolverForTests(() => null);
      await assert.rejects(
        () => reviewPreflightCommand('HEAD'),
        /This branch has no Entire session history\. Make sure Entire capture is active before committing \(`entire status` to verify\)\./
      );
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightLastCheckpointResolverForTests(null);
    }

    {
      setReviewPreflightCommitResolverForTests(() => ({
        commitSha: 'e'.repeat(40),
        checkpointId: 'fba364e3d99d',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (fba364e3d99d).',
        sessionIds: ['sess_123'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      await reviewPreflightCommand('HEAD');
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
    }

    {
      setReviewPreflightCommitResolverForTests(() => ({
        commitSha: '6'.repeat(40),
        checkpointId: 'fba364e3d99d',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (fba364e3d99d).',
        sessionIds: ['sess_123'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewPreflightTokenReadinessResolverForTests(async () => false);
      await assert.rejects(
        () => reviewPreflightCommand('HEAD'),
        /Review preflight failed: co-change retrieval requires a GitHub token - set REVIEW_CONTEXT_GITHUB_TOKEN in your local \.env/
      );
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightTokenReadinessResolverForTests(async () => true);
    }

    {
      setReviewPreflightCommitResolverForTests(() => ({
        commitSha: 'f'.repeat(40),
        checkpointId: 'ddfa7c25a183',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightContextResolverForTests(async () => {
        throw new Error('Checkpoint ddfa7c25a183 had no readable session metadata');
      });
      setReviewPreflightLastValidContextResolverForTests(async () => ({
        commitSha: 'abc1234def567890123456789012345678901234',
        subject: 'feat: working checkpoint commit',
        commitsAgo: 3,
      }));
      await assert.rejects(
        () => reviewPreflightCommand('HEAD'),
        /Review preflight failed: This commit has no Entire session context\. The last commit on this branch with valid checkpoint context was abc1234 \('feat: working checkpoint commit'\) 3 commits ago\./
      );
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightLastValidContextResolverForTests(null);
    }

    {
      setReviewPreflightCommitResolverForTests(() => ({
        commitSha: '7'.repeat(40),
        checkpointId: 'ddfa7c25a183',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightContextResolverForTests(async () => {
        throw new Error('Checkpoint ddfa7c25a183 had no readable session metadata');
      });
      setReviewPreflightLastValidContextResolverForTests(async () => null);
      await assert.rejects(
        () => reviewPreflightCommand('HEAD'),
        /Review preflight failed: This branch has no Entire session history\. Make sure Entire capture is active before committing \(`entire status` to verify\)\./
      );
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightLastValidContextResolverForTests(null);
    }

    {
      setReviewPreflightCommitResolverForTests(() => ({
        commitSha: '3'.repeat(40),
        checkpointId: 'ddfa7c25a183',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightContextResolverForTests(async () => {
        throw new Error(
          'Entire session context exceeds token budget (1800 > 1200). Increase --intent-token-budget or use --summarize-session auto|always.'
        );
      });
      await assert.rejects(
        () => reviewPreflightCommand('HEAD'),
        /Review preflight failed: Entire session context exceeds token budget \(1800 > 1200\)/
      );
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
    }

    {
      setReviewPreflightCommitResolverForTests(() => ({
        commitSha: '4'.repeat(40),
        checkpointId: 'ddfa7c25a183',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightContextResolverForTests(async () => {
        throw new Error('Checkpoint ddfa7c25a183 had no readable session metadata');
      });
      setReviewPreflightLastValidContextResolverForTests(async () => ({
        commitSha: 'abc1234def567890123456789012345678901234',
        subject: 'feat: fallback context commit',
        commitsAgo: 2,
        checkpointId: 'fba364e3d99d',
        context: {
          note: 'Review with Entire checkpoint intent context (fba364e3d99d).',
          sessionIds: ['sess_fallback'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        },
      }));
      await reviewPreflightCommand('HEAD');
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightLastValidContextResolverForTests(null);
    }

    {
      let fetchCount = 0;
      globalThis.fetch = (async (): Promise<Response> => {
        fetchCount += 1;
        throw new Error('fetch should not be called when checkpoint trailer is missing');
      }) as typeof fetch;

      setReviewCommitResolverForTests(() => ({
        commitSha: 'a'.repeat(40),
        checkpointId: null,
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));

      await assert.rejects(
        () => createReviewFromCommitCommand({ commitish: 'HEAD' }),
        /Review flow failed at checkpoint resolution/
      );
      assert.equal(fetchCount, 0);
      setReviewCommitResolverForTests(null);
    }

    {
      const sequence: string[] = [];
      setReviewCommitResolverForTests(() => ({
        commitSha: '9'.repeat(40),
        checkpointId: 'ddfa7c25a183',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewPreflightContextResolverForTests(async () => {
        throw new Error('Checkpoint ddfa7c25a183 had no readable session metadata');
      });
      setReviewPreflightLastValidContextResolverForTests(async () => ({
        commitSha: 'abc1234def567890123456789012345678901234',
        subject: 'feat: working checkpoint commit',
        commitsAgo: 3,
      }));
      setReviewCreateFlowForTests({
        createWorkspace: async () => {
          sequence.push('workspace.create');
          throw new Error('should not be called');
        },
      });

      await assert.rejects(
        () => createReviewFromCommitCommand({ commitish: 'HEAD' }),
        /Review flow failed at checkpoint resolution: This commit has no Entire session context\. The last commit on this branch with valid checkpoint context was abc1234 \('feat: working checkpoint commit'\) 3 commits ago\./
      );
      assert.deepEqual(sequence, []);
      setReviewCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightLastValidContextResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      let capturedDeployResolution: Record<string, unknown> | null = null;
      let capturedReviewProvenance: Record<string, unknown> | null = null;
      setReviewPreflightContextResolverForTests(async () => {
        throw new Error('Checkpoint ddfa7c25a183 had no readable session metadata');
      });
      setReviewPreflightLastValidContextResolverForTests(async () => ({
        commitSha: 'abc1234def567890123456789012345678901234',
        subject: 'feat: fallback context commit',
        commitsAgo: 2,
        checkpointId: 'fba364e3d99d',
        context: {
          note: 'Review with Entire checkpoint intent context (fba364e3d99d).',
          sessionIds: ['sess_fallback'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        },
      }));
      setReviewCommitResolverForTests(() => ({
        commitSha: 'a'.repeat(40),
        checkpointId: 'ddfa7c25a183',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: 'a'.repeat(40),
          checkpointId: 'ddfa7c25a183',
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => ({
          workspace: {
            id: 'ws_fallback',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: 'ddfa7c25a183',
            commitSha: 'a'.repeat(40),
            sourceRef: null,
            sourceProjectRoot: '.',
            sourceBundleKey: 'bundle',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 123,
            sandboxId: 'workspace-ws_fallback',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_fallback/events',
          },
        }),
        deployWorkspace: async (_workspaceId, options) => {
          capturedDeployResolution = (options?.entireIntentContextOverride ?? null) as Record<string, unknown> | null;
          return {
            id: 'dep_fallback',
            workspaceId: 'ws_fallback',
            status: 'succeeded',
            provider: 'simulated',
            idempotencyKey: 'idem-deploy',
            maxRetries: 2,
            attemptCount: 1,
            sourceSnapshotSha256: null,
            sourceBundleKey: 'bundle',
            deployedUrl: 'https://example.dev',
            providerDeploymentId: null,
            cancelRequestedAt: null,
            startedAt: '2026-03-11T00:00:00.000Z',
            finishedAt: '2026-03-11T00:00:30.000Z',
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:30.000Z',
            provenance: {},
            toolchain: null,
            dependencyCacheKey: null,
            dependencyCacheHit: false,
            remediations: [],
          };
        },
        createReview: async (_workerUrl, _idempotencyKey, payload) => {
          capturedReviewProvenance = (payload.provenance ?? null) as Record<string, unknown> | null;
          return {
            reviewId: 'rev_fallback',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_fallback/events',
            resultUrl: '/reviews/rev_fallback',
          };
        },
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => createReviewResponseBody() as unknown as { review: any },
      });

      await createReviewFromCommitCommand({ commitish: 'HEAD' });
      assert.equal(capturedDeployResolution?.['contextResolution'], 'branch_fallback');
      assert.equal(capturedDeployResolution?.['resolvedCheckpointId'], 'fba364e3d99d');
      assert.equal(capturedReviewProvenance?.['contextResolution'], 'branch_fallback');
      assert.equal(capturedReviewProvenance?.['contextResolutionOriginalCheckpointId'], 'ddfa7c25a183');
      assert.equal(capturedReviewProvenance?.['contextResolutionResolvedCheckpointId'], 'fba364e3d99d');
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightLastValidContextResolverForTests(null);
      setReviewCommitResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      const sequence: string[] = [];
      const eventLines: string[] = [];
      let deployIdempotencyKey: string | undefined;
      let reviewIdempotencyKey: string | undefined;
      let commitFlowReviewModel: string | undefined;
      let commitFlowProjectRoot: string | undefined;
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        eventLines.push(args.map((value) => String(value)).join(' '));
      };
      try {
        setReviewPreflightContextResolverForTests(async () => ({
          note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
          sessionIds: ['sess_compound'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        }));
        setReviewCommitResolverForTests(() => ({
          commitSha: 'b'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        }));
        setReviewCreateFlowForTests({
          resolveWorkspaceSource: (_commitSha, options) => {
            commitFlowProjectRoot = options?.projectRoot;
            return {
            commitSha: 'b'.repeat(40),
            checkpointId: '8a513f56ed70',
            sourceRef: null,
            projectRoot: options?.projectRoot ?? '.',
          };
          },
          createWorkspace: async () => {
            sequence.push('workspace.create');
            return {
              workspace: {
                id: 'ws_compound',
                status: 'ready',
                sourceType: 'checkpoint',
                checkpointId: '8a513f56ed70',
                commitSha: 'b'.repeat(40),
                sourceRef: null,
                sourceProjectRoot: '.',
                sourceBundleKey: 'bundle',
                sourceBundleSha256: 'f'.repeat(64),
                sourceBundleBytes: 123,
                sandboxId: 'workspace-ws_compound',
                baselineReady: true,
                errorCode: null,
                errorMessage: null,
                createdAt: '2026-03-11T00:00:00.000Z',
                updatedAt: '2026-03-11T00:00:00.000Z',
                deletedAt: null,
                eventsUrl: '/api/workspaces/ws_compound/events',
              },
            };
          },
          deployWorkspace: async (_workspaceId, deployOptions) => {
            sequence.push('workspace.deploy');
            deployIdempotencyKey = deployOptions?.idempotencyKey;
            return {
              id: 'dep_compound',
              workspaceId: 'ws_compound',
              status: 'succeeded',
              provider: 'simulated',
              idempotencyKey: 'idem-deploy',
              maxRetries: 2,
              attemptCount: 1,
              sourceSnapshotSha256: null,
              sourceBundleKey: 'bundle',
              deployedUrl: 'https://example.dev',
              providerDeploymentId: null,
              cancelRequestedAt: null,
              startedAt: '2026-03-11T00:00:00.000Z',
              finishedAt: '2026-03-11T00:00:30.000Z',
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:30.000Z',
              provenance: {},
              toolchain: null,
              dependencyCacheKey: null,
              dependencyCacheHit: false,
              remediations: [],
            };
          },
          createReview: async (_workerUrl, idempotencyKey, payload) => {
            sequence.push('review.create');
            reviewIdempotencyKey = idempotencyKey;
            commitFlowReviewModel = payload.model;
            return {
              reviewId: 'rev_compound',
              status: 'queued',
              eventsUrl: '/api/reviews/rev_compound/events',
              resultUrl: '/reviews/rev_compound',
            };
          },
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            sequence.push('review.events');
            await onEvent({
              id: '1',
              data: {
                type: 'review_created',
                seq: 1,
                createdAt: '2026-03-11T00:00:00.000Z',
              },
            });
            await onEvent({ id: '2', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async () => {
            sequence.push('review.show');
            return createReviewResponseBody() as unknown as { review: any };
          },
        });

        await createReviewFromCommitCommand({
          commitish: 'HEAD',
          projectRoot: 'apps/web',
          idempotencyKey: 'idem-compound',
          model: 'sonnet-4.5',
        });
        assert.deepEqual(sequence, ['workspace.create', 'workspace.deploy', 'review.create', 'review.events', 'review.show']);
        assert.equal(eventLines.some((line) => line.includes('[1] review_created')), true);
        assert.equal(eventLines[eventLines.length - 1], 'Report URL: https://worker.example.com/reviews/rev_compound');
        assert.equal(typeof deployIdempotencyKey, 'string');
        assert.equal(typeof reviewIdempotencyKey, 'string');
        assert.equal(commitFlowReviewModel, 'sonnet-4.5');
        assert.equal(commitFlowProjectRoot, 'apps/web');
        assert.equal(deployIdempotencyKey?.startsWith('deploy-'), true);
        assert.equal(reviewIdempotencyKey?.startsWith('review-'), true);
      } finally {
        console.log = originalConsoleLog;
        setReviewCommitResolverForTests(null);
        setReviewPreflightContextResolverForTests(null);
        setReviewCreateFlowForTests(null);
      }
    }

    {
      let capturedProvenance: Record<string, unknown> | null = null;
      const longPatch = `diff --git a/large.txt b/large.txt\n@@ -1 +1 @@\n-${'a'.repeat(140000)}\n+${'b'.repeat(140000)}\n`;
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
        sessionIds: ['sess_longpatch'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewCommitResolverForTests(() => ({
        commitSha: 'd'.repeat(40),
        checkpointId: '8a513f56ed70',
        commitDiffPatch: longPatch,
      }));
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: 'd'.repeat(40),
          checkpointId: '8a513f56ed70',
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => ({
          workspace: {
            id: 'ws_longpatch',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: '8a513f56ed70',
            commitSha: 'd'.repeat(40),
            sourceRef: null,
            sourceProjectRoot: '.',
            sourceBundleKey: 'bundle',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 123,
            sandboxId: 'workspace-ws_longpatch',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_longpatch/events',
          },
        }),
        deployWorkspace: async () => ({
          id: 'dep_longpatch',
          workspaceId: 'ws_longpatch',
          status: 'succeeded',
          provider: 'simulated',
          idempotencyKey: 'idem-deploy',
          maxRetries: 2,
          attemptCount: 1,
          sourceSnapshotSha256: null,
          sourceBundleKey: 'bundle',
          deployedUrl: 'https://example.dev',
          providerDeploymentId: null,
          cancelRequestedAt: null,
          startedAt: '2026-03-11T00:00:00.000Z',
          finishedAt: '2026-03-11T00:00:30.000Z',
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:30.000Z',
          provenance: {},
          toolchain: null,
          dependencyCacheKey: null,
          dependencyCacheHit: false,
          remediations: [],
        }),
        createReview: async (_workerUrl, _idempotencyKey, payload) => {
          capturedProvenance = (payload.provenance ?? null) as Record<string, unknown> | null;
          return {
            reviewId: 'rev_longpatch',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_longpatch/events',
            resultUrl: '/reviews/rev_longpatch',
          };
        },
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => createReviewResponseBody() as unknown as { review: any },
      });

      await createReviewFromCommitCommand({ commitish: 'HEAD' });
      const patch = String(capturedProvenance?.['commitDiffPatch'] ?? '');
      assert.equal(patch.includes('[... NIMBUS TRUNCATED COMMIT PATCH ...]'), true);
      assert.equal(typeof capturedProvenance?.['commitDiffPatchSha256'], 'string');
      assert.equal(capturedProvenance?.['commitDiffPatchTruncated'], true);
      assert.equal(capturedProvenance?.['commitDiffPatchOriginalChars'], longPatch.length);
      setReviewCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
        sessionIds: ['sess_faildeploy'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewCommitResolverForTests(() => ({
        commitSha: 'c'.repeat(40),
        checkpointId: '8a513f56ed70',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      const sequence: string[] = [];
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: 'c'.repeat(40),
          checkpointId: '8a513f56ed70',
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => {
          sequence.push('workspace.create');
          return {
            workspace: {
              id: 'ws_faildeploy',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: '8a513f56ed70',
              commitSha: 'c'.repeat(40),
              sourceRef: null,
              sourceProjectRoot: '.',
              sourceBundleKey: 'bundle',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 123,
              sandboxId: 'workspace-ws_faildeploy',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_faildeploy/events',
            },
          };
        },
        deployWorkspace: async () => {
          sequence.push('workspace.deploy');
          throw new Error('deploy preflight failed');
        },
        createReview: async () => {
          sequence.push('review.create');
          throw new Error('should not be called');
        },
      });

      await assert.rejects(
        () => createReviewFromCommitCommand({ commitish: 'HEAD' }),
        /Review flow failed at workspace deploy: deploy preflight failed/
      );
      assert.deepEqual(sequence, ['workspace.create', 'workspace.deploy']);
      setReviewCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      process.env.REVIEW_CONTEXT_GITHUB_TOKEN = 'ghp_test_local_token';
      globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            reviewId: 'rev_abcd1234',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_abcd1234/events',
            resultUrl: '/api/reviews/rev_abcd1234',
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      await createReviewCommand('ws_abc12345', 'dep_abcd1234', {
        idempotencyKey: 'idem-review-1',
        severityThreshold: 'medium',
        maxFindings: 12,
        model: 'sonnet-4.5',
        includeProvenance: false,
        includeValidationEvidence: false,
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url.endsWith('/api/reviews'), true);
      assert.equal((requests[0].init?.headers as Record<string, string>)['Idempotency-Key'], 'idem-review-1');
      assert.equal(
        (requests[0].init?.headers as Record<string, string>)['X-Review-Github-Token'],
        'ghp_test_local_token'
      );
      const requestBody = JSON.parse(String(requests[0].init?.body ?? '{}')) as {
        model?: string;
        policy?: {
          severityThreshold?: string;
          maxFindings?: number;
          includeProvenance?: boolean;
          includeValidationEvidence?: boolean;
        };
        provenance?: {
          note?: string | null;
          sessionIds?: string[];
          intentSessionContext?: string[];
        };
      };
      assert.equal(requestBody.policy?.severityThreshold, 'medium');
      assert.equal(requestBody.policy?.maxFindings, 12);
      assert.equal(requestBody.model, 'sonnet-4.5');
      assert.equal(requestBody.policy?.includeProvenance, false);
      assert.equal(requestBody.policy?.includeValidationEvidence, false);
      assert.equal(requestBody.provenance, undefined);
    }

    {
      let fetchCount = 0;
      process.env.REVIEW_CONTEXT_GITHUB_TOKEN = '';
      setReviewPreflightTokenReadinessResolverForTests(async () => false);
      globalThis.fetch = (async (): Promise<Response> => {
        fetchCount += 1;
        throw new Error('fetch should not be called when token readiness fails');
      }) as typeof fetch;

      await assert.rejects(
        () => createReviewCommand('ws_abc12345', 'dep_abcd1234', { idempotencyKey: 'idem-review-token-missing' }),
        /co-change retrieval requires a GitHub token - set REVIEW_CONTEXT_GITHUB_TOKEN in your local \.env/
      );
      assert.equal(fetchCount, 0);
      setReviewPreflightTokenReadinessResolverForTests(async () => true);
    }

    {
      let fetchCount = 0;
      globalThis.fetch = (async (): Promise<Response> => {
        fetchCount += 1;
        return new Response(JSON.stringify(createReviewResponseBody()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      await showReviewCommand('rev_abcd1234');
      assert.equal(fetchCount, 1);
    }

    {
      const lines: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      };
      try {
        globalThis.fetch = (async (): Promise<Response> => {
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  ['id: 1', 'data: {"type":"review_created","seq":1,"createdAt":"2026-03-11T00:00:00.000Z"}', '', ''].join('\n')
                )
              );
              await new Promise((resolve) => setTimeout(resolve, 10));
              controller.enqueue(
                encoder.encode(
                  ['data: {"type":"terminal","status":"succeeded"}', 'data: {"type":"snapshot","status":"succeeded"}', '', ''].join('\n')
                )
              );
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }) as typeof fetch;

        await reviewEventsCommand('rev_abcd1234');
        assert.equal(lines.some((line) => line.includes('[1] review_created')), true);
        assert.equal(lines.some((line) => line.includes('[terminal] status=succeeded')), true);
        assert.equal(lines.some((line) => line.includes('[snapshot] status=succeeded')), true);
      } finally {
        console.log = originalConsoleLog;
      }
    }

    {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(JSON.stringify(createReviewResponseBody()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      const dir = await mkdtemp(join(tmpdir(), 'nimbus-review-'));
      try {
        const markdownPath = join(dir, 'review.md');
        await exportReviewCommand('rev_abcd1234', 'markdown', markdownPath);
        const markdown = await readFile(markdownPath, 'utf8');
        assert.match(markdown, /## Review Summary/);

        const jsonPath = join(dir, 'review.json');
        await exportReviewCommand('rev_abcd1234', 'json', jsonPath);
        const json = await readFile(jsonPath, 'utf8');
        assert.match(json, /"id": "rev_abcd1234"/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  } finally {
    setReviewCommitResolverForTests(null);
    setReviewCreateFlowForTests(null);
    setReviewPreflightCommitResolverForTests(null);
    setReviewPreflightContextResolverForTests(null);
    setReviewPreflightLastCheckpointResolverForTests(null);
    setReviewPreflightLastValidContextResolverForTests(null);
    setReviewPreflightTokenReadinessResolverForTests(null);
    globalThis.fetch = originalFetch;
    process.env.NIMBUS_WORKER_URL = originalWorkerUrl;
    process.env.REVIEW_CONTEXT_GITHUB_TOKEN = originalReviewGithubToken;
  }
}
