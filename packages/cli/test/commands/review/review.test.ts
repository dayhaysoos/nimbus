import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as p from '@clack/prompts';
import {
  createReviewCommand,
  createReviewFromCommitCommand,
  createReviewSessionCommand,
  setReviewCommitResolverForTests,
  setReviewCreateFlowForTests,
  setReviewSessionCreateFlowForTests,
} from '../../../src/commands/review/create.js';
import { reviewEventsCommand } from '../../../src/commands/review/events.js';
import { showReviewCommand } from '../../../src/commands/review/show.js';
import { exportReviewCommand } from '../../../src/commands/review/export.js';
import {
  materializeReviewSessionCommand,
  resetReviewSessionCommand,
  setReviewSessionMaterializeFlowForTests,
  showReviewSessionCommand,
} from '../../../src/commands/review/session.js';
import { WorkspaceCreateInProgressError } from '../../../src/clients/worker/workspaces.js';
import {
  reviewPreflightCommand,
  setReviewPreflightCommitResolverForTests,
  setReviewPreflightContextResolverForTests,
  setReviewPreflightLocalCochangeResolverForTests,
  setReviewPreflightLastCheckpointResolverForTests,
  setReviewPreflightLastValidContextResolverForTests,
  setReviewPreflightTokenReadinessResolverForTests,
} from '../../../src/commands/review/preflight.js';
import { dispatchReviewCommand } from '../../../src/cli/dispatch/review.js';
import { followReviewChain } from '../../../src/app/reviews/create-shared.js';

function createReviewResponseBody() {
  return {
    review: {
      id: 'rev_abcd1234',
      workspaceId: 'ws_abc12345',
      deploymentId: 'dep_abcd1234',
      sessionId: 'session_abcd1234',
      target: {
        type: 'workspace_deployment',
        workspaceId: 'ws_abc12345',
        deploymentId: 'dep_abcd1234',
      },
      mode: 'report_only',
      status: 'succeeded',
      reviewBasis: 'checkpoint',
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
        environmentRevision: undefined,
        promptSummary: 'Review generated for deployment dep_abcd1234.',
        transcriptUrl: null,
      },
      markdownSummary: '## Review Summary\n\n- Recommendation: approve\n- Risk level: low\n- Findings: 0',
    },
    session: {
      id: 'session_abcd1234',
      workspaceId: 'ws_abc12345',
      anchorDeploymentId: 'dep_abcd1234',
      repo: 'dayhaysoos/nimbus',
      branch: 'main',
      initialReviewBasis: 'checkpoint',
      anchorCommitSha: 'a'.repeat(40),
      anchorCheckpointId: '8a513f56ed70',
      sourceProjectRoot: '.',
      phase: 'completed',
      passCount: 1,
      activeReviewId: 'rev_abcd1234',
      latestReviewId: 'rev_abcd1234',
      currentReviewStatus: 'succeeded',
      stopReason: 'initial_pass_completed',
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:01:00.000Z',
      finishedAt: '2026-03-11T00:01:00.000Z',
      passes: [
        {
          reviewId: 'rev_abcd1234',
          status: 'succeeded',
          reviewBasis: 'checkpoint',
          createdAt: '2026-03-11T00:00:00.000Z',
          startedAt: '2026-03-11T00:00:10.000Z',
          finishedAt: '2026-03-11T00:01:00.000Z',
        },
      ],
      outcome: {
        kind: 'clean',
        summary: 'Nimbus completed review and no actionable findings remain.',
        residualRisk: 'low',
        recommendation: 'approve',
        materializeReady: false,
        reviewed: {
          contextMode: 'intent_aware',
          latestReviewBasis: 'checkpoint',
          passCount: 1,
        },
        changes: {
          applied: false,
          remediationCount: 0,
          changedFileCount: 0,
          summaries: [],
          environmentRevision: null,
        },
        evidence: {
          passed: 1,
          failed: 0,
          warning: 0,
          info: 0,
          highlights: [
            {
              id: 'ev_deployed_url',
              type: 'deploy_probe',
              label: 'Deployed URL present',
              status: 'passed',
              metadata: { url: 'https://example.com' },
            },
          ],
        },
        unresolved: {
          findingCount: 0,
          highestSeverity: null,
          highlights: [],
        },
      },
    },
  };
}

