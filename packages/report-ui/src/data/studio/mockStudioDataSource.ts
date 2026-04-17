import type {
  LocalReviewEnvironmentDiffResponse,
  LocalReviewEnvironmentMergeBackResponse,
  ReviewFinding,
  ReviewPolicyDraft,
  ReviewResponse,
  StudioAdoptResponse,
  StudioContextResponse,
  StudioNewReviewPreflightResponse,
  StudioNewReviewStartStageEvent,
  StudioSessionActivityEntry,
  StudioSessionActivityEvent,
  StudioSessionAggregateResponse,
} from '../../types';
import type { StudioDataSource, StudioDataSubscription, StudioLaunchState } from './StudioDataSource';

const MOCK_REPO = 'dayhaysoos/nimbus';
const MOCK_BRANCH = 'codex/studio-launch-rebuild';
const MOCK_COMMIT_SHA = '4f8c2be';
const LAST_CHECKPOINTS = 1 as const;

type MockLaunchStateName = 'ready' | 'basic' | 'blocked' | 'no_repo';
type MockSessionState =
  | 'preparing'
  | 'reviewing'
  | 'fixing'
  | 'verifying'
  | 'waiting'
  | 'completed_diff'
  | 'completed_empty'
  | 'failed';

interface MockStudioRuntime {
  sessionId: string;
  scenario: MockSessionState;
  adopted: boolean;
  mergedBack: boolean;
}

function resolveBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function resolveMockLaunchState(env: Record<string, string | undefined>): MockLaunchStateName {
  const raw = (env.VITE_STUDIO_MOCK_STATE ?? '').trim().toLowerCase();
  if (raw === 'basic' || raw === 'blocked' || raw === 'no_repo') {
    return raw;
  }
  return 'ready';
}

function resolveMockSessionState(input: string | undefined, env: Record<string, string | undefined>): MockSessionState {
  const routeValue = input?.startsWith('mock-') ? decodeURIComponent(input.slice(5)).trim().toLowerCase() : '';
  const envValue = (env.VITE_STUDIO_MOCK_SESSION_STATE ?? '').trim().toLowerCase();
  const raw = routeValue || envValue;
  if (
    raw === 'preparing' ||
    raw === 'reviewing' ||
    raw === 'fixing' ||
    raw === 'verifying' ||
    raw === 'waiting' ||
    raw === 'completed_diff' ||
    raw === 'completed_empty' ||
    raw === 'failed'
  ) {
    return raw;
  }
  return 'reviewing';
}

function now(secondsAgo = 0): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

function createMockFinding(input: {
  severity: ReviewFinding['severity'];
  title: string;
  description: string;
  filePath: string;
  line: number;
  suggestedFix: string;
}): ReviewFinding {
  return {
    severity: input.severity,
    category: 'logic',
    passType: 'single',
    title: input.title,
    description: input.description,
    locations: [
      {
        filePath: input.filePath,
        startLine: input.line,
        endLine: input.line,
      },
    ],
    suggestedFix: input.suggestedFix,
  };
}

function createMockActivityEvent(input: {
  sessionId: string;
  reviewId: string;
  passIndex: number;
  seq: number;
  createdAt: string;
  kind: StudioSessionActivityEntry['kind'];
  label: string;
  detail: string;
  payload?: Record<string, unknown>;
}): StudioSessionActivityEntry {
  return {
    type: 'activity',
    sessionId: input.sessionId,
    reviewId: input.reviewId,
    passIndex: input.passIndex,
    rawType: input.kind,
    kind: input.kind,
    label: input.label,
    detail: input.detail,
    createdAt: input.createdAt,
    seq: input.seq,
    payload: input.payload ?? {},
  };
}

function createMockReview(
  sessionId: string,
  reviewId: string,
  status: ReviewResponse['status'],
  input?: {
    summaryText?: string | null;
    derivedPolicy?: ReviewPolicyDraft;
    findings?: ReviewFinding[];
    contextMode?: ReviewResponse['provenance']['reviewContextMode'];
    finishedAt?: string | null;
    error?: { code: string; message: string };
  }
): ReviewResponse {
  return {
    id: reviewId,
    workspaceId: 'ws_mock',
    deploymentId: 'dep_mock',
    target: {
      type: 'workspace_deployment',
      workspaceId: 'ws_mock',
      deploymentId: 'dep_mock',
    },
    mode: 'report_only',
    status,
    idempotencyKey: `idem_${reviewId}`,
    attemptCount: 1,
    derivedPolicy: input?.derivedPolicy,
    createdAt: now(60),
    updatedAt: now(1),
    startedAt: now(58),
    finishedAt: input?.finishedAt ?? (status === 'succeeded' || status === 'failed' ? now(1) : null),
    findings: input?.findings ?? [],
    evidence: [],
    provenance: {
      sessionIds: [sessionId],
      promptSummary: null,
      reviewContextMode: input?.contextMode ?? 'intent_aware',
    },
    summaryText: input?.summaryText ?? undefined,
    markdownSummary: null,
    ...(input?.error ? { error: input.error } : {}),
  };
}

