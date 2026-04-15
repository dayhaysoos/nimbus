import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

function createReview(reviewId: string, status: string): Record<string, unknown> {
  return {
    id: reviewId,
    workspaceId: 'ws_1',
    deploymentId: 'dep_1',
    target: {
      type: 'workspace_deployment',
      workspaceId: 'ws_1',
      deploymentId: 'dep_1',
    },
    mode: 'report_only',
    status,
    idempotencyKey: `idem_${reviewId}`,
    attemptCount: 1,
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:01.000Z',
    startedAt: '2026-04-15T00:00:01.000Z',
    finishedAt: status === 'succeeded' ? '2026-04-15T00:00:10.000Z' : null,
    findings: [],
    evidence: [],
    provenance: {
      sessionIds: ['session_launch'],
      promptSummary: null,
    },
    summaryText: null,
    markdownSummary: null,
  };
}

function createAggregate(
  overrides: Partial<{
    sessionId: string;
    phase: string;
    status: string | null;
    canStream: boolean;
    detail: string;
    summary: string;
  }> = {}
): Record<string, unknown> {
  const sessionId = overrides.sessionId ?? 'session_launch';
  const phase = overrides.phase ?? 'completed';
  const status = Object.prototype.hasOwnProperty.call(overrides, 'status') ? overrides.status : null;
  const canStream = overrides.canStream ?? false;
  const reviewId = 'review_launch';

  return {
    session: {
      id: sessionId,
      workspaceId: 'ws_1',
      anchorDeploymentId: 'dep_1',
      repo: 'acme/web',
      branch: 'main',
      initialReviewBasis: 'checkpoint',
      anchorCommitSha: 'abcdef1234567890',
      anchorCheckpointId: null,
      sourceProjectRoot: '/tmp/repo',
      phase,
      passCount: 1,
      activeReviewId: canStream ? reviewId : null,
      latestReviewId: reviewId,
      currentReviewStatus: status,
      stopReason: phase === 'completed' ? 'initial_pass_completed' : null,
      createdAt: '2026-04-15T00:00:00.000Z',
      updatedAt: '2026-04-15T00:00:10.000Z',
      finishedAt: phase === 'completed' ? '2026-04-15T00:00:10.000Z' : null,
      passes: [
        {
          reviewId,
          status: status ?? 'succeeded',
          reviewBasis: 'checkpoint',
          createdAt: '2026-04-15T00:00:00.000Z',
          startedAt: '2026-04-15T00:00:01.000Z',
          finishedAt: phase === 'completed' ? '2026-04-15T00:00:10.000Z' : null,
        },
      ],
      outcome:
        phase === 'completed'
          ? {
              kind: 'clean',
              summary: 'Nimbus completed the session.',
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
            }
          : null,
    },
    reviews: [createReview(reviewId, status ?? 'succeeded')],
    latestReview: createReview(reviewId, status ?? 'succeeded'),
    activeReview: canStream ? createReview(reviewId, status ?? 'running') : null,
    findings: {
      unresolved: [],
      resolved: [],
      all: [],
    },
    activity: {
      sessionId,
      phase,
      state: phase === 'completed' ? 'terminal' : 'active',
      currentReviewStatus: status,
      activeReviewId: canStream ? reviewId : null,
      latestReviewId: reviewId,
      passCount: 1,
      summary: overrides.summary ?? 'Nimbus completed the session.',
      detail: overrides.detail ?? 'Nimbus completed the session.',
      canStream,
      streamPath: `/api/studio/sessions/${sessionId}/activity/events`,
      updatedAt: '2026-04-15T00:00:10.000Z',
    },
    reviewedDiff: {
      sessionId,
      reviewId,
      available: false,
      status: 'unavailable',
      reason: 'No diff.',
      path: `/api/studio/sessions/${sessionId}/reviewed-diff`,
      environmentRevision: null,
    },
    local: {
      environments: [],
      hasAny: false,
    },
    capabilities: {
      active: canStream,
      waitingOnHuman: false,
      terminal: !canStream,
      canShowReviewedDiff: false,
      canAdopt: false,
      canListLocalEnvironments: true,
      canShowLocalDiff: false,
      canMergeBack: false,
    },
    paths: {
      self: `/api/studio/sessions/${sessionId}`,
      activity: `/api/studio/sessions/${sessionId}/activity`,
      activityEvents: `/api/studio/sessions/${sessionId}/activity/events`,
      reviewedDiff: `/api/studio/sessions/${sessionId}/reviewed-diff`,
      localEnvironments: `/api/studio/local-review-sessions?sessionId=${sessionId}`,
      adopt: `/api/studio/local-review-sessions/${sessionId}/adopt`,
    },
    adopt: {
      available: false,
      reason: 'No adoptable changes.',
      path: `/api/studio/local-review-sessions/${sessionId}/adopt`,
      modes: ['worktree'],
    },
  };
}