function runGitForTest(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

async function createMaterializeTestRepo(): Promise<{
  repoRoot: string;
  anchorCommitSha: string;
  patch: string;
  patchSha256: string;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'nimbus-materialize-'));
  runGitForTest(repoRoot, ['init', '-b', 'main']);
  runGitForTest(repoRoot, ['config', 'user.name', 'Nimbus Test']);
  runGitForTest(repoRoot, ['config', 'user.email', 'nimbus@example.com']);
  runGitForTest(repoRoot, ['remote', 'add', 'origin', 'https://github.com/dayhaysoos/nimbus.git']);

  await writeFile(join(repoRoot, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n', 'utf8');
  runGitForTest(repoRoot, ['add', 'math.js']);
  runGitForTest(repoRoot, ['commit', '-m', 'base']);
  const anchorCommitSha = runGitForTest(repoRoot, ['rev-parse', 'HEAD']).trim();

  await writeFile(join(repoRoot, 'math.js'), 'export function add(a, b) {\n  return a + b;\n}\n', 'utf8');
  const patch = runGitForTest(repoRoot, ['diff', '--no-ext-diff', '--unified=3']);
  runGitForTest(repoRoot, ['checkout', '--', 'math.js']);

  return {
    repoRoot,
    anchorCommitSha,
    patch,
    patchSha256: createHash('sha256').update(patch).digest('hex'),
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
      await assert.doesNotReject(() => reviewPreflightCommand('HEAD'));
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
      await assert.doesNotReject(() => reviewPreflightCommand('HEAD'));
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightLastCheckpointResolverForTests(null);
    }

    {
      let capturedLastCheckpoints: number | undefined;
      let capturedCheckpointRange: string | undefined;
      setReviewPreflightCommitResolverForTests((_commitish, options) => {
        capturedLastCheckpoints = options?.lastCheckpoints;
        capturedCheckpointRange = options?.checkpointRange;
        return {
          commitSha: 'd'.repeat(40),
          checkpointId: 'fba364e3d99d',
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        };
      });
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (fba364e3d99d).',
        sessionIds: ['sess_123'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      await reviewPreflightCommand('HEAD', {
        lastCheckpoints: 3,
        checkpointRange: 'checkpoint:aaa..checkpoint:bbb',
      });
      assert.equal(capturedLastCheckpoints, 3);
      assert.equal(capturedCheckpointRange, 'checkpoint:aaa..checkpoint:bbb');
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
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
      setReviewPreflightLocalCochangeResolverForTests(() => false);
      await assert.rejects(
        () => reviewPreflightCommand('HEAD'),
        /Review preflight failed: REVIEW_CONTEXT_GITHUB_TOKEN is required for GitHub co-change retrieval when local co-change context is unavailable/
      );
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightTokenReadinessResolverForTests(async () => true);
      setReviewPreflightLocalCochangeResolverForTests(null);
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
      await assert.doesNotReject(() => reviewPreflightCommand('HEAD'));
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
      await assert.doesNotReject(() => reviewPreflightCommand('HEAD'));
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
      await assert.doesNotReject(() => reviewPreflightCommand('HEAD'));
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
      await assert.doesNotReject(() => reviewPreflightCommand('HEAD'));
      setReviewPreflightCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightLastValidContextResolverForTests(null);
    }

    {
      let fetchCount = 0;
      let capturedProvenance: Record<string, unknown> | null = null;
      try {
        globalThis.fetch = (async (): Promise<Response> => {
          fetchCount += 1;
          throw new Error('fetch should not be called when checkpoint trailer is missing');
        }) as typeof fetch;

        setReviewCommitResolverForTests(() => ({
          commitSha: 'a'.repeat(40),
          checkpointId: null,
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        }));
        setReviewCreateFlowForTests({
          resolveWorkspaceSource: () => ({
            commitSha: 'a'.repeat(40),
            checkpointId: null,
            sourceRef: null,
            projectRoot: '.',
          }),
          createWorkspace: async () => ({
            workspace: {
              id: 'ws_basic_no_checkpoint',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: null,
              commitSha: 'a'.repeat(40),
              sourceRef: null,
              sourceProjectRoot: '.',
              sourceBundleKey: 'bundle',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 123,
              sandboxId: 'workspace-ws_basic_no_checkpoint',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_basic_no_checkpoint/events',
            },
          }),
          deployWorkspace: async () => ({
            id: 'dep_basic_no_checkpoint',
            workspaceId: 'ws_basic_no_checkpoint',
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
            capturedProvenance = payload.provenance as Record<string, unknown>;
            return {
              reviewId: 'rev_basic_no_checkpoint',
              status: 'queued',
              eventsUrl: '/api/reviews/rev_basic_no_checkpoint/events',
              resultUrl: '/reviews/rev_basic_no_checkpoint',
            };
          },
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async () => createReviewResponseBody() as unknown as { review: any },
        });

        await assert.doesNotReject(() => createReviewFromCommitCommand({ commitish: 'HEAD' }));
        assert.equal(fetchCount, 0);
        assert.equal(capturedProvenance?.['reviewContextMode'], 'basic');
      } finally {
        globalThis.fetch = originalFetch;
        setReviewCommitResolverForTests(null);
        setReviewCreateFlowForTests(null);
      }
    }

    {
      const sequence: string[] = [];
      let capturedProvenance: Record<string, unknown> | null = null;
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
        resolveWorkspaceSource: () => ({
          commitSha: '9'.repeat(40),
          checkpointId: 'ddfa7c25a183',
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => {
          sequence.push('workspace.create');
          return {
            workspace: {
              id: 'ws_basic_fallback',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: 'ddfa7c25a183',
              commitSha: '9'.repeat(40),
              sourceRef: null,
              sourceProjectRoot: '.',
              sourceBundleKey: 'bundle',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 123,
              sandboxId: 'workspace-ws_basic_fallback',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_basic_fallback/events',
            },
          };
        },
        deployWorkspace: async () => ({
          id: 'dep_basic_fallback',
          workspaceId: 'ws_basic_fallback',
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
          capturedProvenance = payload.provenance as Record<string, unknown>;
          return {
            reviewId: 'rev_basic_fallback',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_basic_fallback/events',
            resultUrl: '/reviews/rev_basic_fallback',
          };
        },
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => createReviewResponseBody() as unknown as { review: any },
      });

      await assert.doesNotReject(() => createReviewFromCommitCommand({ commitish: 'HEAD' }));
      assert.deepEqual(sequence, ['workspace.create']);
      assert.equal(capturedProvenance?.['reviewContextMode'], 'basic');
      setReviewCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightLastValidContextResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      let capturedBaseRef: string | undefined;
      let capturedLastCheckpoints: number | undefined;
      let capturedCheckpointRange: string | undefined;
      setReviewCommitResolverForTests((_commitish, options) => {
        capturedBaseRef = options?.baseRef;
        capturedLastCheckpoints = options?.lastCheckpoints;
        capturedCheckpointRange = options?.checkpointRange;
        return {
          commitSha: '1'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/range.txt b/range.txt\nindex 111..222 100644\n--- a/range.txt\n+++ b/range.txt\n@@ -1 +1 @@\n-a\n+b\n',
        };
      });
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
        sessionIds: ['sess_base_ref'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: '1'.repeat(40),
          checkpointId: '8a513f56ed70',
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => ({
          workspace: {
            id: 'ws_base_ref',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: '8a513f56ed70',
            commitSha: '1'.repeat(40),
            sourceRef: null,
            sourceProjectRoot: '.',
            sourceBundleKey: 'bundle',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 123,
            sandboxId: 'workspace-ws_base_ref',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_base_ref/events',
          },
        }),
        deployWorkspace: async () => ({
          id: 'dep_base_ref',
          workspaceId: 'ws_base_ref',
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
        createReview: async () => ({
          reviewId: 'rev_base_ref',
          status: 'queued',
          eventsUrl: '/api/reviews/rev_base_ref/events',
          resultUrl: '/reviews/rev_base_ref',
        }),
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => createReviewResponseBody() as unknown as { review: any },
      });

      await createReviewFromCommitCommand({
        commitish: 'HEAD',
        baseRef: 'origin/main',
        lastCheckpoints: 2,
        checkpointRange: 'checkpoint:aaa..checkpoint:bbb',
      });
      assert.equal(capturedBaseRef, 'origin/main');
      assert.equal(capturedLastCheckpoints, 2);
      assert.equal(capturedCheckpointRange, 'checkpoint:aaa..checkpoint:bbb');
      setReviewCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      let capturedBaseRef: string | undefined;
      let capturedProvenance: Record<string, unknown> | null = null;
      setReviewCommitResolverForTests((_commitish, options) => {
        capturedBaseRef = options?.baseRef;
        return {
          commitSha: '2'.repeat(40),
          checkpointId: null,
          commitDiffPatch: 'diff --git a/commit.txt b/commit.txt\nindex 111..222 100644\n--- a/commit.txt\n+++ b/commit.txt\n@@ -1 +1 @@\n-a\n+b\n',
        };
      });
      setReviewPreflightLastCheckpointResolverForTests(() => ({
        commitSha: 'abc1234def567890123456789012345678901234',
        subject: 'feat: fallback checkpoint commit',
        commitsAgo: 2,
        checkpointId: '8a513f56ed70',
      }));
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
        sessionIds: ['sess_base_fallback'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: '2'.repeat(40),
          checkpointId: null,
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => ({
          workspace: {
            id: 'ws_basic_base_ref',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: null,
            commitSha: '2'.repeat(40),
            sourceRef: 'origin/main',
            sourceProjectRoot: '.',
            sourceBundleKey: 'bundle',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 123,
            sandboxId: 'workspace-ws_basic_base_ref',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_basic_base_ref/events',
          },
        }),
        deployWorkspace: async () => ({
          id: 'dep_basic_base_ref',
          workspaceId: 'ws_basic_base_ref',
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
          capturedProvenance = payload.provenance as Record<string, unknown>;
          return {
            reviewId: 'rev_basic_base_ref',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_basic_base_ref/events',
            resultUrl: '/reviews/rev_basic_base_ref',
          };
        },
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => createReviewResponseBody() as unknown as { review: any },
      });

      await assert.doesNotReject(() => createReviewFromCommitCommand({ commitish: 'HEAD', baseRef: 'origin/main' }));
      assert.equal(capturedBaseRef, 'origin/main');
      assert.equal(capturedProvenance?.['reviewContextMode'], 'basic');
      setReviewCommitResolverForTests(null);
      setReviewPreflightLastCheckpointResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      let capturedBaseRef: string | undefined;
      setReviewCommitResolverForTests((_commitish, options) => {
        capturedBaseRef = options?.baseRef;
        return {
          commitSha: '2'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/commit.txt b/commit.txt\nindex 111..222 100644\n--- a/commit.txt\n+++ b/commit.txt\n@@ -1 +1 @@\n-a\n+b\n',
        };
      });
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
        sessionIds: ['sess_commit_patch'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: '2'.repeat(40),
          checkpointId: '8a513f56ed70',
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => ({
          workspace: {
            id: 'ws_commit_patch',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: '8a513f56ed70',
            commitSha: '2'.repeat(40),
            sourceRef: null,
            sourceProjectRoot: '.',
            sourceBundleKey: 'bundle',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 123,
            sandboxId: 'workspace-ws_commit_patch',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_commit_patch/events',
          },
        }),
        deployWorkspace: async () => ({
          id: 'dep_commit_patch',
          workspaceId: 'ws_commit_patch',
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
        createReview: async () => ({
          reviewId: 'rev_commit_patch',
          status: 'queued',
          eventsUrl: '/api/reviews/rev_commit_patch/events',
          resultUrl: '/reviews/rev_commit_patch',
        }),
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => createReviewResponseBody() as unknown as { review: any },
      });

      await createReviewFromCommitCommand({ commitish: 'HEAD' });
      assert.equal(capturedBaseRef, undefined);
      setReviewCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      const dir = await mkdtemp(join(tmpdir(), 'nimbus-review-id-success-'));
      const reviewIdPath = join(dir, 'review-id.txt');
      try {
        setReviewPreflightContextResolverForTests(async () => ({
          note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
          sessionIds: ['sess_review_id_write'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        }));
        setReviewCommitResolverForTests(() => ({
          commitSha: '3'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        }));
        setReviewCreateFlowForTests({
          resolveWorkspaceSource: () => ({
            commitSha: '3'.repeat(40),
            checkpointId: '8a513f56ed70',
            sourceRef: null,
            projectRoot: '.',
          }),
          createWorkspace: async () => ({
            workspace: {
              id: 'ws_review_id_write',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: '8a513f56ed70',
              commitSha: '3'.repeat(40),
              sourceRef: null,
              sourceProjectRoot: '.',
              sourceBundleKey: 'bundle',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 123,
              sandboxId: 'workspace-ws_review_id_write',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_review_id_write/events',
            },
          }),
          deployWorkspace: async () => ({
            id: 'dep_review_id_write',
            workspaceId: 'ws_review_id_write',
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
          createReview: async () => ({
            reviewId: 'rev_review_id_write',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_review_id_write/events',
            resultUrl: '/reviews/rev_review_id_write',
          }),
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async () => createReviewResponseBody() as unknown as { review: any },
        });

        await createReviewFromCommitCommand({ commitish: 'HEAD', outputReviewIdPath: reviewIdPath });
        const saved = await readFile(reviewIdPath, 'utf8');
        assert.equal(saved.trim(), 'rev_review_id_write');
      } finally {
        setReviewCommitResolverForTests(null);
        setReviewPreflightContextResolverForTests(null);
        setReviewCreateFlowForTests(null);
        await rm(dir, { recursive: true, force: true });
      }
    }

    {
      const dir = await mkdtemp(join(tmpdir(), 'nimbus-review-id-failure-'));
      const reviewIdPath = join(dir, 'review-id.txt');
      try {
        setReviewPreflightContextResolverForTests(async () => ({
          note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
          sessionIds: ['sess_review_id_fail'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        }));
        setReviewCommitResolverForTests(() => ({
          commitSha: '4'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        }));
        setReviewCreateFlowForTests({
          resolveWorkspaceSource: () => ({
            commitSha: '4'.repeat(40),
            checkpointId: '8a513f56ed70',
            sourceRef: null,
            projectRoot: '.',
          }),
          createWorkspace: async () => ({
            workspace: {
              id: 'ws_review_id_fail',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: '8a513f56ed70',
              commitSha: '4'.repeat(40),
              sourceRef: null,
              sourceProjectRoot: '.',
              sourceBundleKey: 'bundle',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 123,
              sandboxId: 'workspace-ws_review_id_fail',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_review_id_fail/events',
            },
          }),
          deployWorkspace: async () => ({
            id: 'dep_review_id_fail',
            workspaceId: 'ws_review_id_fail',
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
          createReview: async () => ({
            reviewId: 'rev_review_id_fail',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_review_id_fail/events',
            resultUrl: '/reviews/rev_review_id_fail',
          }),
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: '1', data: { type: 'terminal', status: 'failed' } });
          },
          getReview: async () => ({
            review: {
              ...createReviewResponseBody().review,
              status: 'failed',
              error: {
                code: 'review_failed',
                message: 'review failed in test',
              },
            },
          }) as unknown as { review: any },
        });

        await assert.rejects(() => createReviewFromCommitCommand({ commitish: 'HEAD', outputReviewIdPath: reviewIdPath }));
        assert.equal(existsSync(reviewIdPath), true);
        const saved = await readFile(reviewIdPath, 'utf8');
        assert.equal(saved.trim(), 'rev_review_id_fail');
      } finally {
        setReviewCommitResolverForTests(null);
        setReviewPreflightContextResolverForTests(null);
        setReviewCreateFlowForTests(null);
        await rm(dir, { recursive: true, force: true });
      }
    }

    {
      const dir = await mkdtemp(join(tmpdir(), 'nimbus-review-id-followup-'));
      const reviewIdPath = join(dir, 'review-id.txt');
      try {
        let sessionReads = 0;
        setReviewPreflightContextResolverForTests(async () => ({
          note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
          sessionIds: ['sess_review_id_followup'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        }));
        setReviewCommitResolverForTests(() => ({
          commitSha: '8'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        }));
        setReviewCreateFlowForTests({
          resolveWorkspaceSource: () => ({
            commitSha: '8'.repeat(40),
            checkpointId: '8a513f56ed70',
            sourceRef: null,
            projectRoot: '.',
          }),
          createWorkspace: async () => ({
            workspace: {
              id: 'ws_review_id_followup',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: '8a513f56ed70',
              commitSha: '8'.repeat(40),
              sourceRef: null,
              sourceProjectRoot: '.',
              sourceBundleKey: 'bundle',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 123,
              sandboxId: 'workspace-ws_review_id_followup',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_review_id_followup/events',
            },
          }),
          deployWorkspace: async () => ({
            id: 'dep_review_id_followup',
            workspaceId: 'ws_review_id_followup',
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
          createReview: async () => ({
            reviewId: 'rev_review_id_followup_1',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_review_id_followup_1/events',
            resultUrl: '/reviews/rev_review_id_followup_1',
          }),
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async (_workerUrl, reviewId) => ({
            review: {
              ...createReviewResponseBody().review,
              id: reviewId,
              sessionId: 'session_abcd1234',
              status: 'succeeded',
              reviewBasis: reviewId === 'rev_review_id_followup_2' ? 'environment' : 'checkpoint',
            },
            session:
              reviewId === 'rev_review_id_followup_2'
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_review_id_followup_2',
                    activeReviewId: null,
                    passCount: 2,
                    stopReason: 'followup_pass_completed',
                    finishedAt: '2026-03-11T00:03:00.000Z',
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_review_id_followup_1',
                    activeReviewId: 'rev_review_id_followup_1',
                    passCount: 1,
                    stopReason: null,
                    finishedAt: null,
                  },
          }) as any,
          getReviewSession: async () => {
            sessionReads += 1;
            return {
              session:
                sessionReads === 1
                  ? {
                      ...createReviewResponseBody().session,
                      latestReviewId: 'rev_review_id_followup_2',
                      activeReviewId: 'rev_review_id_followup_2',
                      passCount: 2,
                      stopReason: null,
                      finishedAt: null,
                      passes: [
                        ...createReviewResponseBody().session.passes,
                        {
                          reviewId: 'rev_review_id_followup_2',
                          status: 'queued',
                          reviewBasis: 'environment',
                          createdAt: '2026-03-11T00:02:00.000Z',
                          startedAt: null,
                          finishedAt: null,
                        },
                      ],
                    }
                  : {
                      ...createReviewResponseBody().session,
                      latestReviewId: 'rev_review_id_followup_2',
                      activeReviewId: null,
                      passCount: 2,
                      stopReason: 'followup_pass_completed',
                      finishedAt: '2026-03-11T00:03:00.000Z',
                    },
            } as any;
          },
        });

        await createReviewFromCommitCommand({ commitish: 'HEAD', outputReviewIdPath: reviewIdPath, pollIntervalMs: 1 });
        const saved = await readFile(reviewIdPath, 'utf8');
        assert.equal(saved.trim(), 'rev_review_id_followup_2');
      } finally {
        setReviewCommitResolverForTests(null);
        setReviewPreflightContextResolverForTests(null);
        setReviewCreateFlowForTests(null);
        await rm(dir, { recursive: true, force: true });
      }
    }

    {
      const warnings: string[] = [];
      const originalWarning = p.log.warning;
      (p.log as { warning: (message: string) => void }).warning = (message: string) => {
        warnings.push(message);
      };
      try {
        setReviewPreflightContextResolverForTests(async () => ({
          note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
          sessionIds: ['sess_review_id_warn'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        }));
        setReviewCommitResolverForTests(() => ({
          commitSha: '5'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        }));
        setReviewCreateFlowForTests({
          resolveWorkspaceSource: () => ({
            commitSha: '5'.repeat(40),
            checkpointId: '8a513f56ed70',
            sourceRef: null,
            projectRoot: '.',
          }),
          createWorkspace: async () => ({
            workspace: {
              id: 'ws_review_id_warn',
              status: 'ready',
              sourceType: 'checkpoint',
              checkpointId: '8a513f56ed70',
              commitSha: '5'.repeat(40),
              sourceRef: null,
              sourceProjectRoot: '.',
              sourceBundleKey: 'bundle',
              sourceBundleSha256: 'f'.repeat(64),
              sourceBundleBytes: 123,
              sandboxId: 'workspace-ws_review_id_warn',
              baselineReady: true,
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-03-11T00:00:00.000Z',
              updatedAt: '2026-03-11T00:00:00.000Z',
              deletedAt: null,
              eventsUrl: '/api/workspaces/ws_review_id_warn/events',
            },
          }),
          deployWorkspace: async () => ({
            id: 'dep_review_id_warn',
            workspaceId: 'ws_review_id_warn',
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
          createReview: async () => ({
            reviewId: 'rev_review_id_warn',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_review_id_warn/events',
            resultUrl: '/reviews/rev_review_id_warn',
          }),
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async () => createReviewResponseBody() as unknown as { review: any },
        });

        await createReviewFromCommitCommand({ commitish: 'HEAD', outputReviewIdPath: '   ' });
        assert.equal(warnings.some((message) => message.includes('Ignoring --output-review-id because the provided path is empty.')), true);
      } finally {
        (p.log as { warning: (message: string) => void }).warning = originalWarning;
        setReviewCommitResolverForTests(null);
        setReviewPreflightContextResolverForTests(null);
        setReviewCreateFlowForTests(null);
      }
    }

    {
      const sequence: string[] = [];
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
        createWorkspace: async () => {
          sequence.push('workspace.create');
          return {
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
          };
        },
      });

      await assert.rejects(() => createReviewFromCommitCommand({ commitish: 'HEAD' }), /Review flow failed at workspace creation:/);
      assert.deepEqual(sequence, []);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightLastValidContextResolverForTests(null);
      setReviewCommitResolverForTests(null);
      setReviewCreateFlowForTests(null);
    }

    {
      const sequence: string[] = [];
      const eventLines: string[] = [];
      let workspaceIdempotencyKey: string | undefined;
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
          createWorkspace: async (_source, createOptions) => {
            sequence.push('workspace.create');
            workspaceIdempotencyKey = createOptions?.idempotencyKey;
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
        assert.equal(eventLines.some((line) => line.includes('Session Outcome:')), true);
        assert.equal(eventLines.some((line) => line.includes('Outcome:') && line.includes('clean')), true);
        assert.equal(eventLines[eventLines.length - 1], 'Report URL: https://worker.example.com/reviews/rev_compound');
        assert.equal(typeof workspaceIdempotencyKey, 'string');
        assert.equal(typeof deployIdempotencyKey, 'string');
        assert.equal(typeof reviewIdempotencyKey, 'string');
        assert.equal(commitFlowReviewModel, 'sonnet-4.5');
        assert.equal(commitFlowProjectRoot, 'apps/web');
        assert.equal(workspaceIdempotencyKey?.startsWith('workspace-'), true);
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
      const workspaceIdempotencyKeys: string[] = [];
      const deployIdempotencyKeys: string[] = [];
      const reviewIdempotencyKeys: string[] = [];
      const originalConsoleLog = console.log;
      console.log = () => undefined;
      try {
        setReviewPreflightContextResolverForTests(async () => ({
          note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
          sessionIds: ['sess_reuse'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        }));
        setReviewCommitResolverForTests(() => ({
          commitSha: 'c'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        }));
        setReviewCreateFlowForTests({
          resolveWorkspaceSource: (_commitSha, options) => ({
            commitSha: 'c'.repeat(40),
            checkpointId: '8a513f56ed70',
            sourceRef: null,
            projectRoot: options?.projectRoot ?? '.',
          }),
          createWorkspace: async (_source, createOptions) => {
            workspaceIdempotencyKeys.push(createOptions?.idempotencyKey ?? '');
            return {
              workspace: {
                id: 'ws_reuse',
                status: 'ready',
                sourceType: 'checkpoint',
                checkpointId: '8a513f56ed70',
                commitSha: 'c'.repeat(40),
                sourceRef: null,
                sourceProjectRoot: '.',
                sourceBundleKey: 'bundle',
                sourceBundleSha256: 'f'.repeat(64),
                sourceBundleBytes: 123,
                sandboxId: 'workspace-ws_reuse',
                baselineReady: true,
                errorCode: null,
                errorMessage: null,
                createdAt: '2026-03-11T00:00:00.000Z',
                updatedAt: '2026-03-11T00:00:00.000Z',
                deletedAt: null,
                eventsUrl: '/api/workspaces/ws_reuse/events',
              },
            };
          },
          deployWorkspace: async (_workspaceId, deployOptions) => {
            deployIdempotencyKeys.push(deployOptions?.idempotencyKey ?? '');
            return {
              id: 'dep_reuse',
              workspaceId: 'ws_reuse',
              status: 'succeeded',
              provider: 'simulated',
              idempotencyKey: deployOptions?.idempotencyKey ?? 'idem-deploy',
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
          createReview: async (_workerUrl, idempotencyKey) => {
            reviewIdempotencyKeys.push(idempotencyKey);
            return {
              reviewId: `rev_reuse_${reviewIdempotencyKeys.length}`,
              status: 'queued',
              eventsUrl: '/api/reviews/rev_reuse/events',
              resultUrl: '/reviews/rev_reuse',
            };
          },
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async () => createReviewResponseBody() as unknown as { review: any },
        });

        await createReviewFromCommitCommand({ commitish: 'HEAD' });
        await createReviewFromCommitCommand({ commitish: 'HEAD' });

        assert.equal(workspaceIdempotencyKeys.length, 2);
        assert.equal(deployIdempotencyKeys.length, 2);
        assert.equal(reviewIdempotencyKeys.length, 2);
        assert.equal(workspaceIdempotencyKeys[0], workspaceIdempotencyKeys[1]);
        assert.equal(deployIdempotencyKeys[0], deployIdempotencyKeys[1]);
        assert.notEqual(reviewIdempotencyKeys[0], reviewIdempotencyKeys[1]);
      } finally {
        console.log = originalConsoleLog;
        setReviewCommitResolverForTests(null);
        setReviewPreflightContextResolverForTests(null);
        setReviewCreateFlowForTests(null);
      }
    }

    {
      const originalFetch = globalThis.fetch;
      const originalConsoleLog = console.log;
      let workspacePollCount = 0;
      let deployedWorkspaceId = '';
      console.log = () => undefined;
      try {
        globalThis.fetch = (async (input: unknown): Promise<Response> => {
          const url = String(input);
          if (url.endsWith('/api/workspaces/ws_in_progress')) {
            workspacePollCount += 1;
            return new Response(
              JSON.stringify({
                id: 'ws_in_progress',
                status: workspacePollCount === 1 ? 'creating' : 'ready',
                sourceType: 'checkpoint',
                checkpointId: '8a513f56ed70',
                commitSha: 'd'.repeat(40),
                sourceRef: null,
                sourceProjectRoot: '.',
                sourceBundleKey: 'bundle',
                sourceBundleSha256: 'f'.repeat(64),
                sourceBundleBytes: 123,
                sandboxId: 'workspace-ws_in_progress',
                baselineReady: true,
                errorCode: null,
                errorMessage: null,
                createdAt: '2026-03-11T00:00:00.000Z',
                updatedAt: '2026-03-11T00:00:00.000Z',
                deletedAt: null,
                eventsUrl: '/api/workspaces/ws_in_progress/events',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
          }
          throw new Error(`Unexpected request in in-progress workspace test: ${url}`);
        }) as typeof fetch;

        setReviewPreflightContextResolverForTests(async () => ({
          note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
          sessionIds: ['sess_in_progress'],
          transcriptUrl: null,
          intentSessionContext: ['Constraint: Keep scope narrow.'],
        }));
        setReviewCommitResolverForTests(() => ({
          commitSha: 'd'.repeat(40),
          checkpointId: '8a513f56ed70',
          commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
        }));
        setReviewCreateFlowForTests({
          resolveWorkspaceSource: () => ({
            commitSha: 'd'.repeat(40),
            checkpointId: '8a513f56ed70',
            sourceRef: null,
            projectRoot: '.',
          }),
          createWorkspace: async () => {
            throw new WorkspaceCreateInProgressError('ws_in_progress');
          },
          deployWorkspace: async (workspaceId) => {
            deployedWorkspaceId = workspaceId;
            return {
              id: 'dep_in_progress',
              workspaceId,
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
          createReview: async () => ({
            reviewId: 'rev_in_progress',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_in_progress/events',
            resultUrl: '/reviews/rev_in_progress',
          }),
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async () => createReviewResponseBody() as unknown as { review: any },
        });

        await createReviewFromCommitCommand({ commitish: 'HEAD', pollIntervalMs: 10 });
        assert.equal(workspacePollCount >= 2, true);
        assert.equal(deployedWorkspaceId, 'ws_in_progress');
      } finally {
        globalThis.fetch = originalFetch;
        console.log = originalConsoleLog;
        setReviewCommitResolverForTests(null);
        setReviewPreflightContextResolverForTests(null);
        setReviewCreateFlowForTests(null);
      }
    }

    {
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
        sessionIds: ['sess_failed'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewPreflightTokenReadinessResolverForTests(async () => true);
      setReviewCommitResolverForTests(() => ({
        commitSha: 'e'.repeat(40),
        checkpointId: '8a513f56ed70',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: 'e'.repeat(40),
          checkpointId: '8a513f56ed70',
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => ({
          workspace: {
            id: 'ws_failed',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: '8a513f56ed70',
            commitSha: 'e'.repeat(40),
            sourceRef: null,
            sourceProjectRoot: '.',
            sourceBundleKey: 'bundle',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 123,
            sandboxId: 'workspace-ws_failed',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_failed/events',
          },
        }),
        deployWorkspace: async () => ({
          id: 'dep_failed',
          workspaceId: 'ws_failed',
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
        createReview: async () => ({
          reviewId: 'rev_failed',
          status: 'queued',
          eventsUrl: '/api/reviews/rev_failed/events',
          resultUrl: '/reviews/rev_failed',
        }),
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({
            id: '1',
            data: {
              type: 'review_context_cochange_failed',
              reason: 'cache_error',
              githubResponseBody: 'D1_ERROR: too many SQL variables',
            },
          });
          await onEvent({ id: '2', data: { type: 'terminal', status: 'failed' } });
        },
        getReview: async () => ({
          review: {
            ...createReviewResponseBody().review,
            status: 'failed',
            error: {
              code: 'review_context_cache_error',
              message: 'Co-change context cache read/write failed (cache_error).',
            },
          },
        }) as unknown as { review: any },
      });

      await assert.rejects(
        () => createReviewFromCommitCommand({ commitish: 'HEAD' }),
        /review_context_cache_error: Co-change context cache read\/write failed \(cache_error\).*event=review_context_cochange_failed.*reason=cache_error.*details=D1_ERROR: too many SQL variables/
      );
      setReviewCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewPreflightTokenReadinessResolverForTests(async () => true);
      setReviewCreateFlowForTests(null);
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
      let capturedProvenance: Record<string, unknown> | null = null;
      process.env.REVIEW_CONTEXT_GITHUB_TOKEN = '';
      setReviewPreflightTokenReadinessResolverForTests(async () => false);
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
        sessionIds: ['sess_local_cochange'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewCommitResolverForTests(() => ({
        commitSha: 'a'.repeat(40),
        checkpointId: '8a513f56ed70',
        commitDiffPatch:
          'diff --git a/src/app.ts b/src/app.ts\nindex 111..222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: 'a'.repeat(40),
          checkpointId: '8a513f56ed70',
          sourceRef: null,
          projectRoot: '.',
        }),
        resolveLocalCochange: () => ({
          source: 'local_git',
          checkpointsRef: 'refs/remotes/origin/entire/checkpoints/v1',
          lookbackSessions: 5,
          topN: 20,
          sessionsScanned: 2,
          relatedByChangedPath: {
            'src/app.ts': [{ path: 'src/config.ts', frequency: 2, sessionIds: ['ses_1', 'ses_2'] }],
          },
        }),
        createWorkspace: async () => ({
          workspace: {
            id: 'ws_local_cochange',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: '8a513f56ed70',
            commitSha: 'a'.repeat(40),
            sourceRef: null,
            sourceProjectRoot: '.',
            sourceBundleKey: 'bundle',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 123,
            sandboxId: 'workspace-ws_local_cochange',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_local_cochange/events',
          },
        }),
        deployWorkspace: async () => ({
          id: 'dep_local_cochange',
          workspaceId: 'ws_local_cochange',
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
            reviewId: 'rev_local_cochange',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_local_cochange/events',
            resultUrl: '/reviews/rev_local_cochange',
          };
        },
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => createReviewResponseBody() as unknown as { review: any },
      });

      await createReviewFromCommitCommand({ commitish: 'HEAD' });
      const localCochange = (capturedProvenance?.['localCochange'] ?? null) as
        | {
            source: string;
            lookbackSessions: number;
            sessionsScanned: number;
            relatedByChangedPath: Record<string, Array<{ path: string; frequency: number; sessionIds: string[] }>>;
          }
        | null;
      assert.equal(localCochange?.source, 'local_git');
      assert.equal(localCochange?.lookbackSessions, 5);
      assert.equal(localCochange?.sessionsScanned, 2);
      assert.deepEqual(localCochange?.relatedByChangedPath['src/app.ts']?.[0]?.path, 'src/config.ts');

      setReviewCommitResolverForTests(null);
      setReviewPreflightContextResolverForTests(null);
      setReviewCreateFlowForTests(null);
      setReviewPreflightTokenReadinessResolverForTests(async () => true);
    }

    {
      const streamedReviewIds: string[] = [];
      let sessionReads = 0;
      setReviewPreflightContextResolverForTests(async () => ({
        note: 'Review with Entire checkpoint intent context (8a513f56ed70).',
        sessionIds: ['sess_chain_missing'],
        transcriptUrl: null,
        intentSessionContext: ['Constraint: Keep scope narrow.'],
      }));
      setReviewCommitResolverForTests(() => ({
        commitSha: '1'.repeat(40),
        checkpointId: '8a513f56ed70',
        commitDiffPatch: 'diff --git a/file b/file\nindex 111..222 100644\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n',
      }));
      setReviewCreateFlowForTests({
        resolveWorkspaceSource: () => ({
          commitSha: '1'.repeat(40),
          checkpointId: '8a513f56ed70',
          sourceRef: null,
          projectRoot: '.',
        }),
        createWorkspace: async () => ({
          workspace: {
            id: 'ws_chain_missing',
            status: 'ready',
            sourceType: 'checkpoint',
            checkpointId: '8a513f56ed70',
            commitSha: '1'.repeat(40),
            sourceRef: null,
            sourceProjectRoot: '.',
            sourceBundleKey: 'bundle',
            sourceBundleSha256: 'f'.repeat(64),
            sourceBundleBytes: 123,
            sandboxId: 'workspace-ws_chain_missing',
            baselineReady: true,
            errorCode: null,
            errorMessage: null,
            createdAt: '2026-03-11T00:00:00.000Z',
            updatedAt: '2026-03-11T00:00:00.000Z',
            deletedAt: null,
            eventsUrl: '/api/workspaces/ws_chain_missing/events',
          },
        }),
        deployWorkspace: async () => ({
          id: 'dep_chain_missing',
          workspaceId: 'ws_chain_missing',
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
        createReview: async () => ({
          reviewId: 'rev_chain_missing_1',
          status: 'queued',
          eventsUrl: '/api/reviews/rev_chain_missing_1/events',
          resultUrl: '/api/reviews/rev_chain_missing_1',
        }),
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_chain_missing',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_chain_missing_2' ? 'environment' : 'checkpoint',
          },
          session:
            reviewId === 'rev_chain_missing_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_chain_missing_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_chain_missing_1',
                  activeReviewId: 'rev_chain_missing_1',
                  passCount: 1,
                  stopReason: null,
                  finishedAt: null,
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads === 1
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_chain_missing_2',
                    activeReviewId: 'rev_chain_missing_2',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_chain_missing_2',
                        status: 'queued',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_chain_missing_2',
                    activeReviewId: null,
                    passCount: 2,
                    stopReason: 'followup_pass_completed',
                    finishedAt: '2026-03-11T00:03:00.000Z',
                  },
          } as any;
        },
      });

      await createReviewFromCommitCommand({ commitish: 'HEAD', pollIntervalMs: 1 });
      assert.deepEqual(streamedReviewIds, ['rev_chain_missing_1', 'rev_chain_missing_2']);
      assert.equal(sessionReads >= 1, true);

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
          repo?: string;
          branch?: string;
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
      assert.equal(typeof requestBody.provenance?.repo, 'string');
      assert.equal(Boolean(requestBody.provenance?.repo?.trim()), true);
      assert.equal(typeof requestBody.provenance?.branch, 'string');
      assert.equal(Boolean(requestBody.provenance?.branch?.trim()), true);
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
        /REVIEW_CONTEXT_GITHUB_TOKEN is required for GitHub co-change retrieval when local co-change context is unavailable/
      );
      assert.equal(fetchCount, 0);
      setReviewPreflightTokenReadinessResolverForTests(async () => true);
    }

    {
      let fetchCount = 0;
      const lines: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      };
      globalThis.fetch = (async (): Promise<Response> => {
        fetchCount += 1;
        return new Response(JSON.stringify(createReviewResponseBody()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      try {
        await showReviewCommand('rev_abcd1234');
        assert.equal(fetchCount, 1);
        assert.equal(lines.some((line) => line.includes('Session ID:      session_abcd1234')), true);
        assert.equal(lines.some((line) => line.includes('Basis:           checkpoint')), true);
        assert.equal(lines.some((line) => line.includes('Session Phase:   completed')), true);
        assert.equal(lines.some((line) => line.includes('Session Passes:  1')), true);
        assert.equal(lines.some((line) => line.includes('Session Outcome:')), true);
        assert.equal(lines.some((line) => line.includes('Outcome:') && line.includes('clean')), true);
        assert.equal(lines.some((line) => line.includes('Evidence:') && line.includes('1 passed check')), true);
      } finally {
        console.log = originalConsoleLog;
      }
    }

    {
      const lines: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      };
      globalThis.fetch = (async (): Promise<Response> => {
        const body = createReviewResponseBody() as any;
        body.review.reviewBasis = 'environment';
        body.review.provenance.environmentRevision = {
          source: 'workspace_head',
          diffSha256: 'b'.repeat(64),
          changedFileCount: 2,
          generatedAt: '2026-03-11T00:02:00.000Z',
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      try {
        await showReviewCommand('rev_env1234');
        assert.equal(lines.some((line) => line.includes('Basis:           environment')), true);
        assert.equal(lines.some((line) => line.includes('Env Revision:    bbbbbbbbbbbb (2 changed files)')), true);
      } finally {
        console.log = originalConsoleLog;
      }
    }

    {
      const lines: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      };
      globalThis.fetch = (async (): Promise<Response> => {
        const body = {
          session: {
            ...createReviewResponseBody().session,
            passCount: 2,
            latestReviewId: 'rev_env1234',
            currentReviewStatus: 'succeeded',
            stopReason: 'followup_pass_completed',
            passes: [
              ...createReviewResponseBody().session.passes,
              {
                reviewId: 'rev_env1234',
                status: 'succeeded',
                reviewBasis: 'environment',
                environmentRevision: {
                  source: 'workspace_head',
                  diffSha256: 'b'.repeat(64),
                  changedFileCount: 2,
                  generatedAt: '2026-03-11T00:02:00.000Z',
                },
                createdAt: '2026-03-11T00:02:00.000Z',
                startedAt: '2026-03-11T00:02:10.000Z',
                finishedAt: '2026-03-11T00:03:00.000Z',
              },
            ],
          },
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      try {
        await showReviewSessionCommand('session_abcd1234');
        assert.equal(lines.some((line) => line.includes('Pass Count:      2')), true);
        assert.equal(lines.some((line) => line.includes('Session Outcome:')), true);
        assert.equal(lines.some((line) => line.includes('Summary:') && line.includes('no actionable findings remain')), true);
        assert.equal(lines.some((line) => line.includes('2. rev_env1234 succeeded environment')), true);
        assert.equal(lines.some((line) => line.includes('env bbbbbbbbbbbb (2 changed files)')), true);
      } finally {
        console.log = originalConsoleLog;
      }
    }

    {
      const lines: string[] = [];
      let resetCalled = false;
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      };
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/review-sessions/session_abcd1234') && (!init?.method || init.method === 'GET')) {
          return new Response(
            JSON.stringify({
              session: {
                ...createReviewResponseBody().session,
                currentReviewStatus: 'succeeded',
                activeReviewId: null,
              },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        if (url.endsWith('/api/workspaces/ws_abc12345/reset') && init?.method === 'POST') {
          resetCalled = true;
          return new Response(
            JSON.stringify({
              workspace: {
                ...createReviewResponseBody().review.target,
                id: 'ws_abc12345',
                status: 'ready',
                sourceType: 'checkpoint',
                checkpointId: '8a513f56ed70',
                commitSha: 'a'.repeat(40),
                sourceRef: 'main',
                sourceProjectRoot: '.',
                sourceBundleKey: 'bundle',
                sourceBundleSha256: 'f'.repeat(64),
                sourceBundleBytes: 123,
                sandboxId: 'workspace-ws_abc12345',
                baselineReady: true,
                errorCode: null,
                errorMessage: null,
                createdAt: '2026-03-11T00:00:00.000Z',
                updatedAt: '2026-03-11T00:05:00.000Z',
                deletedAt: null,
                eventsUrl: '/api/workspaces/ws_abc12345/events',
              },
              warning: 'post-reset cleanup warning',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }
        throw new Error(`Unhandled fetch in reset test: ${url}`);
      }) as typeof fetch;

      try {
        await resetReviewSessionCommand('session_abcd1234');
        assert.equal(resetCalled, true);
        assert.equal(lines.some((line) => line.includes('Baseline Ready:  yes')), true);
      } finally {
        console.log = originalConsoleLog;
      }
    }

    {
      globalThis.fetch = (async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            session: {
              ...createReviewResponseBody().session,
              activeReviewId: 'rev_running',
              currentReviewStatus: 'running',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }) as typeof fetch;

      await assert.rejects(
        () => resetReviewSessionCommand('session_abcd1234'),
        /Review session session_abcd1234 still has an active pass \(running\)\. Wait for it to finish before resetting\./
      );
    }

    {
      const originalCwd = process.cwd();
      const { repoRoot, anchorCommitSha, patch, patchSha256 } = await createMaterializeTestRepo();
      let sessionReads = 0;
      try {
        process.chdir(repoRoot);
        setReviewSessionMaterializeFlowForTests({
          getReviewSession: (async () => {
            sessionReads += 1;
            return {
              session:
                sessionReads === 1
                  ? {
                      ...createReviewResponseBody().session,
                      repo: 'dayhaysoos/nimbus',
                      branch: 'main',
                      anchorCommitSha,
                      anchorCheckpointId: null,
                      activeReviewId: 'rev_abcd1234',
                      currentReviewStatus: 'succeeded',
                      latestReviewId: 'rev_abcd1234',
                      stopReason: 'initial_pass_completed',
                      passCount: 1,
                    }
                  : {
                      ...createReviewResponseBody().session,
                      repo: 'dayhaysoos/nimbus',
                      branch: 'main',
                      anchorCommitSha,
                      anchorCheckpointId: null,
                      activeReviewId: 'rev_env1234',
                      currentReviewStatus: 'succeeded',
                      latestReviewId: 'rev_env1234',
                      stopReason: 'followup_pass_completed',
                      passCount: 2,
                      passes: [
                        ...createReviewResponseBody().session.passes,
                        {
                          reviewId: 'rev_env1234',
                          status: 'succeeded',
                          reviewBasis: 'environment',
                          environmentRevision: {
                            source: 'workspace_head',
                            diffSha256: patchSha256,
                            changedFileCount: 1,
                            generatedAt: '2026-03-11T00:02:00.000Z',
                          },
                          createdAt: '2026-03-11T00:02:00.000Z',
                          startedAt: '2026-03-11T00:02:10.000Z',
                          finishedAt: '2026-03-11T00:03:00.000Z',
                        },
                      ],
                    },
            };
          }) as any,
          createWorkspacePatchExport: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'queued',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:10.000Z',
            },
          }),
          getWorkspaceOperation: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'succeeded',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:11.000Z',
              result: { artifactId: 'artifact_patch_1' },
            },
          }),
          listWorkspaceArtifacts: async () => ({
            artifacts: [
              {
                id: 'artifact_patch_1',
                type: 'patch',
                status: 'available',
                bytes: Buffer.byteLength(patch, 'utf8'),
                contentType: 'text/x-diff',
                sha256: patchSha256,
                workspaceId: 'ws_abc12345',
                sourceBaselineSha: anchorCommitSha,
                creatorId: null,
                createdAt: '2026-03-11T00:03:11.000Z',
                expiresAt: '2026-03-18T00:03:11.000Z',
                warnings: [],
                metadata: {},
                download: null,
              },
            ],
          }),
          downloadWorkspaceArtifact: async () => new TextEncoder().encode(patch),
        });

        const result = await materializeReviewSessionCommand('session_abcd1234');
        assert.equal(sessionReads >= 2, true);
        assert.equal(existsSync(result.worktreePath), true);
        assert.equal(result.branchName, 'nimbus/session/session_abcd1234');
        assert.equal(result.worktreePath.startsWith(repoRoot), false);
        assert.equal((await readFile(join(result.worktreePath, 'math.js'), 'utf8')).includes('return a + b;'), true);
        assert.equal((await readFile(join(repoRoot, 'math.js'), 'utf8')).includes('return a - b;'), true);
        assert.equal(runGitForTest(repoRoot, ['status', '--short']).trim(), '');
        assert.equal(runGitForTest(result.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), result.branchName);
        assert.equal(runGitForTest(result.worktreePath, ['show', '-s', '--format=%s', 'HEAD']).trim(), 'Apply Nimbus session session_abcd1234');
      } finally {
        setReviewSessionMaterializeFlowForTests(null);
        process.chdir(originalCwd);
        await rm(repoRoot, { recursive: true, force: true });
      }
    }

    {
      const originalCwd = process.cwd();
      const { repoRoot, anchorCommitSha, patch, patchSha256 } = await createMaterializeTestRepo();
      let receivedDownloadUrl: string | null = null;
      try {
        process.chdir(repoRoot);
        setReviewSessionMaterializeFlowForTests({
          getReviewSession: async () => ({
            session: {
              ...createReviewResponseBody().session,
              repo: 'dayhaysoos/nimbus',
              branch: 'main',
              anchorCommitSha,
              anchorCheckpointId: null,
              activeReviewId: 'rev_env1234',
              currentReviewStatus: 'succeeded',
              latestReviewId: 'rev_env1234',
              stopReason: 'followup_pass_completed',
              passCount: 2,
              passes: [
                ...createReviewResponseBody().session.passes,
                {
                  reviewId: 'rev_env1234',
                  status: 'succeeded',
                  reviewBasis: 'environment',
                  environmentRevision: {
                    source: 'workspace_head',
                    diffSha256: patchSha256,
                    changedFileCount: 1,
                    generatedAt: '2026-03-11T00:02:00.000Z',
                  },
                  createdAt: '2026-03-11T00:02:00.000Z',
                  startedAt: '2026-03-11T00:02:10.000Z',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                },
              ],
            },
          }) as any,
          createWorkspacePatchExport: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'queued',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:10.000Z',
            },
          }),
          getWorkspaceOperation: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'succeeded',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:11.000Z',
              result: { artifactId: 'artifact_patch_1' },
            },
          }),
          listWorkspaceArtifacts: async () => ({
            artifacts: [
              {
                id: 'artifact_patch_1',
                type: 'patch',
                status: 'available',
                bytes: Buffer.byteLength(patch, 'utf8'),
                contentType: 'text/x-diff',
                sha256: patchSha256,
                workspaceId: 'ws_abc12345',
                sourceBaselineSha: anchorCommitSha,
                creatorId: null,
                createdAt: '2026-03-11T00:03:11.000Z',
                expiresAt: '2026-03-18T00:03:11.000Z',
                warnings: [],
                metadata: {},
                download: {
                  url: '/api/workspaces/ws_abc12345/artifacts/artifact_patch_1/download?exp=123&sig=abc',
                  expiresAt: '2026-03-18T00:03:11.000Z',
                },
              },
            ],
          }),
          downloadWorkspaceArtifact: async (_workerUrl, _workspaceId, _artifactId, downloadUrl) => {
            receivedDownloadUrl = typeof downloadUrl === 'string' ? downloadUrl : null;
            return new TextEncoder().encode(patch);
          },
        });

        const result = await materializeReviewSessionCommand('session_abcd1234');
        assert.equal(result.artifactId, 'artifact_patch_1');
        assert.equal(receivedDownloadUrl, '/api/workspaces/ws_abc12345/artifacts/artifact_patch_1/download?exp=123&sig=abc');
      } finally {
        setReviewSessionMaterializeFlowForTests(null);
        process.chdir(originalCwd);
        await rm(repoRoot, { recursive: true, force: true });
      }
    }

    {
      const originalCwd = process.cwd();
      const { repoRoot, anchorCommitSha, patch, patchSha256 } = await createMaterializeTestRepo();
      let sessionReads = 0;
      try {
        process.chdir(repoRoot);
        setReviewSessionMaterializeFlowForTests({
          getReviewSession: async () => {
            sessionReads += 1;
            if (sessionReads === 2) {
              throw new Error('temporary network error');
            }
            return {
              session:
                sessionReads === 1
                  ? {
                      ...createReviewResponseBody().session,
                      repo: 'dayhaysoos/nimbus',
                      branch: 'main',
                      anchorCommitSha,
                      anchorCheckpointId: null,
                      activeReviewId: null,
                      currentReviewStatus: 'succeeded',
                      latestReviewId: 'rev_env1234',
                      stopReason: 'initial_pass_completed',
                      passCount: 1,
                      phase: 'completed',
                      finishedAt: '2026-03-11T00:01:00.000Z',
                    }
                  : {
                      ...createReviewResponseBody().session,
                      repo: 'dayhaysoos/nimbus',
                      branch: 'main',
                      anchorCommitSha,
                      anchorCheckpointId: null,
                      activeReviewId: 'rev_env1234',
                      currentReviewStatus: 'succeeded',
                      latestReviewId: 'rev_env1234',
                      stopReason: 'followup_pass_completed',
                      passCount: 2,
                      phase: 'completed',
                      finishedAt: '2026-03-11T00:03:00.000Z',
                      passes: [
                        ...createReviewResponseBody().session.passes,
                        {
                          reviewId: 'rev_env1234',
                          status: 'succeeded',
                          reviewBasis: 'environment',
                          environmentRevision: {
                            source: 'workspace_head',
                            diffSha256: patchSha256,
                            changedFileCount: 1,
                            generatedAt: '2026-03-11T00:02:00.000Z',
                          },
                          createdAt: '2026-03-11T00:02:00.000Z',
                          startedAt: '2026-03-11T00:02:10.000Z',
                          finishedAt: '2026-03-11T00:03:00.000Z',
                        },
                      ],
                    },
            } as any;
          },
          createWorkspacePatchExport: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'queued',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:10.000Z',
            },
          }),
          getWorkspaceOperation: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'succeeded',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:11.000Z',
              result: { artifactId: 'artifact_patch_1' },
            },
          }),
          listWorkspaceArtifacts: async () => ({
            artifacts: [
              {
                id: 'artifact_patch_1',
                type: 'patch',
                status: 'available',
                bytes: Buffer.byteLength(patch, 'utf8'),
                contentType: 'text/x-diff',
                sha256: patchSha256,
                workspaceId: 'ws_abc12345',
                sourceBaselineSha: anchorCommitSha,
                creatorId: null,
                createdAt: '2026-03-11T00:03:11.000Z',
                expiresAt: '2026-03-18T00:03:11.000Z',
                warnings: [],
                metadata: {},
                download: null,
              },
            ],
          }),
          downloadWorkspaceArtifact: async () => new TextEncoder().encode(patch),
        });

        const result = await materializeReviewSessionCommand('session_abcd1234', { pollIntervalMs: 1 });
        assert.equal(sessionReads >= 3, true);
        assert.equal(existsSync(result.worktreePath), true);
      } finally {
        setReviewSessionMaterializeFlowForTests(null);
        process.chdir(originalCwd);
        await rm(repoRoot, { recursive: true, force: true });
      }
    }

    {
      const originalCwd = process.cwd();
      const { repoRoot, anchorCommitSha } = await createMaterializeTestRepo();
      const invalidPatch = 'this is not a valid patch\n';
      const invalidPatchSha = createHash('sha256').update(invalidPatch).digest('hex');
      const failPath = join(repoRoot, 'materialize-fail-worktree');
      try {
        process.chdir(repoRoot);
        setReviewSessionMaterializeFlowForTests({
          getReviewSession: async () => ({
            session: {
              ...createReviewResponseBody().session,
              repo: 'dayhaysoos/nimbus',
              branch: 'main',
              anchorCommitSha,
              anchorCheckpointId: null,
              activeReviewId: 'rev_env1234',
              currentReviewStatus: 'succeeded',
              latestReviewId: 'rev_env1234',
              stopReason: 'followup_pass_completed',
              passCount: 2,
              phase: 'completed',
              finishedAt: '2026-03-11T00:03:00.000Z',
              passes: [
                ...createReviewResponseBody().session.passes,
                {
                  reviewId: 'rev_env1234',
                  status: 'succeeded',
                  reviewBasis: 'environment',
                  environmentRevision: {
                    source: 'workspace_head',
                    diffSha256: invalidPatchSha,
                    changedFileCount: 1,
                    generatedAt: '2026-03-11T00:02:00.000Z',
                  },
                  createdAt: '2026-03-11T00:02:00.000Z',
                  startedAt: '2026-03-11T00:02:10.000Z',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                },
              ],
            },
          }) as any,
          createWorkspacePatchExport: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'queued',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:10.000Z',
            },
          }),
          getWorkspaceOperation: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'succeeded',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:11.000Z',
              result: { artifactId: 'artifact_patch_1' },
            },
          }),
          listWorkspaceArtifacts: async () => ({
            artifacts: [
              {
                id: 'artifact_patch_1',
                type: 'patch',
                status: 'available',
                bytes: Buffer.byteLength(invalidPatch, 'utf8'),
                contentType: 'text/x-diff',
                sha256: invalidPatchSha,
                workspaceId: 'ws_abc12345',
                sourceBaselineSha: anchorCommitSha,
                creatorId: null,
                createdAt: '2026-03-11T00:03:11.000Z',
                expiresAt: '2026-03-18T00:03:11.000Z',
                warnings: [],
                metadata: {},
                download: null,
              },
            ],
          }),
          downloadWorkspaceArtifact: async () => new TextEncoder().encode(invalidPatch),
        });

        await assert.rejects(
          () => materializeReviewSessionCommand('session_abcd1234', { path: failPath }),
          /failed to materialize the Nimbus patch/
        );
        assert.equal(existsSync(failPath), false);
        assert.equal(runGitForTest(repoRoot, ['branch', '--list', 'nimbus/session/session_abcd1234']).trim(), '');
      } finally {
        setReviewSessionMaterializeFlowForTests(null);
        process.chdir(originalCwd);
        await rm(repoRoot, { recursive: true, force: true });
      }
    }

    {
      const originalCwd = process.cwd();
      const originalTmpDir = process.env.TMPDIR;
      const { repoRoot, anchorCommitSha, patch, patchSha256 } = await createMaterializeTestRepo();
      const failPath = join(repoRoot, 'materialize-fail-write-worktree');
      const invalidTmpDir = join(repoRoot, 'not-a-directory');
      try {
        process.chdir(repoRoot);
        await writeFile(invalidTmpDir, 'not a directory', 'utf8');
        process.env.TMPDIR = invalidTmpDir;
        setReviewSessionMaterializeFlowForTests({
          getReviewSession: async () => ({
            session: {
              ...createReviewResponseBody().session,
              repo: 'dayhaysoos/nimbus',
              branch: 'main',
              anchorCommitSha,
              anchorCheckpointId: null,
              activeReviewId: 'rev_env1234',
              currentReviewStatus: 'succeeded',
              latestReviewId: 'rev_env1234',
              stopReason: 'followup_pass_completed',
              passCount: 2,
              phase: 'completed',
              finishedAt: '2026-03-11T00:03:00.000Z',
              passes: [
                ...createReviewResponseBody().session.passes,
                {
                  reviewId: 'rev_env1234',
                  status: 'succeeded',
                  reviewBasis: 'environment',
                  environmentRevision: {
                    source: 'workspace_head',
                    diffSha256: patchSha256,
                    changedFileCount: 1,
                    generatedAt: '2026-03-11T00:02:00.000Z',
                  },
                  createdAt: '2026-03-11T00:02:00.000Z',
                  startedAt: '2026-03-11T00:02:10.000Z',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                },
              ],
            },
          }) as any,
          createWorkspacePatchExport: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'queued',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:10.000Z',
            },
          }),
          getWorkspaceOperation: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'succeeded',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:11.000Z',
              result: { artifactId: 'artifact_patch_1' },
            },
          }),
          listWorkspaceArtifacts: async () => ({
            artifacts: [
              {
                id: 'artifact_patch_1',
                type: 'patch',
                status: 'available',
                bytes: Buffer.byteLength(patch, 'utf8'),
                contentType: 'text/x-diff',
                sha256: patchSha256,
                workspaceId: 'ws_abc12345',
                sourceBaselineSha: anchorCommitSha,
                creatorId: null,
                createdAt: '2026-03-11T00:03:11.000Z',
                expiresAt: '2026-03-18T00:03:11.000Z',
                warnings: [],
                metadata: {},
                download: null,
              },
            ],
          }),
          downloadWorkspaceArtifact: async () => new TextEncoder().encode(patch),
        });

        await assert.rejects(
          () => materializeReviewSessionCommand('session_abcd1234', { path: failPath }),
          /failed to materialize the Nimbus patch/
        );
        assert.equal(existsSync(failPath), false);
        assert.equal(runGitForTest(repoRoot, ['branch', '--list', 'nimbus/session/session_abcd1234']).trim(), '');
      } finally {
        process.env.TMPDIR = originalTmpDir;
        setReviewSessionMaterializeFlowForTests(null);
        process.chdir(originalCwd);
        await rm(repoRoot, { recursive: true, force: true });
      }
    }

    {
      const originalCwd = process.cwd();
      const { repoRoot, anchorCommitSha, patch } = await createMaterializeTestRepo();
      try {
        process.chdir(repoRoot);
        setReviewSessionMaterializeFlowForTests({
          getReviewSession: async () => ({
            session: {
              ...createReviewResponseBody().session,
              repo: 'dayhaysoos/nimbus',
              branch: 'main',
              anchorCommitSha,
              anchorCheckpointId: null,
              activeReviewId: 'rev_env1234',
              currentReviewStatus: 'succeeded',
              latestReviewId: 'rev_env1234',
              stopReason: 'followup_pass_completed',
              passCount: 2,
              passes: [
                ...createReviewResponseBody().session.passes,
                {
                  reviewId: 'rev_env1234',
                  status: 'succeeded',
                  reviewBasis: 'environment',
                  environmentRevision: {
                    source: 'workspace_head',
                    diffSha256: 'f'.repeat(64),
                    changedFileCount: 1,
                    generatedAt: '2026-03-11T00:02:00.000Z',
                  },
                  createdAt: '2026-03-11T00:02:00.000Z',
                  startedAt: '2026-03-11T00:02:10.000Z',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                },
              ],
            },
          }) as any,
          createWorkspacePatchExport: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'queued',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:10.000Z',
            },
          }),
          getWorkspaceOperation: async () => ({
            operation: {
              id: 'op_patch_export',
              type: 'export_patch',
              status: 'succeeded',
              workspaceId: 'ws_abc12345',
              idempotencyKey: 'idem-export',
              createdAt: '2026-03-11T00:03:10.000Z',
              updatedAt: '2026-03-11T00:03:11.000Z',
              result: { artifactId: 'artifact_patch_1' },
            },
          }),
          listWorkspaceArtifacts: async () => ({
            artifacts: [
              {
                id: 'artifact_patch_1',
                type: 'patch',
                status: 'available',
                bytes: Buffer.byteLength(patch, 'utf8'),
                contentType: 'text/x-diff',
                sha256: createHash('sha256').update(patch).digest('hex'),
                workspaceId: 'ws_abc12345',
                sourceBaselineSha: anchorCommitSha,
                creatorId: null,
                createdAt: '2026-03-11T00:03:11.000Z',
                expiresAt: '2026-03-18T00:03:11.000Z',
                warnings: [],
                metadata: {},
                download: null,
              },
            ],
          }),
          downloadWorkspaceArtifact: async () => new TextEncoder().encode(patch),
        });

        await assert.rejects(
          () => materializeReviewSessionCommand('session_abcd1234'),
          /Workspace diff no longer matches the latest reviewed session state/
        );
      } finally {
        setReviewSessionMaterializeFlowForTests(null);
        process.chdir(originalCwd);
        await rm(repoRoot, { recursive: true, force: true });
      }
    }

    {
      const lines: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      };
      setReviewSessionCreateFlowForTests({
        createReviewSessionPass: async () => ({
          reviewId: 'rev_env1234',
          sessionId: 'session_abcd1234',
          status: 'queued',
          eventsUrl: '/api/reviews/rev_env1234/events',
          resultUrl: '/api/reviews/rev_env1234',
          sessionUrl: '/api/review-sessions/session_abcd1234',
        }) as any,
        getReview: async () => ({
          review: {
            ...createReviewResponseBody().review,
            id: 'rev_env1234',
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: 'environment',
            provenance: {
              ...createReviewResponseBody().review.provenance,
              environmentRevision: {
                source: 'workspace_head',
                diffSha256: 'a'.repeat(64),
                changedFileCount: 0,
                generatedAt: '2026-03-11T00:02:00.000Z',
              },
            },
          },
          session: {
            ...createReviewResponseBody().session,
            passCount: 2,
            latestReviewId: 'rev_env1234',
            activeReviewId: 'rev_env1234',
            stopReason: 'followup_pass_completed',
            passes: [
              ...createReviewResponseBody().session.passes,
              {
                reviewId: 'rev_env1234',
                status: 'succeeded',
                reviewBasis: 'environment',
                createdAt: '2026-03-11T00:02:00.000Z',
                startedAt: '2026-03-11T00:02:10.000Z',
                finishedAt: '2026-03-11T00:03:00.000Z',
              },
            ],
          },
        }) as any,
        getReviewSession: async () => ({
          session: createReviewResponseBody().session,
        }) as any,
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
      });
      try {
        await assert.doesNotReject(() => createReviewSessionCommand('session_abcd1234'));
        assert.equal(lines.some((line) => line.includes('Session Outcome:')), true);
        assert.equal(lines.some((line) => line.includes('Outcome:') && line.includes('clean')), true);
        assert.equal(lines.some((line) => line.includes('Report URL:')), true);
      } finally {
        console.log = originalConsoleLog;
        setReviewSessionCreateFlowForTests(null);
      }
    }

    {
      const lines: string[] = [];
      const originalConsoleLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      };
      const streamedReviewIds: string[] = [];
      setReviewSessionCreateFlowForTests({
        createReviewSessionPass: async () => ({
          reviewId: 'rev_env_chain_1',
          sessionId: 'session_abcd1234',
          status: 'queued',
          eventsUrl: '/api/reviews/rev_env_chain_1/events',
          resultUrl: '/api/reviews/rev_env_chain_1',
          sessionUrl: '/api/review-sessions/session_abcd1234',
        }) as any,
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: 'environment',
          },
          session: {
            ...createReviewResponseBody().session,
            latestReviewId: reviewId,
            activeReviewId: reviewId,
            passCount: reviewId === 'rev_env_chain_2' ? 3 : 2,
            stopReason: 'followup_pass_completed',
          },
        }) as any,
        getReviewSession: async () => ({
          session: {
            ...createReviewResponseBody().session,
            latestReviewId: 'rev_env_chain_2',
            activeReviewId: 'rev_env_chain_2',
            passCount: 3,
            stopReason: 'followup_pass_completed',
          },
        }) as any,
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          if (reviewId === 'rev_env_chain_1') {
            await onEvent({ id: '1', data: { type: 'review_auto_remediation_completed', nextReviewId: 'rev_env_chain_2' } });
            await onEvent({ id: '2', data: { type: 'terminal', status: 'succeeded' } });
            return;
          }
          await onEvent({ id: '3', data: { type: 'terminal', status: 'succeeded' } });
        },
      });
      try {
        await assert.doesNotReject(() => createReviewSessionCommand('session_abcd1234'));
        assert.deepEqual(streamedReviewIds, ['rev_env_chain_1', 'rev_env_chain_2']);
        assert.equal(lines.some((line) => line.includes('Session Outcome:')), true);
        assert.equal(lines.some((line) => line.includes('Report URL: https://worker.example.com/api/reviews/rev_env_chain_2')), true);
      } finally {
        console.log = originalConsoleLog;
        setReviewSessionCreateFlowForTests(null);
      }
    }

    {
      const streamedReviewIds: string[] = [];
      let sessionReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_env_delayed_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_env_delayed_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_env_delayed_2' ? 'environment' : 'checkpoint',
          },
          session:
            reviewId === 'rev_env_delayed_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_env_delayed_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                  passes: [
                    ...createReviewResponseBody().session.passes,
                    {
                      reviewId: 'rev_env_delayed_2',
                      status: 'succeeded',
                      reviewBasis: 'environment',
                      createdAt: '2026-03-11T00:02:00.000Z',
                      startedAt: '2026-03-11T00:02:10.000Z',
                      finishedAt: '2026-03-11T00:03:00.000Z',
                    },
                  ],
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_env_delayed_1',
                  activeReviewId: 'rev_env_delayed_1',
                  passCount: 1,
                  stopReason: null,
                  finishedAt: null,
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads === 1
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_env_delayed_1',
                    activeReviewId: 'rev_env_delayed_1',
                    passCount: 1,
                    stopReason: null,
                    finishedAt: null,
                  }
                : sessionReads === 2
                  ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_env_delayed_2',
                    activeReviewId: 'rev_env_delayed_2',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_env_delayed_2',
                        status: 'queued',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  }
                  : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_env_delayed_2',
                    activeReviewId: null,
                    passCount: 2,
                    stopReason: 'followup_pass_completed',
                    finishedAt: '2026-03-11T00:03:00.000Z',
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_env_delayed_2',
                        status: 'succeeded',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: '2026-03-11T00:02:10.000Z',
                        finishedAt: '2026-03-11T00:03:00.000Z',
                      },
                    ],
                  },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1000,
      });
      assert.deepEqual(streamedReviewIds, ['rev_env_delayed_1', 'rev_env_delayed_2']);
      assert.equal(sessionReads >= 2, true);
      assert.equal(final.finalReviewId, 'rev_env_delayed_2');
      assert.equal(final.finalResultUrl, 'https://worker.example.com/api/reviews/rev_env_delayed_2');
    }

    {
      const streamedReviewIds: string[] = [];
      let sessionReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_env_settling_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_env_settling_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_env_settling_2' ? 'environment' : 'checkpoint',
            summary:
              reviewId === 'rev_env_settling_1'
                ? {
                    riskLevel: 'high',
                    findingCounts: { critical: 0, high: 1, medium: 0, low: 0 },
                    recommendation: 'request_changes',
                  }
                : createReviewResponseBody().review.summary,
            findings:
              reviewId === 'rev_env_settling_1'
                ? [
                    {
                      id: 'finding_1',
                      severity: 'high',
                      confidence: 'high',
                      title: 'logic bug',
                      description: 'add() subtracts instead of adds.',
                      conditions: null,
                      locations: [{ path: 'math.js', line: 1 }],
                      suggestedFix: { kind: 'text', value: 'return a + b;' },
                      evidenceRefs: [],
                    },
                  ]
                : [],
            provenance:
              reviewId === 'rev_env_settling_1'
                ? {
                    ...createReviewResponseBody().review.provenance,
                    validation: {
                      followUpReviewScore: 3,
                    },
                  }
                : createReviewResponseBody().review.provenance,
          },
          session:
            reviewId === 'rev_env_settling_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_env_settling_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                  passes: [
                    ...createReviewResponseBody().session.passes,
                    {
                      reviewId: 'rev_env_settling_2',
                      status: 'succeeded',
                      reviewBasis: 'environment',
                      createdAt: '2026-03-11T00:02:00.000Z',
                      startedAt: '2026-03-11T00:02:10.000Z',
                      finishedAt: '2026-03-11T00:03:00.000Z',
                    },
                  ],
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_env_settling_1',
                  activeReviewId: null,
                  passCount: 1,
                  stopReason: 'initial_pass_completed',
                  finishedAt: '2026-03-11T00:01:00.000Z',
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads < 3
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_env_settling_1',
                    activeReviewId: null,
                    passCount: 1,
                    stopReason: 'initial_pass_completed',
                    finishedAt: '2026-03-11T00:01:00.000Z',
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_env_settling_2',
                    activeReviewId: 'rev_env_settling_2',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_env_settling_2',
                        status: 'queued',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1000,
      });
      assert.deepEqual(streamedReviewIds, ['rev_env_settling_1', 'rev_env_settling_2']);
      assert.equal(sessionReads >= 3, true);
      assert.equal(final.finalReviewId, 'rev_env_settling_2');
    }

    {
      let reviewReads = 0;
      const warnings: string[] = [];
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_stale_terminal',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_stale_terminal',
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: 'terminal-stale', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => {
          reviewReads += 1;
          return {
            review: {
              ...createReviewResponseBody().review,
              id: 'rev_stale_terminal',
              sessionId: null,
              status: reviewReads === 1 ? 'running' : 'succeeded',
              reviewBasis: 'checkpoint',
            },
            session: null,
          } as any;
        },
        formatEvent: () => '',
        onStreamWarning: (message) => warnings.push(message),
        pollIntervalMs: 1,
      });

      assert.equal(reviewReads >= 2, true);
      assert.equal(final.finalReview.review.status, 'succeeded');
      assert.equal(warnings.some((message) => message.includes('status has not settled yet')), true);
    }

    {
      let reviewReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_policy_approved_pending',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_policy_approved_pending',
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: 'terminal-policy-approved', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => {
          reviewReads += 1;
          return {
            review: {
              ...createReviewResponseBody().review,
              id: 'rev_policy_approved_pending',
              sessionId: null,
              status: reviewReads === 1 ? 'policy_approved' : 'succeeded',
              reviewBasis: 'checkpoint',
            },
            session: null,
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.equal(reviewReads >= 2, true);
      assert.equal(final.finalReview.review.status, 'succeeded');
    }

    {
      let reviewReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_policy_pending_pending',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_policy_pending_pending',
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: 'terminal-policy-pending', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => {
          reviewReads += 1;
          return {
            review: {
              ...createReviewResponseBody().review,
              id: 'rev_policy_pending_pending',
              sessionId: null,
              status: reviewReads === 1 ? 'policy_pending' : 'succeeded',
              reviewBasis: 'checkpoint',
            },
            session: null,
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.equal(reviewReads, 1);
      assert.equal(final.finalReview.review.status, 'policy_pending');
    }

    {
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_terminal_conflict',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_terminal_conflict',
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: 'terminal-conflict', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => ({
          review: {
            ...createReviewResponseBody().review,
            id: 'rev_terminal_conflict',
            sessionId: null,
            status: 'failed',
            reviewBasis: 'checkpoint',
          },
          session: null,
        }) as any,
        formatEvent: () => '',
      });

      assert.equal(final.finalReview.review.status, 'failed');
      assert.equal(final.finalReviewId, 'rev_terminal_conflict');
    }

    {
      const streamedReviewIds: string[] = [];
      let sessionReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_env_retry_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_env_retry_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_env_retry_2' ? 'environment' : 'checkpoint',
          },
          session:
            reviewId === 'rev_env_retry_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_env_retry_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                  passes: [
                    ...createReviewResponseBody().session.passes,
                    {
                      reviewId: 'rev_env_retry_2',
                      status: 'succeeded',
                      reviewBasis: 'environment',
                      createdAt: '2026-03-11T00:02:00.000Z',
                      startedAt: '2026-03-11T00:02:10.000Z',
                      finishedAt: '2026-03-11T00:03:00.000Z',
                    },
                  ],
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_env_retry_1',
                  activeReviewId: 'rev_env_retry_1',
                  passCount: 1,
                  stopReason: null,
                  finishedAt: null,
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          if (sessionReads === 1) {
            throw new Error('temporary session read failure');
          }
          return {
            session:
              sessionReads === 2
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_env_retry_2',
                    activeReviewId: 'rev_env_retry_2',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_env_retry_2',
                        status: 'queued',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_env_retry_2',
                    activeReviewId: null,
                    passCount: 2,
                    stopReason: 'followup_pass_completed',
                    finishedAt: '2026-03-11T00:03:00.000Z',
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_env_retry_2',
                        status: 'succeeded',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: '2026-03-11T00:02:10.000Z',
                        finishedAt: '2026-03-11T00:03:00.000Z',
                      },
                    ],
                  },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1000,
      });
      assert.deepEqual(streamedReviewIds, ['rev_env_retry_1', 'rev_env_retry_2']);
      assert.equal(sessionReads >= 2, true);
      assert.equal(final.finalReviewId, 'rev_env_retry_2');
    }

    {
      let sessionReads = 0;
      const streamedReviewIds: string[] = [];
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_policy_chain_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_policy_chain_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_policy_chain_2' ? 'environment' : 'checkpoint',
          },
          session:
            reviewId === 'rev_policy_chain_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_policy_chain_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_policy_chain_1',
                  activeReviewId: 'rev_policy_chain_1',
                  passCount: 1,
                  stopReason: null,
                  finishedAt: null,
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads === 1
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_policy_chain_2',
                    activeReviewId: 'rev_policy_chain_2',
                    currentReviewStatus: 'policy_pending',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_policy_chain_2',
                        status: 'policy_pending',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_policy_chain_2',
                    activeReviewId: null,
                    currentReviewStatus: 'succeeded',
                    passCount: 2,
                    stopReason: 'followup_pass_completed',
                    finishedAt: '2026-03-11T00:03:00.000Z',
                  },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.deepEqual(streamedReviewIds, ['rev_policy_chain_1', 'rev_policy_chain_2']);
      assert.equal(sessionReads >= 1, true);
      assert.equal(final.finalReviewId, 'rev_policy_chain_2');
    }

    {
      let sessionReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_settled_session',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_settled_session',
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: 'terminal', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => ({
          review: {
            ...createReviewResponseBody().review,
            id: 'rev_settled_session',
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: 'checkpoint',
          },
          session: {
            ...createReviewResponseBody().session,
            latestReviewId: 'rev_settled_session',
            activeReviewId: null,
            passCount: 1,
            stopReason: 'initial_pass_completed',
            finishedAt: '2026-03-11T00:01:00.000Z',
          },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          throw new Error('session read should not be called for settled sessions');
        },
        formatEvent: () => '',
      });

      assert.equal(final.finalReviewId, 'rev_settled_session');
      assert.equal(sessionReads, 0);
    }

    {
      let sessionReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_settled_no_summary',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_settled_no_summary',
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: 'terminal', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => ({
          review: {
            ...createReviewResponseBody().review,
            id: 'rev_settled_no_summary',
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            summary: undefined,
            findings: [],
            reviewBasis: 'checkpoint',
          },
          session: {
            ...createReviewResponseBody().session,
            latestReviewId: 'rev_settled_no_summary',
            activeReviewId: null,
            passCount: 1,
            stopReason: 'initial_pass_completed',
            finishedAt: '2026-03-11T00:01:00.000Z',
          },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          throw new Error('session read should not be called when summary is missing but no follow-up signals exist');
        },
        formatEvent: () => '',
      });

      assert.equal(final.finalReviewId, 'rev_settled_no_summary');
      assert.equal(sessionReads, 0);
    }

    {
      let sessionReads = 0;
      const streamedReviewIds: string[] = [];
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_stale_settled_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_stale_settled_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_stale_settled_2' ? 'environment' : 'checkpoint',
            findings:
              reviewId === 'rev_stale_settled_2'
                ? []
                : [
                    {
                      sequence: 1,
                      severity: 'high',
                      category: 'logic',
                      passType: 'single',
                      locations: [{ filePath: 'math.js', startLine: 1, endLine: 3 }],
                      description: 'Broken add helper',
                    },
                  ],
          },
          session:
            reviewId === 'rev_stale_settled_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_stale_settled_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                  passes: [
                    ...createReviewResponseBody().session.passes,
                    {
                      reviewId: 'rev_stale_settled_2',
                      status: 'succeeded',
                      reviewBasis: 'environment',
                      createdAt: '2026-03-11T00:02:00.000Z',
                      startedAt: '2026-03-11T00:02:10.000Z',
                      finishedAt: '2026-03-11T00:03:00.000Z',
                    },
                  ],
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_stale_settled_1',
                  activeReviewId: null,
                  passCount: 1,
                  stopReason: 'initial_pass_completed',
                  finishedAt: '2026-03-11T00:01:00.000Z',
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads === 1
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_stale_settled_2',
                    activeReviewId: 'rev_stale_settled_2',
                    currentReviewStatus: 'queued',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_stale_settled_2',
                        status: 'queued',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_stale_settled_2',
                    activeReviewId: null,
                    currentReviewStatus: 'succeeded',
                    passCount: 2,
                    stopReason: 'followup_pass_completed',
                    finishedAt: '2026-03-11T00:03:00.000Z',
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_stale_settled_2',
                        status: 'succeeded',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: '2026-03-11T00:02:10.000Z',
                        finishedAt: '2026-03-11T00:03:00.000Z',
                      },
                    ],
                  },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.deepEqual(streamedReviewIds, ['rev_stale_settled_1', 'rev_stale_settled_2']);
      assert.equal(sessionReads >= 1, true);
      assert.equal(final.finalReviewId, 'rev_stale_settled_2');
    }

    {
      let sessionReads = 0;
      const originalDateNow = Date.now;
      const baseNow = originalDateNow();
      let dateNowCalls = 0;
      Date.now = () => {
        dateNowCalls += 1;
        return dateNowCalls >= 3 ? baseNow + 31_000 : baseNow;
      };
      try {
        const final = await followReviewChain({
          workerUrl: 'https://worker.example.com',
          initialReviewId: 'rev_stale_settled_no_followup',
          initialResultUrl: 'https://worker.example.com/api/reviews/rev_stale_settled_no_followup',
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: 'terminal', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async () => ({
            review: {
              ...createReviewResponseBody().review,
              id: 'rev_stale_settled_no_followup',
              sessionId: 'session_abcd1234',
              status: 'succeeded',
              reviewBasis: 'checkpoint',
              findings: [
                {
                  sequence: 1,
                  severity: 'high',
                  category: 'logic',
                  passType: 'single',
                  locations: [{ filePath: 'math.js', startLine: 1, endLine: 3 }],
                  description: 'Broken add helper',
                },
              ],
            },
            session: {
              ...createReviewResponseBody().session,
              latestReviewId: 'rev_stale_settled_no_followup',
              activeReviewId: null,
              passCount: 1,
              stopReason: 'initial_pass_completed',
              finishedAt: '2026-03-11T00:01:00.000Z',
            },
          }) as any,
          getReviewSession: async () => {
            sessionReads += 1;
            return {
              session: {
                ...createReviewResponseBody().session,
                latestReviewId: 'rev_stale_settled_no_followup',
                activeReviewId: null,
                passCount: 1,
                stopReason: 'initial_pass_completed',
                finishedAt: '2026-03-11T00:01:00.000Z',
              },
            } as any;
          },
          formatEvent: () => '',
          pollIntervalMs: 1,
        });

        assert.equal(final.finalReviewId, 'rev_stale_settled_no_followup');
        assert.equal(sessionReads <= 2, true);
      } finally {
        Date.now = originalDateNow;
      }
    }

    {
      let sessionReads = 0;
      const warnings: string[] = [];
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_settled_probe_read_error',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_settled_probe_read_error',
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: 'terminal', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => ({
          review: {
            ...createReviewResponseBody().review,
            id: 'rev_settled_probe_read_error',
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: 'checkpoint',
            findings: [
              {
                sequence: 1,
                severity: 'high',
                category: 'logic',
                passType: 'single',
                locations: [{ filePath: 'math.js', startLine: 1, endLine: 3 }],
                description: 'Broken add helper',
              },
            ],
          },
          session: {
            ...createReviewResponseBody().session,
            latestReviewId: 'rev_settled_probe_read_error',
            activeReviewId: null,
            passCount: 1,
            stopReason: 'initial_pass_completed',
            finishedAt: '2026-03-11T00:01:00.000Z',
          },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          if (sessionReads === 1) {
            return {
              session: {
                ...createReviewResponseBody().session,
                latestReviewId: 'rev_settled_probe_read_error',
                activeReviewId: null,
                passCount: 1,
                stopReason: 'initial_pass_completed',
                finishedAt: '2026-03-11T00:01:00.000Z',
              },
            } as any;
          }
          throw new Error('session read unavailable');
        },
        formatEvent: () => '',
        onStreamWarning: (message) => warnings.push(message),
        pollIntervalMs: 1,
      });

      assert.equal(final.finalReviewId, 'rev_settled_probe_read_error');
      assert.equal(sessionReads, 3);
      assert.equal(
        warnings.some((message) =>
          message.includes('Failed to read review session state while awaiting follow-up pass: session read unavailable')
        ),
        true
      );
    }

    {
      let sessionReads = 0;
      const streamedReviewIds: string[] = [];
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_settled_probe_read_error_followup',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_settled_probe_read_error_followup',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_settled_probe_read_error_followup_2' ? 'environment' : 'checkpoint',
            findings:
              reviewId === 'rev_settled_probe_read_error_followup_2'
                ? []
                : [
                    {
                      sequence: 1,
                      severity: 'high',
                      category: 'logic',
                      passType: 'single',
                      locations: [{ filePath: 'math.js', startLine: 1, endLine: 3 }],
                      description: 'Broken add helper',
                    },
                  ],
          },
          session:
            reviewId === 'rev_settled_probe_read_error_followup_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_settled_probe_read_error_followup_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_settled_probe_read_error_followup',
                  activeReviewId: null,
                  passCount: 1,
                  stopReason: 'initial_pass_completed',
                  finishedAt: '2026-03-11T00:01:00.000Z',
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          if (sessionReads === 1) {
            return {
              session: {
                ...createReviewResponseBody().session,
                latestReviewId: 'rev_settled_probe_read_error_followup',
                activeReviewId: null,
                passCount: 1,
                stopReason: 'initial_pass_completed',
                finishedAt: '2026-03-11T00:01:00.000Z',
              },
            } as any;
          }
          if (sessionReads === 2) {
            throw new Error('transient read error after settled probe');
          }
          return {
            session: {
              ...createReviewResponseBody().session,
              latestReviewId: 'rev_settled_probe_read_error_followup_2',
              activeReviewId: 'rev_settled_probe_read_error_followup_2',
              currentReviewStatus: 'queued',
              passCount: 2,
              stopReason: null,
              finishedAt: null,
              passes: [
                ...createReviewResponseBody().session.passes,
                {
                  reviewId: 'rev_settled_probe_read_error_followup_2',
                  status: 'queued',
                  reviewBasis: 'environment',
                  createdAt: '2026-03-11T00:02:00.000Z',
                  startedAt: null,
                  finishedAt: null,
                },
              ],
            },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.deepEqual(streamedReviewIds, ['rev_settled_probe_read_error_followup', 'rev_settled_probe_read_error_followup_2']);
      assert.equal(sessionReads, 3);
      assert.equal(final.finalReviewId, 'rev_settled_probe_read_error_followup_2');
    }

    {
      const streamedReviewIds: string[] = [];
      let sessionReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_missing_session_payload_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_missing_session_payload_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_missing_session_payload_2' ? 'environment' : 'checkpoint',
            findings:
              reviewId === 'rev_missing_session_payload_2'
                ? []
                : [
                    {
                      sequence: 1,
                      severity: 'high',
                      category: 'logic',
                      passType: 'single',
                      locations: [{ filePath: 'math.js', startLine: 1, endLine: 3 }],
                      description: 'Broken add helper',
                    },
                  ],
            summary:
              reviewId === 'rev_missing_session_payload_2'
                ? {
                    riskLevel: 'low',
                    findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
                    recommendation: 'approve',
                  }
                : {
                    riskLevel: 'high',
                    findingCounts: { critical: 0, high: 1, medium: 0, low: 0 },
                    recommendation: 'request_changes',
                  },
          },
          session:
            reviewId === 'rev_missing_session_payload_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_missing_session_payload_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                }
              : null,
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads === 1
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_missing_session_payload_1',
                    activeReviewId: null,
                    passCount: 1,
                    stopReason: 'initial_pass_completed',
                    finishedAt: '2026-03-11T00:01:00.000Z',
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_missing_session_payload_2',
                    activeReviewId: 'rev_missing_session_payload_2',
                    currentReviewStatus: 'queued',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_missing_session_payload_2',
                        status: 'queued',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.deepEqual(streamedReviewIds, ['rev_missing_session_payload_1', 'rev_missing_session_payload_2']);
      assert.equal(sessionReads >= 2, true);
      assert.equal(final.finalReviewId, 'rev_missing_session_payload_2');
    }

    {
      const streamedReviewIds: string[] = [];
      let sessionReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_missing_review_session_id_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_missing_review_session_id_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: reviewId === 'rev_missing_review_session_id_2' ? 'session_abcd1234' : null,
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_missing_review_session_id_2' ? 'environment' : 'checkpoint',
            findings:
              reviewId === 'rev_missing_review_session_id_2'
                ? []
                : [
                    {
                      sequence: 1,
                      severity: 'high',
                      category: 'logic',
                      passType: 'single',
                      locations: [{ filePath: 'math.js', startLine: 1, endLine: 3 }],
                      description: 'Broken add helper',
                    },
                  ],
            summary:
              reviewId === 'rev_missing_review_session_id_2'
                ? {
                    riskLevel: 'low',
                    findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
                    recommendation: 'approve',
                  }
                : {
                    riskLevel: 'high',
                    findingCounts: { critical: 0, high: 1, medium: 0, low: 0 },
                    recommendation: 'request_changes',
                  },
          },
          session:
            reviewId === 'rev_missing_review_session_id_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_missing_review_session_id_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_missing_review_session_id_1',
                  activeReviewId: null,
                  passCount: 1,
                  stopReason: 'initial_pass_completed',
                  finishedAt: '2026-03-11T00:01:00.000Z',
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads === 1
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_missing_review_session_id_2',
                    activeReviewId: 'rev_missing_review_session_id_2',
                    currentReviewStatus: 'queued',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      ...createReviewResponseBody().session.passes,
                      {
                        reviewId: 'rev_missing_review_session_id_2',
                        status: 'queued',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_missing_review_session_id_2',
                    activeReviewId: null,
                    currentReviewStatus: 'succeeded',
                    passCount: 2,
                    stopReason: 'followup_pass_completed',
                    finishedAt: '2026-03-11T00:03:00.000Z',
                  },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.deepEqual(streamedReviewIds, ['rev_missing_review_session_id_1', 'rev_missing_review_session_id_2']);
      assert.equal(sessionReads >= 1, true);
      assert.equal(final.finalReviewId, 'rev_missing_review_session_id_2');
    }

    {
      const streamedReviewIds: string[] = [];
      let sessionReads = 0;
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_missing_session_fast_followup_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_missing_session_fast_followup_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_missing_session_fast_followup_2' ? 'environment' : 'checkpoint',
            findings:
              reviewId === 'rev_missing_session_fast_followup_2'
                ? []
                : [
                    {
                      sequence: 1,
                      severity: 'high',
                      category: 'logic',
                      passType: 'single',
                      locations: [{ filePath: 'math.js', startLine: 1, endLine: 3 }],
                      description: 'Broken add helper',
                    },
                  ],
            summary:
              reviewId === 'rev_missing_session_fast_followup_2'
                ? {
                    riskLevel: 'low',
                    findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
                    recommendation: 'approve',
                  }
                : {
                    riskLevel: 'high',
                    findingCounts: { critical: 0, high: 1, medium: 0, low: 0 },
                    recommendation: 'request_changes',
                  },
          },
          session:
            reviewId === 'rev_missing_session_fast_followup_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_missing_session_fast_followup_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                }
              : null,
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads === 1
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_missing_session_fast_followup_2',
                    activeReviewId: null,
                    currentReviewStatus: 'succeeded',
                    passCount: 2,
                    stopReason: null,
                    finishedAt: null,
                    passes: [
                      {
                        reviewId: 'rev_unrelated_pass',
                        status: 'succeeded',
                        reviewBasis: 'checkpoint',
                        createdAt: '2026-03-11T00:00:00.000Z',
                        startedAt: '2026-03-11T00:00:10.000Z',
                        finishedAt: '2026-03-11T00:01:00.000Z',
                      },
                      {
                        reviewId: 'rev_missing_session_fast_followup_2',
                        status: 'queued',
                        reviewBasis: 'environment',
                        createdAt: '2026-03-11T00:02:00.000Z',
                        startedAt: null,
                        finishedAt: null,
                      },
                    ],
                  }
                : {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_missing_session_fast_followup_2',
                    activeReviewId: null,
                    currentReviewStatus: 'succeeded',
                    passCount: 2,
                    stopReason: 'followup_pass_completed',
                    finishedAt: '2026-03-11T00:03:00.000Z',
                  },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.deepEqual(streamedReviewIds, ['rev_missing_session_fast_followup_1', 'rev_missing_session_fast_followup_2']);
      assert.equal(sessionReads >= 1, true);
      assert.equal(final.finalReviewId, 'rev_missing_session_fast_followup_2');
    }

    {
      let sessionReads = 0;
      const streamedReviewIds: string[] = [];
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_transient_terminal_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_transient_terminal_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_transient_terminal_2' ? 'environment' : 'checkpoint',
            findings: [],
            summary:
              reviewId === 'rev_transient_terminal_2'
                ? {
                    riskLevel: 'low',
                    findingCounts: { critical: 0, high: 0, medium: 0, low: 0 },
                    recommendation: 'approve',
                  }
                : {
                    riskLevel: 'high',
                    findingCounts: { critical: 0, high: 1, medium: 0, low: 0 },
                    recommendation: 'request_changes',
                  },
          },
          session:
            reviewId === 'rev_transient_terminal_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_transient_terminal_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                  passes: [
                    ...createReviewResponseBody().session.passes,
                    {
                      reviewId: 'rev_transient_terminal_2',
                      status: 'succeeded',
                      reviewBasis: 'environment',
                      createdAt: '2026-03-11T00:02:00.000Z',
                      startedAt: '2026-03-11T00:02:10.000Z',
                      finishedAt: '2026-03-11T00:03:00.000Z',
                    },
                  ],
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_transient_terminal_1',
                  activeReviewId: null,
                  passCount: 1,
                  stopReason: 'initial_pass_completed',
                  finishedAt: '2026-03-11T00:01:00.000Z',
                },
        }) as any,
        getReviewSession: async () => {
          sessionReads += 1;
          return {
            session:
              sessionReads === 1
                ? {
                    ...createReviewResponseBody().session,
                    latestReviewId: 'rev_transient_terminal_1',
                    activeReviewId: null,
                    passCount: 1,
                    stopReason: 'initial_pass_completed',
                    finishedAt: '2026-03-11T00:01:00.000Z',
                  }
                : sessionReads === 2
                  ? {
                      ...createReviewResponseBody().session,
                      latestReviewId: 'rev_transient_terminal_2',
                      activeReviewId: 'rev_transient_terminal_2',
                      currentReviewStatus: 'queued',
                      passCount: 2,
                      stopReason: null,
                      finishedAt: null,
                      passes: [
                        ...createReviewResponseBody().session.passes,
                        {
                          reviewId: 'rev_transient_terminal_2',
                          status: 'queued',
                          reviewBasis: 'environment',
                          createdAt: '2026-03-11T00:02:00.000Z',
                          startedAt: null,
                          finishedAt: null,
                        },
                      ],
                    }
                  : {
                      ...createReviewResponseBody().session,
                      latestReviewId: 'rev_transient_terminal_2',
                      activeReviewId: null,
                      currentReviewStatus: 'succeeded',
                      passCount: 2,
                      stopReason: 'followup_pass_completed',
                      finishedAt: '2026-03-11T00:03:00.000Z',
                      passes: [
                        ...createReviewResponseBody().session.passes,
                        {
                          reviewId: 'rev_transient_terminal_2',
                          status: 'succeeded',
                          reviewBasis: 'environment',
                          createdAt: '2026-03-11T00:02:00.000Z',
                          startedAt: '2026-03-11T00:02:10.000Z',
                          finishedAt: '2026-03-11T00:03:00.000Z',
                        },
                      ],
                    },
          } as any;
        },
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.deepEqual(streamedReviewIds, ['rev_transient_terminal_1', 'rev_transient_terminal_2']);
      assert.equal(sessionReads >= 2, true);
      assert.equal(final.finalReviewId, 'rev_transient_terminal_2');
    }

    {
      const warnings: string[] = [];
      const originalDateNow = Date.now;
      const baseNow = originalDateNow();
      let dateNowCalls = 0;
      Date.now = () => {
        dateNowCalls += 1;
        return dateNowCalls >= 3 ? baseNow + 31_000 : baseNow;
      };
      try {
        const final = await followReviewChain({
          workerUrl: 'https://worker.example.com',
          initialReviewId: 'rev_followup_settling',
          initialResultUrl: 'https://worker.example.com/api/reviews/rev_followup_settling',
          streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
            await onEvent({ id: 'terminal', data: { type: 'terminal', status: 'succeeded' } });
          },
          getReview: async () => ({
            review: {
              ...createReviewResponseBody().review,
              id: 'rev_followup_settling',
              sessionId: 'session_abcd1234',
              status: 'succeeded',
              reviewBasis: 'checkpoint',
            },
            session: {
              ...createReviewResponseBody().session,
              latestReviewId: 'rev_followup_settling',
              activeReviewId: 'rev_followup_settling',
              passCount: 1,
              stopReason: null,
              finishedAt: null,
            },
          }) as any,
          getReviewSession: async () => ({
            session: {
              ...createReviewResponseBody().session,
              latestReviewId: 'rev_followup_settling',
              activeReviewId: 'rev_followup_settling',
              passCount: 1,
              stopReason: null,
              finishedAt: null,
            },
          }) as any,
          formatEvent: () => '',
          onStreamWarning: (message) => warnings.push(message),
          pollIntervalMs: 1,
        });

        assert.equal(final.finalReviewId, 'rev_followup_settling');
        assert.equal(warnings.some((message) => message.includes('still settling')), true);
      } finally {
        Date.now = originalDateNow;
      }
    }

    {
      const streamedReviewIds: string[] = [];
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_latest_only_1',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_latest_only_1',
        streamReviewEvents: async (_workerUrl, reviewId, onEvent) => {
          streamedReviewIds.push(reviewId);
          await onEvent({ id: `terminal-${reviewId}`, data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async (_workerUrl, reviewId) => ({
          review: {
            ...createReviewResponseBody().review,
            id: reviewId,
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: reviewId === 'rev_latest_only_2' ? 'environment' : 'checkpoint',
          },
          session:
            reviewId === 'rev_latest_only_2'
              ? {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_latest_only_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: 'followup_pass_completed',
                  finishedAt: '2026-03-11T00:03:00.000Z',
                }
              : {
                  ...createReviewResponseBody().session,
                  latestReviewId: 'rev_latest_only_2',
                  activeReviewId: null,
                  passCount: 2,
                  stopReason: null,
                  finishedAt: null,
                  passes: [
                    {
                      reviewId: 'rev_latest_only_1',
                      status: 'succeeded',
                      reviewBasis: 'checkpoint',
                      createdAt: '2026-03-11T00:00:00.000Z',
                      startedAt: '2026-03-11T00:00:10.000Z',
                      finishedAt: '2026-03-11T00:01:00.000Z',
                    },
                  ],
                },
        }) as any,
        formatEvent: () => '',
        pollIntervalMs: 1,
      });

      assert.deepEqual(streamedReviewIds, ['rev_latest_only_1', 'rev_latest_only_2']);
      assert.equal(final.finalReviewId, 'rev_latest_only_2');
    }

    {
      const warnings: string[] = [];
      const final = await followReviewChain({
        workerUrl: 'https://worker.example.com',
        initialReviewId: 'rev_session_read_warning',
        initialResultUrl: 'https://worker.example.com/api/reviews/rev_session_read_warning',
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: 'terminal', data: { type: 'terminal', status: 'succeeded' } });
        },
        getReview: async () => ({
          review: {
            ...createReviewResponseBody().review,
            id: 'rev_session_read_warning',
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: 'checkpoint',
          },
          session: {
            ...createReviewResponseBody().session,
            latestReviewId: 'rev_session_read_warning',
            activeReviewId: 'rev_session_read_warning',
            passCount: 1,
            stopReason: null,
            finishedAt: null,
          },
        }) as any,
        getReviewSession: async () => {
          throw new Error('session read unavailable');
        },
        formatEvent: () => '',
        onStreamWarning: (message) => warnings.push(message),
        pollIntervalMs: 1,
      });

      assert.equal(final.finalReviewId, 'rev_session_read_warning');
      assert.equal(warnings.some((message) => message.includes('Failed to read review session state while awaiting follow-up pass')), true);
    }

    {
      let sessionCalls = 0;
      let commitResolverCalls = 0;
      setReviewCommitResolverForTests(() => {
        commitResolverCalls += 1;
        throw new Error('commit path should not be used for --session');
      });
      setReviewSessionCreateFlowForTests({
        createReviewSessionPass: async () => {
          sessionCalls += 1;
          return {
            reviewId: 'rev_env_dispatch',
            sessionId: 'session_abcd1234',
            status: 'queued',
            eventsUrl: '/api/reviews/rev_env_dispatch/events',
            resultUrl: '/api/reviews/rev_env_dispatch',
            sessionUrl: '/api/review-sessions/session_abcd1234',
          } as any;
        },
        getReview: async () => ({
          review: {
            ...createReviewResponseBody().review,
            id: 'rev_env_dispatch',
            sessionId: 'session_abcd1234',
            status: 'succeeded',
            reviewBasis: 'environment',
          },
          session: createReviewResponseBody().session,
        }) as any,
        getReviewSession: async () => ({
          session: createReviewResponseBody().session,
        }) as any,
        streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
          await onEvent({ id: '1', data: { type: 'terminal', status: 'succeeded' } });
        },
      });
      try {
        await assert.doesNotReject(() =>
          dispatchReviewCommand(
            ['create'],
            { session: 'session_abcd1234' },
            (message) => {
              throw new Error(message);
            }
          )
        );
        assert.equal(sessionCalls, 1);
        assert.equal(commitResolverCalls, 0);
      } finally {
        setReviewCommitResolverForTests(null);
        setReviewSessionCreateFlowForTests(null);
      }
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
