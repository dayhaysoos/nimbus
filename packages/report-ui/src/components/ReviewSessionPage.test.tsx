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

function createReview(
  reviewId: string,
  overrides: Partial<{
    status: string;
    summaryText: string | null;
    derivedPolicy: Record<string, unknown> | undefined;
    findings: Array<Record<string, unknown>>;
  }> = {}
): Record<string, unknown> {
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
    status: overrides.status ?? 'queued',
    idempotencyKey: `idem_${reviewId}`,
    attemptCount: 1,
    ...(overrides.derivedPolicy ? { derivedPolicy: overrides.derivedPolicy } : {}),
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:05.000Z',
    startedAt: '2026-04-15T00:00:01.000Z',
    finishedAt: overrides.status === 'succeeded' ? '2026-04-15T00:00:15.000Z' : null,
    summaryText: overrides.summaryText ?? null,
    findings: overrides.findings ?? [],
    evidence: [],
    provenance: {
      sessionIds: ['session_1'],
      promptSummary: null,
      reviewContextMode: 'intent_aware',
    },
    markdownSummary: null,
  };
}

function createAggregate(
  overrides: Partial<{
    sessionId: string;
    phase: string;
    currentReviewStatus: string | null;
    passStatus: string;
    canStream: boolean;
    waitingOnHuman: boolean;
    terminal: boolean;
    activeReview: Record<string, unknown> | null;
    latestReview: Record<string, unknown> | null;
    reviews: Array<Record<string, unknown>>;
    findings: {
      unresolved: Array<Record<string, unknown>>;
      resolved: Array<Record<string, unknown>>;
      all: Array<Record<string, unknown>>;
    };
    reviewedDiff: Record<string, unknown>;
    local: {
      environments: Array<Record<string, unknown>>;
      hasAny: boolean;
    };
    adopt: {
      available: boolean;
      reason: string | null;
    };
    activityDetail: string;
    activitySummary: string;
    outcome: Record<string, unknown> | null;
  }> = {}
): Record<string, unknown> {
  const sessionId = overrides.sessionId ?? 'session_1';
  const phase = overrides.phase ?? 'reviewing';
  const currentReviewStatus = Object.prototype.hasOwnProperty.call(overrides, 'currentReviewStatus')
    ? overrides.currentReviewStatus
    : 'running';
  const reviewId = 'review_1';
  const passStatus = overrides.passStatus ?? (currentReviewStatus ?? 'succeeded');
  const reviews = overrides.reviews ?? [createReview(reviewId, { status: passStatus })];
  const latestReview = overrides.latestReview ?? reviews[reviews.length - 1] ?? null;
  const activeReview =
    Object.prototype.hasOwnProperty.call(overrides, 'activeReview') ? overrides.activeReview : currentReviewStatus ? latestReview : null;
  const canStream = overrides.canStream ?? false;
  const waitingOnHuman = overrides.waitingOnHuman ?? false;
  const terminal = overrides.terminal ?? (phase === 'completed' || phase === 'failed' || phase === 'cancelled');

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
      activeReviewId: activeReview ? reviewId : null,
      latestReviewId: latestReview ? reviewId : null,
      currentReviewStatus,
      stopReason: terminal ? 'followup_pass_completed' : null,
      createdAt: '2026-04-15T00:00:00.000Z',
      updatedAt: '2026-04-15T00:00:15.000Z',
      finishedAt: terminal ? '2026-04-15T00:00:15.000Z' : null,
      passes: [
        {
          reviewId,
          status: passStatus,
          reviewBasis: 'checkpoint',
          createdAt: '2026-04-15T00:00:00.000Z',
          startedAt: '2026-04-15T00:00:01.000Z',
          finishedAt: terminal ? '2026-04-15T00:00:15.000Z' : null,
        },
      ],
      outcome: overrides.outcome ?? null,
    },
    reviews,
    latestReview,
    activeReview,
    findings:
      overrides.findings ?? {
        unresolved: [],
        resolved: [],
        all: [],
      },
    activity: {
      sessionId,
      phase,
      state: waitingOnHuman ? 'waiting_on_human' : terminal ? 'terminal' : 'active',
      currentReviewStatus,
      activeReviewId: activeReview ? reviewId : null,
      latestReviewId: latestReview ? reviewId : null,
      passCount: 1,
      summary: overrides.activitySummary ?? 'Nimbus is reviewing the session.',
      detail: overrides.activityDetail ?? 'Nimbus is reviewing the session.',
      canStream,
      streamPath: `/api/studio/sessions/${sessionId}/activity/events`,
      updatedAt: '2026-04-15T00:00:15.000Z',
    },
    reviewedDiff:
      overrides.reviewedDiff ?? {
        sessionId,
        reviewId,
        available: false,
        status: 'unavailable',
        reason: 'No reviewed diff is available.',
        path: `/api/studio/sessions/${sessionId}/reviewed-diff`,
        environmentRevision: null,
      },
    local:
      overrides.local ?? {
        environments: [],
        hasAny: false,
      },
    capabilities: {
      active: !terminal && !waitingOnHuman,
      waitingOnHuman,
      terminal,
      canShowReviewedDiff: overrides.reviewedDiff?.available === true,
      canAdopt: overrides.adopt?.available ?? false,
      canListLocalEnvironments: true,
      canShowLocalDiff: overrides.local?.hasAny ?? false,
      canMergeBack: overrides.local?.hasAny ?? false,
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
      available: overrides.adopt?.available ?? false,
      reason: overrides.adopt?.reason ?? null,
      path: `/api/studio/local-review-sessions/${sessionId}/adopt`,
      modes: ['worktree'],
    },
  };
}