describe('ReviewHistoryPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
  });

  it('routes directly into the current commit session instead of offering a second launch path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/studio/context')) {
          return {
            ok: true,
            json: async () => ({ repo: 'acme/web', branch: 'main', detectedAt: '2026-04-15T00:00:00.000Z' }),
          };
        }
        if (url.includes('/api/studio/new-review/preflight')) {
          return {
            ok: true,
            json: async () => ({
              repo: 'acme/web',
              branch: 'main',
              policyMode: 'auto',
              startability: 'basic',
              contextMode: 'basic',
              requestedLastCheckpoints: 1,
              effectiveLastCheckpoints: 1,
              lastCheckpoints: 1,
              checkpointSelectionMode: 'latest',
              checkpointId: null,
              commitSha: 'abcdef1234567890',
              includedCheckpoints: [],
              ready: true,
              capabilities: {
                canStart: true,
                canStartInBasicMode: true,
                canStartInIntentAwareMode: false,
                canReviewPolicy: true,
              },
              blockingIssues: [],
              warnings: [
                {
                  code: 'entire_context_unavailable',
                  message: 'Entire context is unavailable on this commit.',
                },
              ],
              checks: [
                {
                  code: 'checkpoint',
                  label: 'Checkpoint target',
                  ok: true,
                  detail: 'Nimbus will review HEAD directly.',
                },
                {
                  code: 'entire_context',
                  label: 'Entire context',
                  ok: false,
                  detail: 'Entire context is unavailable. Falling back to basic mode.',
                },
              ],
            }),
          };
        }
        if (url.includes('/api/review-sessions?limit=20')) {
          return {
            ok: true,
            json: async () => ({
              sessions: [
                {
                  id: 'session_active',
                  workspaceId: 'ws_1',
                  anchorDeploymentId: 'dep_1',
                  repo: 'acme/web',
                  branch: 'main',
                  initialReviewBasis: 'checkpoint',
                  anchorCommitSha: 'abcdef1234567890',
                  anchorCheckpointId: null,
                  sourceProjectRoot: '/tmp/repo',
                  phase: 'reviewing',
                  passCount: 1,
                  activeReviewId: 'review_active',
                  latestReviewId: 'review_active',
                  currentReviewStatus: 'running',
                  stopReason: null,
                  createdAt: '2026-04-15T00:00:00.000Z',
                  updatedAt: '2026-04-15T00:01:00.000Z',
                  finishedAt: null,
                  passes: [
                    {
                      reviewId: 'review_active',
                      status: 'running',
                      reviewBasis: 'checkpoint',
                      createdAt: '2026-04-15T00:00:00.000Z',
                      startedAt: '2026-04-15T00:00:01.000Z',
                      finishedAt: null,
                    },
                  ],
                  outcome: null,
                },
              ],
            }),
          };
        }
        if (url.includes('/api/studio/sessions/session_active')) {
          return {
            ok: true,
            text: async () => JSON.stringify(createAggregate({ sessionId: 'session_active', phase: 'reviewing' })),
          };
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'session_active' })).toBeInTheDocument();
  });

  it('streams startup stages and navigates into the session page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/studio/context')) {
          return {
            ok: true,
            json: async () => ({ repo: 'acme/web', branch: 'main', detectedAt: '2026-04-15T00:00:00.000Z' }),
          };
        }
        if (url.includes('/api/studio/new-review/preflight')) {
          return {
            ok: true,
            json: async () => ({
              repo: 'acme/web',
              branch: 'main',
              policyMode: 'auto',
              startability: 'intent_aware',
              contextMode: 'intent_aware',
              requestedLastCheckpoints: 1,
              effectiveLastCheckpoints: 1,
              lastCheckpoints: 1,
              checkpointSelectionMode: 'latest',
              checkpointId: 'cp_123',
              commitSha: 'abcdef1234567890',
              includedCheckpoints: [],
              ready: true,
              capabilities: {
                canStart: true,
                canStartInBasicMode: true,
                canStartInIntentAwareMode: true,
                canReviewPolicy: true,
              },
              blockingIssues: [],
              warnings: [],
              checks: [
                { code: 'checkpoint', label: 'Checkpoint target', ok: true, detail: 'Resolved checkpoint cp_123.' },
                { code: 'entire_context', label: 'Entire context', ok: true, detail: 'Context is readable.' },
              ],
            }),
          };
        }
        if (url.includes('/api/review-sessions?limit=20')) {
          return {
            ok: true,
            json: async () => ({ sessions: [] }),
          };
        }
        if (url.includes('/api/studio/sessions/session_launch')) {
          return {
            ok: true,
            text: async () => JSON.stringify(createAggregate({ sessionId: 'session_launch' })),
          };
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'New review session' }));

    await waitFor(() => expect(MockEventSource.instances[0]).toBeDefined());
    const source = MockEventSource.instances[0]!;

    source.emit('message', {
      type: 'stage',
      stage: 'checkpoint',
      state: 'active',
      label: 'Resolving checkpoint',
      detail: 'Nimbus is resolving the current commit.',
    });

    expect(await screen.findByText('Resolving checkpoint')).toBeInTheDocument();

    source.emit('message', {
      type: 'completed',
      reviewId: 'review_launch',
      sessionId: 'session_launch',
      routePath: '/sessions/session_launch/reports/review_launch',
      policyMode: 'auto',
      contextMode: 'intent_aware',
      requestedLastCheckpoints: 1,
      effectiveLastCheckpoints: 1,
      status: 'queued',
      detail: 'Ready for review.',
    });

    expect(await screen.findByRole('heading', { name: 'session_launch' })).toBeInTheDocument();
  });

  it('keeps the launcher available when branch history only has sessions for older commits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/studio/context')) {
          return {
            ok: true,
            json: async () => ({ repo: 'acme/web', branch: 'main', detectedAt: '2026-04-15T00:00:00.000Z' }),
          };
        }
        if (url.includes('/api/studio/new-review/preflight')) {
          return {
            ok: true,
            json: async () => ({
              repo: 'acme/web',
              branch: 'main',
              policyMode: 'auto',
              startability: 'basic',
              contextMode: 'basic',
              requestedLastCheckpoints: 1,
              effectiveLastCheckpoints: 1,
              lastCheckpoints: 1,
              checkpointSelectionMode: 'latest',
              checkpointId: null,
              commitSha: 'currentcommit1234567890currentcommit123456',
              includedCheckpoints: [],
              ready: true,
              capabilities: {
                canStart: true,
                canStartInBasicMode: true,
                canStartInIntentAwareMode: false,
                canReviewPolicy: true,
              },
              blockingIssues: [],
              warnings: [
                {
                  code: 'entire_context_unavailable',
                  message: 'Entire context is unavailable on this commit.',
                },
              ],
              checks: [
                {
                  code: 'checkpoint',
                  label: 'Checkpoint target',
                  ok: true,
                  detail: 'Nimbus will review HEAD directly.',
                },
                {
                  code: 'entire_context',
                  label: 'Entire context',
                  ok: false,
                  detail: 'Entire context is unavailable. Falling back to basic mode.',
                },
              ],
            }),
          };
        }
        if (url.includes('/api/review-sessions?limit=20')) {
          return {
            ok: true,
            json: async () => ({
              sessions: [
                {
                  id: 'session_old_commit',
                  workspaceId: 'ws_1',
                  anchorDeploymentId: 'dep_1',
                  repo: 'acme/web',
                  branch: 'main',
                  initialReviewBasis: 'checkpoint',
                  anchorCommitSha: 'oldercommit1234567890oldercommit1234567',
                  anchorCheckpointId: null,
                  sourceProjectRoot: '/tmp/repo',
                  phase: 'completed',
                  passCount: 1,
                  activeReviewId: null,
                  latestReviewId: 'review_old',
                  currentReviewStatus: 'succeeded',
                  stopReason: 'initial_pass_completed',
                  createdAt: '2026-04-15T00:00:00.000Z',
                  updatedAt: '2026-04-15T00:01:00.000Z',
                  finishedAt: '2026-04-15T00:02:00.000Z',
                  passes: [
                    {
                      reviewId: 'review_old',
                      status: 'succeeded',
                      reviewBasis: 'checkpoint',
                      createdAt: '2026-04-15T00:00:00.000Z',
                      startedAt: '2026-04-15T00:00:01.000Z',
                      finishedAt: '2026-04-15T00:02:00.000Z',
                    },
                  ],
                  outcome: null,
                },
              ],
            }),
          };
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText('Basic review fallback')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New review session' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Open current session' })).not.toBeInTheDocument();
  });

  it('refreshes the launcher when the window regains focus after the commit context changes', async () => {
    let preflightRequests = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/studio/context')) {
          return {
            ok: true,
            json: async () => ({ repo: 'acme/web', branch: 'main', detectedAt: '2026-04-15T00:00:00.000Z' }),
          };
        }
        if (url.includes('/api/studio/new-review/preflight')) {
          preflightRequests += 1;
          if (preflightRequests === 1) {
            return {
              ok: true,
              json: async () => ({
                repo: 'acme/web',
                branch: 'main',
                policyMode: 'auto',
                startability: 'blocked',
                contextMode: 'basic',
                requestedLastCheckpoints: 1,
                effectiveLastCheckpoints: 1,
                lastCheckpoints: 1,
                checkpointSelectionMode: 'latest',
                checkpointId: null,
                commitSha: '1111111111111111111111111111111111111111',
                includedCheckpoints: [],
                ready: false,
                capabilities: {
                  canStart: false,
                  canStartInBasicMode: false,
                  canStartInIntentAwareMode: false,
                  canReviewPolicy: false,
                },
                blockingIssues: [
                  {
                    code: 'checkpoint_unavailable',
                    message: 'Commit 111111111111 has no diff patch content. Review creation requires meaningful diff context.',
                  },
                ],
                warnings: [],
                checks: [
                  {
                    code: 'checkpoint',
                    label: 'Checkpoint target',
                    ok: false,
                    detail: 'Commit 111111111111 has no diff patch content. Review creation requires meaningful diff context.',
                  },
                  {
                    code: 'entire_context',
                    label: 'Entire context',
                    ok: false,
                    detail: 'Blocked until checkpoint target is available.',
                  },
                ],
                error: {
                  code: 'checkpoint_unavailable',
                  message: 'Commit 111111111111 has no diff patch content. Review creation requires meaningful diff context.',
                },
              }),
            };
          }

          return {
            ok: true,
            json: async () => ({
              repo: 'acme/web',
              branch: 'main',
              policyMode: 'auto',
              startability: 'basic',
              contextMode: 'basic',
              requestedLastCheckpoints: 1,
              effectiveLastCheckpoints: 1,
              lastCheckpoints: 1,
              checkpointSelectionMode: 'latest',
              checkpointId: null,
              commitSha: '2222222222222222222222222222222222222222',
              includedCheckpoints: [],
              ready: true,
              capabilities: {
                canStart: true,
                canStartInBasicMode: true,
                canStartInIntentAwareMode: false,
                canReviewPolicy: true,
              },
              blockingIssues: [],
              warnings: [
                {
                  code: 'entire_context_unavailable',
                  message: 'Entire context is unavailable on this commit.',
                },
              ],
              checks: [
                {
                  code: 'checkpoint',
                  label: 'Checkpoint target',
                  ok: true,
                  detail: 'Nimbus will review HEAD directly.',
                },
                {
                  code: 'entire_context',
                  label: 'Entire context',
                  ok: false,
                  detail: 'Entire context is unavailable. Falling back to basic mode.',
                },
              ],
            }),
          };
        }
        if (url.includes('/api/review-sessions?limit=20')) {
          return {
            ok: true,
            json: async () => ({ sessions: [] }),
          };
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText('Nimbus cannot start a session from this checkout yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New review session' })).toBeDisabled();

    fireEvent(window, new Event('focus'));

    await waitFor(() => expect(screen.getByText('Basic review fallback')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'New review session' })).toBeEnabled());
    expect(preflightRequests).toBeGreaterThanOrEqual(2);
  });
});