function createLaunchPreflight(state: MockLaunchStateName): StudioNewReviewPreflightResponse | null {
  if (state === 'no_repo') {
    return null;
  }
  const common = {
    repo: MOCK_REPO,
    branch: MOCK_BRANCH,
    policyMode: 'auto' as const,
    requestedLastCheckpoints: LAST_CHECKPOINTS,
    effectiveLastCheckpoints: LAST_CHECKPOINTS,
    lastCheckpoints: LAST_CHECKPOINTS,
    checkpointSelectionMode: 'latest' as const,
    commitSha: MOCK_COMMIT_SHA,
    includedCheckpoints: [
      {
        checkpointId: 'checkpoint_mock_ready',
        commitSha: MOCK_COMMIT_SHA,
        commitSubject: 'Rebuild Studio launch experience',
      },
    ],
  };

  if (state === 'basic') {
    return {
      ...common,
      startability: 'basic',
      contextMode: 'basic',
      checkpointId: 'checkpoint_mock_ready',
      ready: true,
      capabilities: {
        canStart: true,
        canStartInBasicMode: true,
        canStartInIntentAwareMode: false,
        canReviewPolicy: false,
      },
      blockingIssues: [],
      warnings: [
        {
          code: 'entire_context_unavailable',
          message: 'Entire context was not found for the current checkpoint window.',
        },
      ],
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint',
          ok: true,
          detail: 'A checkpoint is available for the current commit.',
        },
        {
          code: 'entire_context',
          label: 'Entire context',
          ok: false,
          detail: 'Entire context is unavailable, so Nimbus will fall back to basic review mode.',
        },
      ],
    };
  }

  if (state === 'blocked') {
    return {
      ...common,
      startability: 'blocked',
      contextMode: 'basic',
      checkpointId: null,
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
          message: 'Nimbus could not find a valid checkpoint for the current commit.',
        },
      ],
      warnings: [],
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint',
          ok: false,
          detail: 'No checkpoint is available for the current commit.',
        },
        {
          code: 'entire_context',
          label: 'Entire context',
          ok: false,
          detail: 'Entire context cannot be resolved until a checkpoint is available.',
        },
      ],
      error: {
        code: 'checkpoint_unavailable',
        message: 'Nimbus could not find a valid checkpoint for the current commit.',
      },
    };
  }

  return {
    ...common,
    startability: 'intent_aware',
    contextMode: 'intent_aware',
    checkpointId: 'checkpoint_mock_ready',
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
      {
        code: 'checkpoint',
        label: 'Checkpoint',
        ok: true,
        detail: 'A checkpoint is available for the current commit.',
      },
      {
        code: 'entire_context',
        label: 'Entire context',
        ok: true,
        detail: 'Entire context is available for the current checkpoint window.',
      },
    ],
  };
}

function createLaunchContext(state: MockLaunchStateName): StudioContextResponse {
  if (state === 'no_repo') {
    return {
      repo: null,
      branch: null,
      detectedAt: now(),
    };
  }
  return {
    repo: MOCK_REPO,
    branch: MOCK_BRANCH,
    detectedAt: now(),
  };
}