describe('ReviewSessionPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps policy approval inside the main session flow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/studio/sessions/session_policy')) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify(
                createAggregate({
                  sessionId: 'session_policy',
                  phase: 'waiting_on_human',
                  currentReviewStatus: 'policy_ready',
                  waitingOnHuman: true,
                  activeReview: createReview('review_1', {
                    status: 'policy_ready',
                    summaryText: 'Policy draft ready.',
                    derivedPolicy: {
                      goal: 'Review mutation safety.',
                      prohibitions: ['Do not change auth behavior.'],
                      constraints: ['Keep changes scoped.'],
                    },
                  }),
                  latestReview: createReview('review_1', {
                    status: 'policy_ready',
                    summaryText: 'Policy draft ready.',
                    derivedPolicy: {
                      goal: 'Review mutation safety.',
                      prohibitions: ['Do not change auth behavior.'],
                      constraints: ['Keep changes scoped.'],
                    },
                  }),
                  reviews: [
                    createReview('review_1', {
                      status: 'policy_ready',
                      summaryText: 'Policy draft ready.',
                      derivedPolicy: {
                        goal: 'Review mutation safety.',
                        prohibitions: ['Do not change auth behavior.'],
                        constraints: ['Keep changes scoped.'],
                      },
                    }),
                  ],
                  activityDetail: 'Nimbus is paused until the policy is approved.',
                  activitySummary: 'Paused for human input.',
                })
              ),
          };
        }
        if (url.includes('/policy/approve')) {
          return {
            ok: true,
            text: async () => JSON.stringify({ reviewId: 'review_1', approvedPolicySha256: 'abc123' }),
          };
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    render(
      <MemoryRouter initialEntries={['/sessions/session_policy']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'Approve the review policy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve policy' })).toBeInTheDocument();
    expect(screen.queryByText('Merge the adopted session into your current branch')).not.toBeInTheDocument();
  });

  it('shows reviewed diff, adopts locally, and allows merge-back', async () => {
    let aggregateReads = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/studio/sessions/session_done')) {
          aggregateReads += 1;
          const withLocal = aggregateReads > 1;
          return {
            ok: true,
            text: async () =>
              JSON.stringify(
                createAggregate({
                  sessionId: 'session_done',
                  phase: 'completed',
                  terminal: true,
                  currentReviewStatus: null,
                  passStatus: 'succeeded',
                  latestReview: createReview('review_1', {
                    status: 'succeeded',
                    summaryText: 'Nimbus completed remediation.',
                    findings: [
                      {
                        id: 'finding_1',
                        severity: 'medium',
                        confidence: 'medium',
                        title: 'Manual verification remains',
                        description: 'Manual verification is still needed for the fallback request path.',
                        conditions: null,
                        locations: [{ path: 'src/request.ts', line: 42 }],
                        suggestedFix: { kind: 'text', value: 'Verify the fallback branch manually.' },
                        evidenceRefs: [],
                      },
                    ],
                  }),
                  reviews: [
                    createReview('review_1', {
                      status: 'succeeded',
                      summaryText: 'Nimbus completed remediation.',
                      findings: [
                        {
                          id: 'finding_1',
                          severity: 'medium',
                          confidence: 'medium',
                          title: 'Manual verification remains',
                          description: 'Manual verification is still needed for the fallback request path.',
                          conditions: null,
                          locations: [{ path: 'src/request.ts', line: 42 }],
                          suggestedFix: { kind: 'text', value: 'Verify the fallback branch manually.' },
                          evidenceRefs: [],
                        },
                      ],
                    }),
                  ],
                  findings: {
                    unresolved: [
                      {
                        id: 'finding_1',
                        severity: 'medium',
                        confidence: 'medium',
                        title: 'Manual verification remains',
                        description: 'Manual verification is still needed for the fallback request path.',
                        conditions: null,
                        locations: [{ path: 'src/request.ts', line: 42 }],
                        suggestedFix: { kind: 'text', value: 'Verify the fallback branch manually.' },
                        evidenceRefs: [],
                      },
                    ],
                    resolved: [
                      {
                        finding: {
                          id: 'finding_resolved',
                          severity: 'low',
                          confidence: 'high',
                          title: 'Guard added',
                          description: 'Nimbus added a guard around the request mutation path.',
                          conditions: null,
                          locations: [{ path: 'src/request.ts', line: 12 }],
                          suggestedFix: { kind: 'text', value: 'No further action needed.' },
                          evidenceRefs: [],
                        },
                        state: 'resolved',
                        firstSeenReviewId: 'review_1',
                        lastSeenReviewId: 'review_1',
                        reviewIds: ['review_1'],
                      },
                    ],
                    all: [],
                  },
                  reviewedDiff: {
                    sessionId: 'session_done',
                    reviewId: 'review_1',
                    available: true,
                    status: 'available',
                    reason: null,
                    path: '/api/studio/sessions/session_done/reviewed-diff',
                    environmentRevision: {
                      source: 'workspace_head',
                      diffSha256: 'b'.repeat(64),
                      changedFileCount: 1,
                      generatedAt: '2026-04-15T00:00:15.000Z',
                    },
                    diff: {
                      workspaceId: 'ws_1',
                      includePatch: true,
                      maxBytes: 200000,
                      truncated: false,
                      summary: {
                        added: 0,
                        modified: 1,
                        deleted: 0,
                        renamed: 0,
                        totalChanged: 1,
                      },
                      changedFiles: [{ path: 'src/request.ts', status: 'modified' }],
                      patch: 'diff --git a/src/request.ts b/src/request.ts\n+if (!request) return;',
                    },
                  },
                  local: withLocal
                    ? {
                        environments: [
                          {
                            sessionId: 'session_done',
                            repoRoot: '/tmp/repo',
                            repo: 'acme/web',
                            branchName: 'nimbus/session/session_done',
                            mode: 'worktree',
                            worktreePath: '/tmp/repo/.nimbus/session_done',
                            artifactId: 'artifact_1',
                            artifactSha256: 'c'.repeat(64),
                            latestReviewId: 'review_1',
                            anchorCommitSha: 'abcdef1234567890',
                            commitSha: 'fedcba0987654321',
                            environmentRevision: {
                              source: 'workspace_head',
                              diffSha256: 'b'.repeat(64),
                              changedFileCount: 1,
                              generatedAt: '2026-04-15T00:00:15.000Z',
                            },
                            contextMode: 'intent_aware',
                            materializedAt: '2026-04-15T00:01:00.000Z',
                            enterCommand: "cd -- '/tmp/repo/.nimbus/session_done'",
                            diffPath:
                              '/api/studio/local-review-sessions/session_done/diff?mode=worktree&branchName=nimbus%2Fsession%2Fsession_done',
                            mergeBackPath:
                              '/api/studio/local-review-sessions/session_done/merge-back?mode=worktree&branchName=nimbus%2Fsession%2Fsession_done',
                          },
                        ],
                        hasAny: true,
                      }
                    : {
                        environments: [],
                        hasAny: false,
                      },
                  adopt: {
                    available: !withLocal,
                    reason: null,
                  },
                  activityDetail: 'Nimbus completed the session.',
                  activitySummary: 'Nimbus completed the session.',
                  outcome: {
                    kind: 'converged_with_blockers',
                    summary: 'Nimbus completed a remediation pass, but one finding still needs manual review.',
                    residualRisk: 'medium',
                    recommendation: 'request_changes',
                    materializeReady: true,
                    reviewed: {
                      contextMode: 'intent_aware',
                      latestReviewBasis: 'checkpoint',
                      passCount: 1,
                    },
                    changes: {
                      applied: true,
                      remediationCount: 1,
                      changedFileCount: 1,
                      summaries: ['Nimbus added a guard around the request mutation path.'],
                      environmentRevision: null,
                    },
                    evidence: {
                      passed: 1,
                      failed: 0,
                      warning: 1,
                      info: 0,
                      highlights: [],
                    },
                    unresolved: {
                      findingCount: 1,
                      highestSeverity: 'medium',
                      highlights: [],
                    },
                  },
                })
              ),
          };
        }
        if (url.includes('/api/studio/local-review-sessions/session_done/adopt')) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                sessionId: 'session_done',
                mode: 'worktree',
                branchName: 'nimbus/session/session_done',
                worktreePath: '/tmp/repo/.nimbus/session_done',
                artifactId: 'artifact_1',
                artifactSha256: 'c'.repeat(64),
                latestReviewId: 'review_1',
                anchorCommitSha: 'abcdef1234567890',
                commitSha: 'fedcba0987654321',
                enterCommand: "cd -- '/tmp/repo/.nimbus/session_done'",
              }),
          };
        }
        if (url.includes('/api/studio/local-review-sessions/session_done/diff')) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                entry: {
                  sessionId: 'session_done',
                  repoRoot: '/tmp/repo',
                  repo: 'acme/web',
                  branchName: 'nimbus/session/session_done',
                  mode: 'worktree',
                  worktreePath: '/tmp/repo/.nimbus/session_done',
                  artifactId: 'artifact_1',
                  artifactSha256: 'c'.repeat(64),
                  latestReviewId: 'review_1',
                  anchorCommitSha: 'abcdef1234567890',
                  commitSha: 'fedcba0987654321',
                  environmentRevision: {
                    source: 'workspace_head',
                    diffSha256: 'b'.repeat(64),
                    changedFileCount: 1,
                    generatedAt: '2026-04-15T00:00:15.000Z',
                  },
                  contextMode: 'intent_aware',
                  materializedAt: '2026-04-15T00:01:00.000Z',
                  enterCommand: "cd -- '/tmp/repo/.nimbus/session_done'",
                },
                baseRef: 'main',
                diff: 'diff --git a/src/request.ts b/src/request.ts\n+console.log("tested");',
                hasDiff: true,
                enterCommand: "cd -- '/tmp/repo/.nimbus/session_done'",
              }),
          };
        }
        if (url.includes('/api/studio/local-review-sessions/session_done/merge-back')) {
          expect(init?.method).toBe('POST');
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                sessionId: 'session_done',
                currentBranch: 'main',
                sourceBranch: 'nimbus/session/session_done',
                sourceCommit: 'fedcba0987654321',
                newHead: '1234567890abcdef',
                worktreePath: '/tmp/repo/.nimbus/session_done',
                status: 'applied',
              }),
          };
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    render(
      <MemoryRouter initialEntries={['/sessions/session_done']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'What Nimbus changed' })).toBeInTheDocument();
    expect(screen.getByText(/diff --git a\/src\/request\.ts b\/src\/request\.ts/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Adopt locally' }));

    expect(await screen.findByText('Local worktree ready')).toBeInTheDocument();
    expect(screen.getAllByText(/nimbus\/session\/session_done/)).toHaveLength(2);
    expect(await screen.findByText(/console\.log\("tested"\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Merge back into current branch' }));

    expect(await screen.findByText(/Merge back completed/i)).toBeInTheDocument();
    expect(screen.getByText(/Source branch/)).toBeInTheDocument();
  });

  it('treats findings-only terminal sessions as non-adoptable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/studio/sessions/session_findings_only')) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify(
                createAggregate({
                  sessionId: 'session_findings_only',
                  phase: 'completed',
                  terminal: true,
                  currentReviewStatus: null,
                  passStatus: 'succeeded',
                  latestReview: createReview('review_1', {
                    status: 'succeeded',
                    summaryText:
                      'Nimbus stopped because further review passes looked low-yield relative to the remaining issues.',
                    findings: [
                      {
                        id: 'finding_1',
                        severity: 'low',
                        confidence: 'medium',
                        title: 'Registry entry can resolve unexpectedly',
                        description:
                          'Registry entry can resolve unexpectedly when duplicate local environment records exist.',
                        conditions: null,
                        locations: [{ path: 'packages/cli/src/app/reviews/local-environments.ts', line: 188 }],
                        suggestedFix: {
                          kind: 'text',
                          value: 'Key records by branch name or choose the latest matching entry consistently.',
                        },
                        evidenceRefs: [],
                      },
                    ],
                  }),
                  reviews: [
                    createReview('review_1', {
                      status: 'succeeded',
                      summaryText:
                        'Nimbus stopped because further review passes looked low-yield relative to the remaining issues.',
                      findings: [
                        {
                          id: 'finding_1',
                          severity: 'low',
                          confidence: 'medium',
                          title: 'Registry entry can resolve unexpectedly',
                          description:
                            'Registry entry can resolve unexpectedly when duplicate local environment records exist.',
                          conditions: null,
                          locations: [{ path: 'packages/cli/src/app/reviews/local-environments.ts', line: 188 }],
                          suggestedFix: {
                            kind: 'text',
                            value: 'Key records by branch name or choose the latest matching entry consistently.',
                          },
                          evidenceRefs: [],
                        },
                      ],
                    }),
                  ],
                  findings: {
                    unresolved: [
                      {
                        id: 'finding_1',
                        severity: 'low',
                        confidence: 'medium',
                        title: 'Registry entry can resolve unexpectedly',
                        description:
                          'Registry entry can resolve unexpectedly when duplicate local environment records exist.',
                        conditions: null,
                        locations: [{ path: 'packages/cli/src/app/reviews/local-environments.ts', line: 188 }],
                        suggestedFix: {
                          kind: 'text',
                          value: 'Key records by branch name or choose the latest matching entry consistently.',
                        },
                        evidenceRefs: [],
                      },
                    ],
                    resolved: [],
                    all: [],
                  },
                  reviewedDiff: {
                    sessionId: 'session_findings_only',
                    reviewId: 'review_1',
                    available: false,
                    status: 'unavailable',
                    reason: 'Session did not produce a remediated worktree diff.',
                    path: '/api/studio/sessions/session_findings_only/reviewed-diff',
                    environmentRevision: null,
                  },
                  local: {
                    environments: [],
                    hasAny: false,
                  },
                  adopt: {
                    available: false,
                    reason: 'No remediated worktree is available for this session.',
                  },
                  activityDetail:
                    'Nimbus stopped because further review passes looked low-yield relative to the remaining issues.',
                  activitySummary:
                    'Nimbus stopped because further review passes looked low-yield relative to the remaining issues.',
                  outcome: {
                    kind: 'exhausted',
                    summary:
                      'Nimbus stopped because further review passes looked low-yield relative to the remaining issues.',
                    residualRisk: 'low',
                    recommendation: 'comment',
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
                      passed: 0,
                      failed: 0,
                      warning: 0,
                      info: 0,
                      highlights: [],
                    },
                    unresolved: {
                      findingCount: 1,
                      highestSeverity: 'low',
                      highlights: [],
                    },
                  },
                })
              ),
          };
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    render(
      <MemoryRouter initialEntries={['/sessions/session_findings_only']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'No reviewed result to adopt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adopt locally' })).not.toBeInTheDocument();
    expect(screen.getByText(/there is nothing to adopt or merge back/i)).toBeInTheDocument();
    expect(screen.getByText('packages/cli/src/app/reviews/local-environments.ts:188')).toBeInTheDocument();
  });

  it('renders live findings as activity events arrive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/studio/sessions/session_live')) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify(
                createAggregate({
                  sessionId: 'session_live',
                  phase: 'reviewing',
                  currentReviewStatus: 'running',
                  passStatus: 'running',
                  canStream: true,
                  terminal: false,
                  activityDetail: 'Nimbus is reviewing the current pass.',
                  activitySummary: 'Review in progress.',
                })
              ),
          };
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    render(
      <MemoryRouter initialEntries={['/sessions/session_live']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { name: 'session_live' })).toBeInTheDocument();

    const source = MockEventSource.instances[0];
    expect(source).toBeDefined();

    source.emit('message', {
      type: 'activity',
      sessionId: 'session_live',
      reviewId: 'review_1',
      passIndex: 0,
      rawType: 'review_finding_emitted',
      kind: 'finding',
      label: 'Finding emitted',
      detail: 'A fallback path can leave the request unresolved.',
      createdAt: '2026-04-15T00:00:02.000Z',
      seq: 1,
      payload: {
        severity: 'high',
        title: 'Fallback request can hang',
        description: 'A fallback path can leave the request unresolved.',
        locations: [{ path: 'src/request.ts', line: 48 }],
      },
    });

    expect(await screen.findByRole('heading', { name: 'Findings materializing during the current session' })).toBeInTheDocument();
    expect(screen.getByText('Fallback request can hang')).toBeInTheDocument();
    expect(screen.getByText('src/request.ts:48')).toBeInTheDocument();
  });
});
