import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { proxyApiRequest, setUiProxyHooksForTests } from '../../../src/app/reviews/ui-proxy.js';

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers = new Map<string, string>();
  body = '';

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders(): void {}

  write(chunk: string): void {
    this.body += chunk;
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
  }
}

export async function runUiProxyTests(): Promise<void> {
  let capturedSignal: AbortSignal | undefined;

  setUiProxyHooksForTests({
    startStudioNewReview: async (options) => {
      capturedSignal = options.signal;
      await options.onEvent?.({
        type: 'stage',
        stage: 'review_creation',
        state: 'active',
        label: 'Creating review',
        detail: 'detail',
      });
      return {
        reviewId: 'rev_123',
        sessionId: 'session_123',
        routePath: '/reports/rev_123',
        policyMode: options.policyMode,
        contextMode: 'basic',
        requestedLastCheckpoints: 2,
        effectiveLastCheckpoints: 1,
        status: options.policyMode === 'review' ? 'policy_ready' : 'queued',
      };
    },
  });

  try {
    const request = {
      method: 'GET',
      url: '/api/studio/new-review/start/events?policyMode=auto',
    } as IncomingMessage;
    const response = new MockResponse() as unknown as ServerResponse;

    const handled = await proxyApiRequest(
      request,
      response,
      'https://worker.example.com',
      null,
      null,
      null
    );

    assert.equal(handled, true);
    assert.equal(Boolean(capturedSignal), true);
    assert.match((response as unknown as MockResponse).body, /"type":"stage"/);
  } finally {
    setUiProxyHooksForTests(null);
  }

  let abortOnCloseSignal: AbortSignal | undefined;
  setUiProxyHooksForTests({
    startStudioNewReview: async (options) => {
      abortOnCloseSignal = options.signal;
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        reviewId: 'rev_456',
        sessionId: 'session_456',
        routePath: '/reports/rev_456',
        policyMode: options.policyMode,
        contextMode: 'basic',
        requestedLastCheckpoints: 2,
        effectiveLastCheckpoints: 1,
        status: 'queued',
      };
    },
  });

  try {
    const request = {
      method: 'GET',
      url: '/api/studio/new-review/start/events?policyMode=auto',
    } as IncomingMessage;
    const response = new MockResponse() as unknown as ServerResponse;

    const handledPromise = proxyApiRequest(
      request,
      response,
      'https://worker.example.com',
      null,
      null,
      null
    );

    await new Promise((resolve) => setImmediate(resolve));
    (response as unknown as MockResponse).emit('close');
    const handled = await handledPromise;
    assert.equal(handled, true);
    assert.equal(abortOnCloseSignal?.aborted, true);
  } finally {
    setUiProxyHooksForTests(null);
  }

  let reviewedDiffCalls = 0;
  setUiProxyHooksForTests({
    getReviewSession: async () =>
      ({
        session: {
          id: 'session_aggregate',
          workspaceId: 'ws_123',
          anchorDeploymentId: 'dep_123',
          repo: 'dayhaysoos/nimbus',
          branch: 'main',
          initialReviewBasis: 'checkpoint',
          anchorCommitSha: 'a'.repeat(40),
          anchorCheckpointId: 'checkpoint_123',
          sourceProjectRoot: '.',
          phase: 'completed',
          passCount: 2,
          activeReviewId: null,
          latestReviewId: 'rev_2',
          currentReviewStatus: 'succeeded',
          stopReason: 'followup_pass_completed',
          createdAt: '2026-04-15T00:00:00.000Z',
          updatedAt: '2026-04-15T00:10:00.000Z',
          finishedAt: '2026-04-15T00:10:00.000Z',
          passes: [
            {
              reviewId: 'rev_1',
              status: 'succeeded',
              reviewBasis: 'checkpoint',
              createdAt: '2026-04-15T00:00:00.000Z',
              startedAt: '2026-04-15T00:00:01.000Z',
              finishedAt: '2026-04-15T00:02:00.000Z',
            },
            {
              reviewId: 'rev_2',
              status: 'succeeded',
              reviewBasis: 'environment',
              environmentRevision: {
                source: 'workspace_head',
                diffSha256: 'b'.repeat(64),
                changedFileCount: 2,
                generatedAt: '2026-04-15T00:05:00.000Z',
              },
              createdAt: '2026-04-15T00:03:00.000Z',
              startedAt: '2026-04-15T00:03:01.000Z',
              finishedAt: '2026-04-15T00:10:00.000Z',
            },
          ],
          outcome: {
            kind: 'converged_with_blockers',
            summary: 'Nimbus completed review with one resolved issue and one remaining change set.',
            residualRisk: 'low',
            recommendation: 'comment',
            materializeReady: true,
            reviewed: {
              contextMode: 'basic',
              latestReviewBasis: 'environment',
              passCount: 2,
            },
            changes: {
              applied: true,
              remediationCount: 1,
              changedFileCount: 2,
              summaries: ['Updated the request state handling.'],
              environmentRevision: {
                source: 'workspace_head',
                diffSha256: 'b'.repeat(64),
                changedFileCount: 2,
                generatedAt: '2026-04-15T00:05:00.000Z',
              },
            },
            evidence: {
              passed: 1,
              failed: 0,
              warning: 0,
              info: 0,
              highlights: [],
            },
            unresolved: {
              findingCount: 0,
              highestSeverity: null,
              highlights: [],
            },
          },
        },
      }) as never,
    getReview: async (_workerUrl, reviewId) =>
      ({
        review: {
          id: reviewId,
          workspaceId: 'ws_123',
          deploymentId: 'dep_123',
          sessionId: 'session_aggregate',
          target: {
            type: 'workspace_deployment',
            workspaceId: 'ws_123',
            deploymentId: 'dep_123',
          },
          mode: 'report_only',
          status: 'succeeded',
          reviewBasis: reviewId === 'rev_2' ? 'environment' : 'checkpoint',
          idempotencyKey: `idem_${reviewId}`,
          attemptCount: 1,
          startedAt: '2026-04-15T00:00:01.000Z',
          finishedAt: '2026-04-15T00:05:00.000Z',
          createdAt: '2026-04-15T00:00:00.000Z',
          updatedAt: '2026-04-15T00:05:00.000Z',
          findings:
            reviewId === 'rev_1'
              ? [
                  {
                    id: 'finding_1',
                    severity: 'high',
                    confidence: 'high',
                    title: 'Request state stalls',
                    description: 'The request can stall in a transient state.',
                    conditions: null,
                    locations: [{ path: 'src/request.ts', line: 14 }],
                    suggestedFix: { kind: 'text', value: 'Normalize terminal transitions.' },
                    evidenceRefs: [],
                  },
                ]
              : [],
          evidence: [],
          provenance: {
            repo: 'dayhaysoos/nimbus',
            branch: 'main',
            sessionIds: ['session_aggregate'],
            policyItems: [],
            promptSummary: null,
          },
          summaryText: null,
        },
      }) as never,
    getWorkspaceDiff: async () => {
      reviewedDiffCalls += 1;
      return {
        workspaceId: 'ws_123',
        includePatch: true,
        maxBytes: 120000,
        truncated: false,
        summary: {
          added: 0,
          modified: 1,
          deleted: 0,
          renamed: 0,
          totalChanged: 1,
        },
        changedFiles: [{ path: 'src/request.ts', status: 'modified' }],
        patch: 'diff --git a/src/request.ts b/src/request.ts\n',
      } as never;
    },
    listLocalReviewEnvironments: async () =>
      [
        {
          sessionId: 'session_aggregate',
          repoRoot: '/tmp/repo',
          repo: 'dayhaysoos/nimbus',
          branchName: 'nimbus/session/session_aggregate',
          mode: 'worktree',
          worktreePath: '/tmp/repo-worktree',
          artifactId: 'artifact_123',
          artifactSha256: 'c'.repeat(64),
          latestReviewId: 'rev_2',
          anchorCommitSha: 'a'.repeat(40),
          commitSha: 'd'.repeat(40),
          environmentRevision: {
            source: 'workspace_head',
            diffSha256: 'b'.repeat(64),
            changedFileCount: 2,
            generatedAt: '2026-04-15T00:05:00.000Z',
          },
          contextMode: 'basic',
          materializedAt: '2026-04-15T00:11:00.000Z',
        },
      ] as never,
  });

  try {
    const request = {
      method: 'GET',
      url: '/api/studio/sessions/session_aggregate',
    } as IncomingMessage;
    const response = new MockResponse() as unknown as ServerResponse;

    const handled = await proxyApiRequest(
      request,
      response,
      'https://worker.example.com',
      null,
      null,
      null
    );

    assert.equal(handled, true);
    assert.equal(reviewedDiffCalls, 0);
    const payload = JSON.parse((response as unknown as MockResponse).body) as Record<string, any>;
    assert.equal(payload.capabilities.canAdopt, true);
    assert.equal(payload.reviewedDiff.available, true);
    assert.equal('diff' in payload.reviewedDiff, false);
    assert.equal(payload.findings.resolved.length, 1);
    assert.equal(payload.local.environments.length, 1);
    assert.match(payload.local.environments[0].diffPath, /local-review-sessions\/session_aggregate\/diff/);
  } finally {
    setUiProxyHooksForTests(null);
  }

  setUiProxyHooksForTests({
    getReviewSession: async () =>
      ({
        session: {
          id: 'session_stream',
          workspaceId: 'ws_stream',
          anchorDeploymentId: 'dep_stream',
          repo: 'dayhaysoos/nimbus',
          branch: 'main',
          initialReviewBasis: 'checkpoint',
          anchorCommitSha: 'a'.repeat(40),
          anchorCheckpointId: 'checkpoint_stream',
          sourceProjectRoot: '.',
          phase: 'completed',
          passCount: 1,
          activeReviewId: null,
          latestReviewId: 'rev_stream',
          currentReviewStatus: 'succeeded',
          stopReason: 'initial_pass_completed',
          createdAt: '2026-04-15T00:00:00.000Z',
          updatedAt: '2026-04-15T00:02:00.000Z',
          finishedAt: '2026-04-15T00:02:00.000Z',
          passes: [
            {
              reviewId: 'rev_stream',
              status: 'succeeded',
              reviewBasis: 'checkpoint',
              createdAt: '2026-04-15T00:00:00.000Z',
              startedAt: '2026-04-15T00:00:01.000Z',
              finishedAt: '2026-04-15T00:02:00.000Z',
            },
          ],
          outcome: {
            kind: 'clean',
            summary: 'Nimbus completed review with no remaining findings.',
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
              highlights: [],
            },
            unresolved: {
              findingCount: 0,
              highestSeverity: null,
              highlights: [],
            },
          },
        },
      }) as never,
    streamReviewEvents: async (_workerUrl, _reviewId, onEvent) => {
      await onEvent({
        id: '1',
        data: {
          type: 'review_analysis_tool_executed',
          tool: 'diff_summary',
          seq: 1,
          createdAt: '2026-04-15T00:00:30.000Z',
        },
      });
      await onEvent({
        id: '2',
        data: {
          type: 'review_succeeded',
          seq: 2,
          createdAt: '2026-04-15T00:02:00.000Z',
        },
      });
    },
  });

  try {
    const request = {
      method: 'GET',
      url: '/api/studio/sessions/session_stream/activity/events',
    } as IncomingMessage;
    const response = new MockResponse() as unknown as ServerResponse;

    const handled = await proxyApiRequest(
      request,
      response,
      'https://worker.example.com',
      null,
      null,
      null
    );

    assert.equal(handled, true);
    assert.match((response as unknown as MockResponse).body, /"type":"snapshot"/);
    assert.match((response as unknown as MockResponse).body, /"rawType":"review_analysis_tool_executed"/);
    assert.match((response as unknown as MockResponse).body, /"kind":"progress"/);
    assert.match((response as unknown as MockResponse).body, /"type":"terminal"/);
  } finally {
    setUiProxyHooksForTests(null);
  }
}