function createMockSessionAggregate(runtime: MockStudioRuntime): {
  aggregate: StudioSessionAggregateResponse;
  events: StudioSessionActivityEntry[];
} {
  const reviewId = `review_${runtime.sessionId}`;
  const findings = [
    createMockFinding({
      severity: 'high',
      title: 'Launch state explanation is still too verbose',
      description: 'The default live session should surface status changes without requiring a long explanatory paragraph.',
      filePath: 'packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx',
      line: 42,
      suggestedFix: 'Keep only the active summary and show deeper explanation on demand.',
    }),
    createMockFinding({
      severity: 'medium',
      title: 'Activity console needs tighter grouping',
      description: 'Progress updates should stay visually compact so new findings stand out immediately.',
      filePath: 'packages/report-ui/src/features/studio-session/SessionActivityPanel.tsx',
      line: 58,
      suggestedFix: 'Group related progress events by pass and reduce duplicate chrome.',
    }),
  ];

  const reviewEvents = [
    createMockActivityEvent({
      sessionId: runtime.sessionId,
      reviewId,
      passIndex: 0,
      seq: 1,
      createdAt: now(52),
      kind: 'progress',
      label: 'Checkpoint',
      detail: 'Locked onto the latest commit for this branch.',
    }),
    createMockActivityEvent({
      sessionId: runtime.sessionId,
      reviewId,
      passIndex: 0,
      seq: 2,
      createdAt: now(42),
      kind: 'progress',
      label: 'Pass 1',
      detail: 'Running the initial review pass against the latest commit.',
    }),
    createMockActivityEvent({
      sessionId: runtime.sessionId,
      reviewId,
      passIndex: 0,
      seq: 3,
      createdAt: now(31),
      kind: 'finding',
      label: 'Finding published',
      detail: findings[0].description,
      payload: {
        severity: findings[0].severity,
        title: findings[0].title,
        description: findings[0].description,
        locations: [
          {
            path: findings[0].locations[0]?.filePath,
            line: findings[0].locations[0]?.startLine,
          },
        ],
      },
    }),
    createMockActivityEvent({
      sessionId: runtime.sessionId,
      reviewId,
      passIndex: 0,
      seq: 4,
      createdAt: now(14),
      kind: 'finding',
      label: 'Finding published',
      detail: findings[1].description,
      payload: {
        severity: findings[1].severity,
        title: findings[1].title,
        description: findings[1].description,
        locations: [
          {
            path: findings[1].locations[0]?.filePath,
            line: findings[1].locations[0]?.startLine,
          },
        ],
      },
    }),
  ];

  const adoptedEnvironment =
    runtime.adopted
      ? {
          sessionId: runtime.sessionId,
          repoRoot: '/tmp/nimbus/mock-review-session',
          repo: MOCK_REPO,
          branchName: 'nimbus/mock-reviewed-result',
          mode: 'worktree' as const,
          worktreePath: '/tmp/nimbus/mock-review-session',
          artifactId: 'artifact_mock',
          artifactSha256: 'sha256_mock',
          latestReviewId: reviewId,
          anchorCommitSha: MOCK_COMMIT_SHA,
          commitSha: 'c0ffee42',
          environmentRevision: {
            source: 'workspace_head' as const,
            diffSha256: 'diff_sha_mock',
            changedFileCount: 3,
            generatedAt: now(1),
          },
          contextMode: 'intent_aware' as const,
          materializedAt: now(1),
          enterCommand: 'cd /tmp/nimbus/mock-review-session',
          diffPath: `/api/studio/mock/${runtime.sessionId}/local-diff`,
          mergeBackPath: `/api/studio/mock/${runtime.sessionId}/merge-back`,
        }
      : null;

  if (runtime.scenario === 'waiting') {
    const derivedPolicy: ReviewPolicyDraft = {
      goal: 'Keep the launch and session routes simple and readable.',
      prohibitions: ['Do not silently mutate the current checkout.'],
      constraints: ['Keep adopt and merge-back explicit on the session route.'],
    };
    const activeReview = createMockReview(runtime.sessionId, reviewId, 'policy_ready', {
      summaryText: 'Policy draft ready.',
      derivedPolicy,
      findings,
    });
    return {
      events: [
        ...reviewEvents,
        createMockActivityEvent({
          sessionId: runtime.sessionId,
          reviewId,
          passIndex: 0,
          seq: 5,
          createdAt: now(3),
          kind: 'policy',
          label: 'Policy approval required',
          detail: 'Nimbus proposed a remediation step that needs human approval before proceeding.',
        }),
      ],
      aggregate: {
        session: {
          id: runtime.sessionId,
          workspaceId: 'ws_mock',
          anchorDeploymentId: 'dep_mock',
          repo: MOCK_REPO,
          branch: MOCK_BRANCH,
          initialReviewBasis: 'checkpoint',
          anchorCommitSha: MOCK_COMMIT_SHA,
          anchorCheckpointId: 'checkpoint_mock_ready',
          sourceProjectRoot: '/Users/nickdejesus/Code/nimbus',
          phase: 'waiting_on_human',
          passCount: 1,
          activeReviewId: reviewId,
          latestReviewId: reviewId,
          currentReviewStatus: 'policy_ready',
          stopReason: null,
          createdAt: now(60),
          updatedAt: now(1),
          finishedAt: null,
          passes: [
            {
              reviewId,
              status: 'policy_ready',
              reviewBasis: 'checkpoint',
              createdAt: now(60),
              startedAt: now(58),
              finishedAt: null,
            },
          ],
          outcome: null,
        },
        reviews: [activeReview],
        latestReview: activeReview,
        activeReview,
        findings: {
          unresolved: findings,
          resolved: [],
          all: [],
        },
        activity: {
          sessionId: runtime.sessionId,
          phase: 'waiting_on_human',
          state: 'waiting_on_human',
          currentReviewStatus: 'policy_ready',
          activeReviewId: reviewId,
          latestReviewId: reviewId,
          passCount: 1,
          summary: 'Waiting on policy approval',
          detail: 'Nimbus needs a human decision before it can continue remediation.',
          canStream: false,
          streamPath: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
          updatedAt: now(1),
        },
        reviewedDiff: {
          sessionId: runtime.sessionId,
          reviewId,
          available: false,
          status: 'unavailable',
          reason: 'Nimbus has not produced a reviewed diff yet.',
          path: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
          environmentRevision: null,
        },
        local: {
          environments: [],
          hasAny: false,
        },
        capabilities: {
          active: false,
          waitingOnHuman: true,
          terminal: false,
          canShowReviewedDiff: false,
          canAdopt: false,
          canListLocalEnvironments: true,
          canShowLocalDiff: false,
          canMergeBack: false,
        },
        paths: {
          self: `/api/studio/sessions/${runtime.sessionId}`,
          activity: `/api/studio/sessions/${runtime.sessionId}/activity`,
          activityEvents: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
          reviewedDiff: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
          localEnvironments: `/api/studio/local-review-sessions?sessionId=${runtime.sessionId}`,
          adopt: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
        },
        adopt: {
          available: false,
          reason: 'Nimbus is waiting on approval before it can produce a reviewed result.',
          path: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
          modes: ['worktree'],
        },
      },
    };
  }

  if (runtime.scenario === 'completed_diff') {
    const latestReview = createMockReview(runtime.sessionId, reviewId, 'succeeded', {
      summaryText: 'Reviewed diff available.',
      findings: [],
    });
    return {
      events: [
        ...reviewEvents,
        createMockActivityEvent({
          sessionId: runtime.sessionId,
          reviewId,
          passIndex: 1,
          seq: 5,
          createdAt: now(5),
          kind: 'remediation',
          label: 'Remediation',
          detail: 'Applied the reviewed UI simplification and prepared the final diff.',
        }),
        createMockActivityEvent({
          sessionId: runtime.sessionId,
          reviewId,
          passIndex: 1,
          seq: 6,
          createdAt: now(1),
          kind: 'terminal',
          label: 'Session completed',
          detail: 'Reviewed diff is available and ready to adopt locally.',
        }),
      ],
      aggregate: {
        session: {
          id: runtime.sessionId,
          workspaceId: 'ws_mock',
          anchorDeploymentId: 'dep_mock',
          repo: MOCK_REPO,
          branch: MOCK_BRANCH,
          initialReviewBasis: 'checkpoint',
          anchorCommitSha: MOCK_COMMIT_SHA,
          anchorCheckpointId: 'checkpoint_mock_ready',
          sourceProjectRoot: '/Users/nickdejesus/Code/nimbus',
          phase: 'completed',
          passCount: 2,
          activeReviewId: null,
          latestReviewId: reviewId,
          currentReviewStatus: 'succeeded',
          stopReason: 'followup_pass_completed',
          createdAt: now(60),
          updatedAt: now(1),
          finishedAt: now(1),
          passes: [
            {
              reviewId,
              status: 'succeeded',
              reviewBasis: 'checkpoint',
              createdAt: now(60),
              startedAt: now(58),
              finishedAt: now(1),
            },
          ],
          outcome: {
            kind: 'clean',
            summary: 'Nimbus completed the remediation loop and published a reviewed diff for local validation.',
            residualRisk: 'low',
            recommendation: 'approve',
            materializeReady: true,
            reviewed: {
              contextMode: 'intent_aware',
              latestReviewBasis: 'checkpoint',
              passCount: 2,
            },
            changes: {
              applied: true,
              remediationCount: 2,
              changedFileCount: 3,
              summaries: ['Simplified route/controller seams and consolidated session rendering.'],
              environmentRevision: adoptedEnvironment?.environmentRevision ?? null,
            },
            evidence: {
              passed: 2,
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
        reviews: [latestReview],
        latestReview,
        activeReview: null,
        findings: {
          unresolved: [],
          resolved: findings.map((finding) => ({
            finding,
            state: 'resolved' as const,
            firstSeenReviewId: reviewId,
            lastSeenReviewId: reviewId,
            reviewIds: [reviewId],
          })),
          all: findings.map((finding) => ({
            finding,
            state: 'resolved' as const,
            firstSeenReviewId: reviewId,
            lastSeenReviewId: reviewId,
            reviewIds: [reviewId],
          })),
        },
        activity: {
          sessionId: runtime.sessionId,
          phase: 'completed',
          state: 'terminal',
          currentReviewStatus: 'succeeded',
          activeReviewId: null,
          latestReviewId: reviewId,
          passCount: 2,
          summary: 'Reviewed diff available',
          detail: 'Nimbus finished and published a reviewed diff ready for local adoption.',
          canStream: false,
          streamPath: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
          updatedAt: now(1),
        },
        reviewedDiff: {
          sessionId: runtime.sessionId,
          reviewId,
          available: true,
          status: 'available',
          reason: null,
          path: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
          environmentRevision: adoptedEnvironment?.environmentRevision ?? null,
          diff: {
            workspaceId: 'ws_mock',
            includePatch: true,
            maxBytes: 200_000,
            truncated: false,
            summary: {
              added: 1,
              modified: 2,
              deleted: 0,
              renamed: 0,
              totalChanged: 3,
            },
            changedFiles: [
              { path: 'packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx', status: 'modified' },
              { path: 'packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx', status: 'modified' },
              { path: 'packages/report-ui/src/data/studio/StudioDataSource.tsx', status: 'added' },
            ],
            patch: `diff --git a/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx b/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
index a1c3342..b26f912 100644
--- a/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
+++ b/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
@@ -181,7 +181,9 @@ export function StudioSessionScreen(): JSX.Element {
         <section className="flow-section">
           <div className="section-header">
             <div>
-              <h2>Reviewed diff</h2>
+              <h2>Reviewed diff</h2>
+              <p className="panel-subtle">
+                Review the changed files before adopting this isolated result locally.
+              </p>
             </div>
           </div>
           <SessionReviewedDiffPanel reviewedDiff={viewModel.reviewedDiff} />
diff --git a/packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx b/packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx
index c4411d2..ca7b9f0 100644
--- a/packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx
+++ b/packages/report-ui/src/features/studio-launch/StudioLaunchScreen.tsx
@@ -74,6 +74,7 @@ export function StudioLaunchScreen(): JSX.Element {
         <div className="launch-actions">
           <button className="primary-button" type="button">
             Start review session
+            
           </button>
         </div>
         <p className="launch-inline-note">
@@ -83,7 +84,7 @@ export function StudioLaunchScreen(): JSX.Element {
-          Nimbus reviews the current commit for this branch.
+          Nimbus reviews the latest committed state on this branch.
         </p>
       </section>
diff --git a/packages/report-ui/src/data/studio/StudioDataSource.tsx b/packages/report-ui/src/data/studio/StudioDataSource.tsx
new file mode 100644
--- /dev/null
+++ b/packages/report-ui/src/data/studio/StudioDataSource.tsx
@@ -0,0 +1,12 @@
+export function createStudioDataSourceLabel(mode: 'mock' | 'live'): string {
+  if (mode === 'mock') {
+    return 'Mock preview';
+  }
+
+  return 'Live session';
+}
+`,
          },
        },
        local: {
          environments: adoptedEnvironment ? [adoptedEnvironment] : [],
          hasAny: Boolean(adoptedEnvironment),
        },
        capabilities: {
          active: false,
          waitingOnHuman: false,
          terminal: true,
          canShowReviewedDiff: true,
          canAdopt: !runtime.adopted,
          canListLocalEnvironments: true,
          canShowLocalDiff: Boolean(adoptedEnvironment),
          canMergeBack: Boolean(adoptedEnvironment),
        },
        paths: {
          self: `/api/studio/sessions/${runtime.sessionId}`,
          activity: `/api/studio/sessions/${runtime.sessionId}/activity`,
          activityEvents: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
          reviewedDiff: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
          localEnvironments: `/api/studio/local-review-sessions?sessionId=${runtime.sessionId}`,
          adopt: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
        },
        adopt: {
          available: !runtime.adopted,
          reason: runtime.adopted ? 'The reviewed result is already adopted locally.' : 'Create an isolated worktree for validation.',
          path: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
          modes: ['worktree'],
        },
      },
    };
  }

  if (runtime.scenario === 'completed_empty') {
    const latestReview = createMockReview(runtime.sessionId, reviewId, 'succeeded', {
      summaryText: 'Findings-only session complete.',
      findings,
      contextMode: 'basic',
    });
    return {
      events: [
        ...reviewEvents,
        createMockActivityEvent({
          sessionId: runtime.sessionId,
          reviewId,
          passIndex: 0,
          seq: 5,
          createdAt: now(1),
          kind: 'terminal',
          label: 'Session completed',
          detail: 'No remediated result was produced for this session.',
        }),
      ],
      aggregate: {
        session: {
          id: runtime.sessionId,
          workspaceId: 'ws_mock',
          anchorDeploymentId: 'dep_mock',
          repo: MOCK_REPO,
          branch: MOCK_BRANCH,
          initialReviewBasis: 'checkpoint',
          anchorCommitSha: MOCK_COMMIT_SHA,
          anchorCheckpointId: 'checkpoint_mock_ready',
          sourceProjectRoot: '/Users/nickdejesus/Code/nimbus',
          phase: 'completed',
          passCount: 1,
          activeReviewId: null,
          latestReviewId: reviewId,
          currentReviewStatus: 'succeeded',
          stopReason: 'initial_pass_completed',
          createdAt: now(60),
          updatedAt: now(1),
          finishedAt: now(1),
          passes: [
            {
              reviewId,
              status: 'succeeded',
              reviewBasis: 'checkpoint',
              createdAt: now(60),
              startedAt: now(58),
              finishedAt: now(1),
            },
          ],
          outcome: {
            kind: 'converged_with_blockers',
            summary: 'Nimbus finished cleanly but did not produce a remediated worktree.',
            residualRisk: 'medium',
            recommendation: 'request_changes',
            materializeReady: false,
            reviewed: {
              contextMode: 'basic',
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
              findingCount: findings.length,
              highestSeverity: 'high',
              highlights: findings.map((finding) => ({
                severity: finding.severity,
                category: finding.category,
                description: finding.description,
                filePath: finding.locations[0]?.filePath ?? null,
              })),
            },
          },
        },
        reviews: [latestReview],
        latestReview,
        activeReview: null,
        findings: {
          unresolved: findings,
          resolved: [],
          all: [],
        },
        activity: {
          sessionId: runtime.sessionId,
          phase: 'completed',
          state: 'terminal',
          currentReviewStatus: 'succeeded',
          activeReviewId: null,
          latestReviewId: reviewId,
          passCount: 1,
          summary: 'No remediated result',
          detail: 'Nimbus completed the session without a reviewed diff to adopt.',
          canStream: false,
          streamPath: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
          updatedAt: now(1),
        },
        reviewedDiff: {
          sessionId: runtime.sessionId,
          reviewId,
          available: false,
          status: 'unavailable',
          reason: 'Nimbus did not publish a reviewed diff for this session.',
          path: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
          environmentRevision: null,
        },
        local: {
          environments: [],
          hasAny: false,
        },
        capabilities: {
          active: false,
          waitingOnHuman: false,
          terminal: true,
          canShowReviewedDiff: false,
          canAdopt: false,
          canListLocalEnvironments: true,
          canShowLocalDiff: false,
          canMergeBack: false,
        },
        paths: {
          self: `/api/studio/sessions/${runtime.sessionId}`,
          activity: `/api/studio/sessions/${runtime.sessionId}/activity`,
          activityEvents: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
          reviewedDiff: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
          localEnvironments: `/api/studio/local-review-sessions?sessionId=${runtime.sessionId}`,
          adopt: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
        },
        adopt: {
          available: false,
          reason: 'Nimbus did not produce a remediated result for this session.',
          path: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
          modes: ['worktree'],
        },
      },
    };
  }

  if (runtime.scenario === 'failed') {
    const latestReview = createMockReview(runtime.sessionId, reviewId, 'failed', {
      summaryText: 'Session failed.',
      findings,
      error: {
        code: 'auto_remediation_failed',
        message: 'Remediation failed before Nimbus could produce a reviewed result.',
      },
    });
    return {
      events: [
        ...reviewEvents,
        createMockActivityEvent({
          sessionId: runtime.sessionId,
          reviewId,
          passIndex: 0,
          seq: 5,
          createdAt: now(1),
          kind: 'terminal',
          label: 'Session failed',
          detail: 'Remediation failed before Nimbus could produce a reviewed result.',
        }),
      ],
      aggregate: {
        session: {
          id: runtime.sessionId,
          workspaceId: 'ws_mock',
          anchorDeploymentId: 'dep_mock',
          repo: MOCK_REPO,
          branch: MOCK_BRANCH,
          initialReviewBasis: 'checkpoint',
          anchorCommitSha: MOCK_COMMIT_SHA,
          anchorCheckpointId: 'checkpoint_mock_ready',
          sourceProjectRoot: '/Users/nickdejesus/Code/nimbus',
          phase: 'failed',
          passCount: 1,
          activeReviewId: null,
          latestReviewId: reviewId,
          currentReviewStatus: 'failed',
          stopReason: 'auto_remediation_failed',
          createdAt: now(60),
          updatedAt: now(1),
          finishedAt: now(1),
          passes: [
            {
              reviewId,
              status: 'failed',
              reviewBasis: 'checkpoint',
              createdAt: now(60),
              startedAt: now(58),
              finishedAt: now(1),
            },
          ],
          outcome: null,
        },
        reviews: [latestReview],
        latestReview,
        activeReview: null,
        findings: {
          unresolved: findings,
          resolved: [],
          all: [],
        },
        activity: {
          sessionId: runtime.sessionId,
          phase: 'failed',
          state: 'terminal',
          currentReviewStatus: 'failed',
          activeReviewId: null,
          latestReviewId: reviewId,
          passCount: 1,
          summary: 'Session failed',
          detail: 'Nimbus stopped after the remediation loop failed.',
          canStream: false,
          streamPath: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
          updatedAt: now(1),
        },
        reviewedDiff: {
          sessionId: runtime.sessionId,
          reviewId,
          available: false,
          status: 'error',
          reason: 'Nimbus failed before it could publish a reviewed diff.',
          path: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
          environmentRevision: null,
        },
        local: {
          environments: [],
          hasAny: false,
        },
        capabilities: {
          active: false,
          waitingOnHuman: false,
          terminal: true,
          canShowReviewedDiff: false,
          canAdopt: false,
          canListLocalEnvironments: true,
          canShowLocalDiff: false,
          canMergeBack: false,
        },
        paths: {
          self: `/api/studio/sessions/${runtime.sessionId}`,
          activity: `/api/studio/sessions/${runtime.sessionId}/activity`,
          activityEvents: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
          reviewedDiff: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
          localEnvironments: `/api/studio/local-review-sessions?sessionId=${runtime.sessionId}`,
          adopt: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
        },
        adopt: {
          available: false,
          reason: 'Nimbus failed before it could publish a reviewed result.',
          path: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
          modes: ['worktree'],
        },
      },
    };
  }

  const phase = runtime.scenario === 'preparing' ? 'preparing' : runtime.scenario === 'fixing' ? 'fixing' : runtime.scenario === 'verifying' ? 'verifying' : 'reviewing';
  const detail =
    phase === 'preparing'
      ? 'Preparing workspace, review context, and first pass.'
      : phase === 'fixing'
        ? 'Nimbus is applying safe remediation for the findings it selected.'
        : phase === 'verifying'
          ? 'Nimbus is validating the remediated result before deciding whether it is ready to adopt.'
          : 'Nimbus is currently running the first review pass.';
  const activeReview = createMockReview(runtime.sessionId, reviewId, 'running', {
    findings,
    summaryText: detail,
  });
  return {
    events: reviewEvents,
    aggregate: {
      session: {
        id: runtime.sessionId,
        workspaceId: 'ws_mock',
        anchorDeploymentId: 'dep_mock',
        repo: MOCK_REPO,
        branch: MOCK_BRANCH,
        initialReviewBasis: 'checkpoint',
        anchorCommitSha: MOCK_COMMIT_SHA,
        anchorCheckpointId: 'checkpoint_mock_ready',
        sourceProjectRoot: '/Users/nickdejesus/Code/nimbus',
        phase,
        passCount: phase === 'verifying' ? 2 : 1,
        activeReviewId: reviewId,
        latestReviewId: reviewId,
        currentReviewStatus: 'running',
        stopReason: null,
        createdAt: now(60),
        updatedAt: now(1),
        finishedAt: null,
        passes: [
          {
            reviewId,
            status: 'running',
            reviewBasis: 'checkpoint',
            createdAt: now(60),
            startedAt: now(58),
            finishedAt: null,
          },
        ],
        outcome: null,
      },
      reviews: [activeReview],
      latestReview: activeReview,
      activeReview,
      findings: {
        unresolved: findings,
        resolved: [],
        all: [],
      },
      activity: {
        sessionId: runtime.sessionId,
        phase,
        state: 'active',
        currentReviewStatus: 'running',
        activeReviewId: reviewId,
        latestReviewId: reviewId,
        passCount: phase === 'verifying' ? 2 : 1,
        summary: phase === 'preparing' ? 'Preparing review session' : 'Review pass in progress',
        detail,
        canStream: true,
        streamPath: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
        updatedAt: now(1),
      },
      reviewedDiff: {
        sessionId: runtime.sessionId,
        reviewId,
        available: false,
        status: 'unavailable',
        reason: 'Nimbus has not produced a reviewed diff yet.',
        path: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
        environmentRevision: null,
      },
      local: {
        environments: [],
        hasAny: false,
      },
      capabilities: {
        active: true,
        waitingOnHuman: false,
        terminal: false,
        canShowReviewedDiff: false,
        canAdopt: false,
        canListLocalEnvironments: true,
        canShowLocalDiff: false,
        canMergeBack: false,
      },
      paths: {
        self: `/api/studio/sessions/${runtime.sessionId}`,
        activity: `/api/studio/sessions/${runtime.sessionId}/activity`,
        activityEvents: `/api/studio/sessions/${runtime.sessionId}/activity/events`,
        reviewedDiff: `/api/studio/sessions/${runtime.sessionId}/reviewed-diff`,
        localEnvironments: `/api/studio/local-review-sessions?sessionId=${runtime.sessionId}`,
        adopt: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
      },
      adopt: {
        available: false,
        reason: 'Nimbus needs to finish the session before the result can be adopted.',
        path: `/api/studio/local-review-sessions/${runtime.sessionId}/adopt`,
        modes: ['worktree'],
      },
    },
  };
}

export function createMockStudioDataSource(env: Record<string, string | undefined>): StudioDataSource {
  const runtimes = new Map<string, MockStudioRuntime>();

  const ensureRuntime = (sessionId: string): MockStudioRuntime => {
    const existing = runtimes.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: MockStudioRuntime = {
      sessionId,
      scenario: resolveMockSessionState(sessionId, env),
      adopted: false,
      mergedBack: false,
    };
    runtimes.set(sessionId, created);
    return created;
  };

  const createStartStages = (preflight: StudioNewReviewPreflightResponse | null): StudioNewReviewStartStageEvent[] => {
    const stages: StudioNewReviewStartStageEvent[] = [
      {
        type: 'stage',
        stage: 'checkpoint',
        label: 'Checkpoint resolved',
        detail: 'Nimbus locked onto the current commit checkpoint.',
        state: 'completed',
      },
    ];
    if (preflight?.startability === 'intent_aware') {
      stages.push({
        type: 'stage',
        stage: 'entire_context',
        label: 'Entire context loaded',
        detail: 'Nimbus found the available Entire context for this review.',
        state: 'completed',
      });
    }
    stages.push(
      {
        type: 'stage',
        stage: 'workspace',
        label: 'Workspace prepared',
        detail: 'Nimbus prepared the launch workspace for the review session.',
        state: 'completed',
      },
      {
        type: 'stage',
        stage: 'review_creation',
        label: 'Session creation simulated',
        detail: 'Mock mode stops here so you can inspect the shared UI without creating a real review.',
        state: 'completed',
      }
    );
    return stages;
  };

  return {
    async loadLaunchState(): Promise<StudioLaunchState> {
      const launchState = resolveMockLaunchState(env);
      return {
        context: createLaunchContext(launchState),
        preflight: createLaunchPreflight(launchState),
        currentSession: null,
      };
    },

    startSession(_input, observer): StudioDataSubscription {
      const timers: number[] = [];
      const nextState = resolveMockSessionState(undefined, env);
      const sessionId = `mock-${encodeURIComponent(nextState)}`;
      ensureRuntime(sessionId);
      const stages = createStartStages(createLaunchPreflight(resolveMockLaunchState(env)));

      stages.forEach((stage, index) => {
        timers.push(
          window.setTimeout(() => {
            observer.onEvent(stage);
          }, 180 + index * 220)
        );
      });

      timers.push(
        window.setTimeout(() => {
          observer.onEvent({
            type: 'completed',
            detail: 'Mock session created.',
            reviewId: `review_${sessionId}`,
            sessionId,
            routePath: `/sessions/${sessionId}`,
            policyMode: 'auto',
            contextMode: 'intent_aware',
            requestedLastCheckpoints: LAST_CHECKPOINTS,
            effectiveLastCheckpoints: LAST_CHECKPOINTS,
            status: nextState === 'waiting' ? 'policy_ready' : 'queued',
          });
        }, 180 + stages.length * 220)
      );

      return {
        close(): void {
          timers.forEach((timer) => window.clearTimeout(timer));
        },
      };
    },

    async loadSession(sessionId) {
      return createMockSessionAggregate(ensureRuntime(sessionId)).aggregate;
    },

    subscribeToSessionActivity(aggregate, observer): StudioDataSubscription | null {
      const runtime = ensureRuntime(aggregate.session.id);
      const { events } = createMockSessionAggregate(runtime);
      if (!aggregate.activity.canStream) {
        return null;
      }
      const timers: number[] = [];
      events.forEach((event, index) => {
        timers.push(
          window.setTimeout(() => {
            observer.onEvent(event as StudioSessionActivityEvent);
          }, 140 + index * 260)
        );
      });
      return {
        close(): void {
          timers.forEach((timer) => window.clearTimeout(timer));
        },
      };
    },

    async approvePolicy(input): Promise<void> {
      const runtime = Array.from(runtimes.values()).find((entry) => `review_${entry.sessionId}` === input.reviewId);
      if (!runtime) {
        throw new Error('Mock session not found.');
      }
      runtime.scenario = 'completed_diff';
    },

    async adoptSession(input): Promise<StudioAdoptResponse> {
      const sessionId = input.path.split('/').filter(Boolean).at(-2);
      if (!sessionId) {
        throw new Error('Mock session not found.');
      }
      const runtime = ensureRuntime(sessionId);
      runtime.adopted = true;
      return {
        sessionId,
        mode: 'worktree',
        branchName: 'nimbus/mock-reviewed-result',
        worktreePath: '/tmp/nimbus/mock-review-session',
        artifactId: 'artifact_mock',
        artifactSha256: 'sha256_mock',
        latestReviewId: `review_${sessionId}`,
        anchorCommitSha: MOCK_COMMIT_SHA,
        commitSha: 'c0ffee42',
        enterCommand: 'cd /tmp/nimbus/mock-review-session',
      };
    },

    async loadLocalDiff(path): Promise<LocalReviewEnvironmentDiffResponse> {
      const sessionId = path.split('/').filter(Boolean).at(-2) ?? `mock-${resolveMockSessionState(undefined, env)}`;
      const runtime = ensureRuntime(sessionId);
      if (!runtime.adopted) {
        throw new Error('No adopted worktree is available yet.');
      }
      const aggregate = createMockSessionAggregate(runtime).aggregate;
      const entry = aggregate.local.environments[0];
      if (!entry) {
        throw new Error('Local environment is unavailable.');
      }
      return {
        entry,
        baseRef: MOCK_BRANCH,
        diff: `diff --git a/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx b/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
index b26f912..c0ffee4 100644
--- a/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
+++ b/packages/report-ui/src/features/studio-session/StudioSessionScreen.tsx
@@ -220,6 +220,7 @@ export function StudioSessionScreen(): JSX.Element {
           <SessionLocalDiffPanel localDiff={viewModel.localDiff} />
           <SessionMergeBackPanel mergeBack={viewModel.mergeBack} />
+          <button className="primary-button">Merge back into current branch</button>
         </section>
       ) : null}
diff --git a/packages/report-ui/src/features/studio-session/components/SessionMergeBackPanel.tsx b/packages/report-ui/src/features/studio-session/components/SessionMergeBackPanel.tsx
index 1377e01..22cb571 100644
--- a/packages/report-ui/src/features/studio-session/components/SessionMergeBackPanel.tsx
+++ b/packages/report-ui/src/features/studio-session/components/SessionMergeBackPanel.tsx
@@ -8,6 +8,7 @@ export function SessionMergeBackPanel(props: Props): JSX.Element | null {
   return (
     <div className="panel-card">
       <h2>Merge back into current branch</h2>
+      <p className="panel-subtle">Nimbus only merges back after you validate the adopted worktree.</p>
     </div>
   );
 }
`,
        hasDiff: true,
        enterCommand: entry.enterCommand,
      };
    },

    async mergeBack(path): Promise<LocalReviewEnvironmentMergeBackResponse> {
      const sessionId = path.split('/').filter(Boolean).at(-2);
      if (!sessionId) {
        throw new Error('Mock session not found.');
      }
      const runtime = ensureRuntime(sessionId);
      runtime.mergedBack = true;
      return {
        sessionId,
        currentBranch: MOCK_BRANCH,
        sourceBranch: 'nimbus/mock-reviewed-result',
        sourceCommit: 'c0ffee42',
        newHead: runtime.mergedBack ? 'deadbeef' : null,
        worktreePath: '/tmp/nimbus/mock-review-session',
        status: 'applied',
      };
    },
  };
}
