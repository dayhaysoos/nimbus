import { describe, expect, it } from 'vitest';
import {
  buildFixPrompt,
  buildFindingText,
  findingCount,
  parseGetReviewSessionResponse,
  parseGetReviewResponse,
  parseListReviewSessionsResponse,
  parseListReviewsResponse,
  parseStudioContextResponse,
  parseStudioNewReviewPreflightResponse,
  parseStudioNewReviewStartResponse,
  parseStudioNewReviewStartStreamEvent,
  parseStudioSessionActivityEvent,
  parseStudioSessionAggregateResponse,
} from './review';
import type { ReviewFinding, ReviewResponse } from '../types';

const finding: ReviewFinding = {
  category: 'logic',
  passType: 'single',
  severity: 'high',
  description: 'User input is written to SQL query directly.',
  locations: [{ filePath: 'src/db.ts', startLine: 42, endLine: 42 }],
  suggestedFix: '',
};

describe('review prompt builders', () => {
  it('builds fix prompt with fallback fields', () => {
    const prompt = buildFixPrompt(finding);

    expect(prompt).toContain('Category: logic');
    expect(prompt).toContain('Suggested fix:\nnot provided');
  });

  it('builds finding text with location list', () => {
    const text = buildFindingText(finding);
    expect(text).toContain('Locations:\nsrc/db.ts:42-42');
  });
});

describe('findingCount', () => {
  it('prefers summary finding counts when present', () => {
    const review = {
      id: 'review_1',
      workspaceId: 'ws_1',
      deploymentId: 'dep_1',
      target: {
        type: 'workspace_deployment',
        workspaceId: 'ws_1',
        deploymentId: 'dep_1',
      },
      mode: 'report_only',
      status: 'succeeded',
      idempotencyKey: 'idem_1',
      attemptCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      summary: {
        riskLevel: 'high',
        recommendation: 'request_changes',
        findingCounts: {
          info: 0,
          critical: 1,
          high: 2,
          medium: 3,
          low: 4,
        },
      },
      findings: [finding],
      evidence: [],
      provenance: {
        sessionIds: [],
        promptSummary: null,
      },
      markdownSummary: null,
    } satisfies ReviewResponse;

    expect(findingCount(review)).toBe(10);
  });
});

describe('parseGetReviewResponse', () => {
  it('parses strict v2 fields and provenance metadata', () => {
    const payload = parseGetReviewResponse({
      review: {
        id: 'review_v2',
        workspaceId: 'ws_1',
        deploymentId: 'dep_1',
        target: {
          type: 'workspace_deployment',
          workspaceId: 'ws_1',
          deploymentId: 'dep_1',
        },
        mode: 'report_only',
        status: 'succeeded',
        idempotencyKey: 'idem_1',
        attemptCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        startedAt: '2026-01-01T00:00:10.000Z',
        finishedAt: '2026-01-01T00:00:40.000Z',
        findings: [],
        evidence: [],
        summaryText: 'No actionable findings identified from review context.',
        furtherPassesLowYield: true,
        provenance: {
          sessionIds: ['ses_1'],
          promptSummary: 'Review generated in report_only mode for deployment dep_1.',
          outputSchemaVersion: 'v2',
          passArchitecture: 'single',
          reviewedFiles: {
            changed: ['src/report.tsx'],
            related: ['src/context.ts'],
            conventions: ['package.json'],
          },
          advisories: ['Large diff detected (31 files). Consider smaller, focused commits for higher quality reviews.'],
          contextResolution: {
            contextResolution: 'branch_fallback',
            originalCheckpointId: 'cp_1',
            resolvedCheckpointId: 'cp_2',
            resolvedCommitSha: 'abcdef1234',
            resolvedCommitMessage: 'feat: recover context',
          },
        },
        markdownSummary: null,
      },
    });

    expect(payload.review.provenance.outputSchemaVersion).toBe('v2');
    expect(payload.review.furtherPassesLowYield).toBe(true);
    expect(payload.review.provenance.reviewedFiles?.changed).toEqual(['src/report.tsx']);
    expect(payload.review.provenance.contextResolution?.contextResolution).toBe('branch_fallback');
    expect(payload.review.provenance.advisories?.[0]).toContain('Large diff detected');
  });

  it('throws when required contract fields are missing', () => {
    expect(() =>
      parseGetReviewResponse({
        review: {
          id: 'review_bad',
          status: 'queued',
        },
      })
    ).toThrow(/workspaceId/);
  });
});

describe('parseListReviewsResponse', () => {
  it('parses list response payload', () => {
    const payload = parseListReviewsResponse({
      reviews: [
        {
          id: 'rev_1',
          workspaceId: 'ws_1',
          deploymentId: 'dep_1',
          repo: 'acme/web',
          branch: 'main',
          status: 'running',
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:05.000Z',
          startedAt: '2026-03-01T00:00:02.000Z',
          finishedAt: null,
          findingCount: 2,
          riskLevel: 'high',
          recommendation: 'request_changes',
          summaryText: 'Potentially unsafe mutation found in request handler.',
        },
      ],
    });

    expect(payload.reviews).toHaveLength(1);
    expect(payload.reviews[0]?.id).toBe('rev_1');
    expect(payload.reviews[0]?.status).toBe('running');
    expect(payload.reviews[0]?.findingCount).toBe(2);
  });

  it('throws when reviews is not an array', () => {
    expect(() => parseListReviewsResponse({ reviews: null })).toThrow(/reviews must be an array/i);
  });
});

describe('parseStudioContextResponse', () => {
  it('parses local studio branch context', () => {
    const payload = parseStudioContextResponse({
      repo: 'acme/web',
      branch: 'feature/home',
      detectedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(payload.repo).toBe('acme/web');
    expect(payload.branch).toBe('feature/home');
  });

  it('throws when detectedAt is missing', () => {
    expect(() => parseStudioContextResponse({ repo: 'acme/web', branch: 'main' })).toThrow(/detectedAt/i);
  });
});

describe('studio new review payloads', () => {
  it('parses preflight payload', () => {
    const payload = parseStudioNewReviewPreflightResponse({
      repo: 'acme/web',
      branch: 'main',
      policyMode: 'auto',
      startability: 'intent_aware',
      contextMode: 'intent_aware',
      requestedLastCheckpoints: 3,
      effectiveLastCheckpoints: 2,
      lastCheckpoints: 2,
      checkpointSelectionMode: 'last_n',
      checkpointId: 'cp_123',
      commitSha: 'abcdef1234567890',
      includedCheckpoints: [
        {
          checkpointId: 'cp_122',
          commitSha: 'aaaaaa123456',
          commitSubject: 'feat: earlier checkpoint',
        },
        {
          checkpointId: 'cp_123',
          commitSha: 'abcdef1234567890',
          commitSubject: 'feat: latest checkpoint',
        },
      ],
      ready: true,
      capabilities: {
        canStart: true,
        canStartInBasicMode: true,
        canStartInIntentAwareMode: true,
        canReviewPolicy: true,
      },
      blockingIssues: [],
      warnings: [
        {
          code: 'branch_context_changed',
          message: 'Branch context changed since preflight.',
        },
      ],
      checks: [
        {
          code: 'checkpoint',
          label: 'Checkpoint target',
          ok: true,
          detail: 'Resolved checkpoint cp_123.',
        },
      ],
    });

    expect(payload.ready).toBe(true);
    expect(payload.policyMode).toBe('auto');
    expect(payload.startability).toBe('intent_aware');
    expect(payload.contextMode).toBe('intent_aware');
    expect(payload.requestedLastCheckpoints).toBe(3);
    expect(payload.effectiveLastCheckpoints).toBe(2);
    expect(payload.checks[0]?.code).toBe('checkpoint');
    expect(payload.warnings[0]?.code).toBe('branch_context_changed');
  });

  it('parses start payload', () => {
    const payload = parseStudioNewReviewStartResponse({
      reviewId: 'rev_123',
      sessionId: 'ses_123',
      routePath: '/branches/acme%2Fweb/main/sessions/ses_123',
      policyMode: 'auto',
      contextMode: 'basic',
      requestedLastCheckpoints: 1,
      effectiveLastCheckpoints: 1,
      status: 'queued',
    });

    expect(payload.reviewId).toBe('rev_123');
    expect(payload.sessionId).toBe('ses_123');
    expect(payload.routePath).toBe('/branches/acme%2Fweb/main/sessions/ses_123');
    expect(payload.contextMode).toBe('basic');
  });

  it('parses start stream stage payload', () => {
    const payload = parseStudioNewReviewStartStreamEvent({
      type: 'stage',
      stage: 'workspace',
      state: 'active',
      label: 'Preparing workspace',
      detail: 'Creating an isolated workspace for the review target.',
    });

    expect(payload.type).toBe('stage');
    if (payload.type === 'stage') {
      expect(payload.stage).toBe('workspace');
      expect(payload.state).toBe('active');
    }
  });
});

describe('review session payloads', () => {
  it('parses list response payload', () => {
    const payload = parseListReviewSessionsResponse({
      sessions: [
        {
          id: 'ses_1',
          workspaceId: 'ws_1',
          anchorDeploymentId: 'dep_1',
          repo: 'acme/web',
          branch: 'main',
          initialReviewBasis: 'checkpoint',
          anchorCommitSha: 'abcdef123456',
          anchorCheckpointId: 'cp_123',
          sourceProjectRoot: '/Users/nickdejesus/Code/nimbus',
          phase: 'waiting_on_human',
          passCount: 1,
          activeReviewId: 'rev_1',
          latestReviewId: 'rev_1',
          currentReviewStatus: 'policy_ready',
          stopReason: null,
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:05.000Z',
          finishedAt: null,
          passes: [
            {
              reviewId: 'rev_1',
              status: 'policy_ready',
              reviewBasis: 'checkpoint',
              createdAt: '2026-03-01T00:00:00.000Z',
              startedAt: null,
              finishedAt: null,
            },
          ],
          outcome: null,
        },
      ],
    });

    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]?.phase).toBe('waiting_on_human');
    expect(payload.sessions[0]?.currentReviewStatus).toBe('policy_ready');
  });

  it('parses studio activity events', () => {
    const payload = parseStudioSessionActivityEvent({
      type: 'activity',
      sessionId: 'ses_live',
      reviewId: 'rev_live',
      passIndex: 0,
      rawType: 'review_finding_emitted',
      kind: 'finding',
      label: 'Finding emitted',
      detail: 'A fallback path can leave the request unresolved.',
      createdAt: '2026-04-15T00:00:01.000Z',
      seq: 1,
      payload: {
        severity: 'high',
        title: 'Fallback path can hang',
        description: 'A fallback path can leave the request unresolved.',
      },
    });

    expect(payload.type).toBe('activity');
    if (payload.type === 'activity') {
      expect(payload.kind).toBe('finding');
      expect(payload.reviewId).toBe('rev_live');
      expect(payload.seq).toBe(1);
    }
  });

  it('parses a studio session aggregate with modern finding payloads', () => {
    const payload = parseStudioSessionAggregateResponse({
      session: {
        id: 'ses_aggregate',
        workspaceId: 'ws_1',
        anchorDeploymentId: 'dep_1',
        repo: 'acme/web',
        branch: 'main',
        initialReviewBasis: 'checkpoint',
        anchorCommitSha: 'abcdef1234567890',
        anchorCheckpointId: null,
        sourceProjectRoot: '/tmp/repo',
        phase: 'completed',
        passCount: 1,
        activeReviewId: null,
        latestReviewId: 'rev_1',
        currentReviewStatus: null,
        stopReason: 'followup_pass_completed',
        createdAt: '2026-04-15T00:00:00.000Z',
        updatedAt: '2026-04-15T00:00:15.000Z',
        finishedAt: '2026-04-15T00:00:15.000Z',
        passes: [
          {
            reviewId: 'rev_1',
            status: 'succeeded',
            reviewBasis: 'checkpoint',
            createdAt: '2026-04-15T00:00:00.000Z',
            startedAt: '2026-04-15T00:00:01.000Z',
            finishedAt: '2026-04-15T00:00:15.000Z',
          },
        ],
        outcome: {
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
            findingCount: 1,
            highestSeverity: 'high',
            highlights: [],
          },
        },
      },
      reviews: [
        {
          id: 'rev_1',
          workspaceId: 'ws_1',
          deploymentId: 'dep_1',
          target: {
            type: 'workspace_deployment',
            workspaceId: 'ws_1',
            deploymentId: 'dep_1',
          },
          mode: 'report_only',
          status: 'succeeded',
          idempotencyKey: 'idem_rev_1',
          attemptCount: 1,
          createdAt: '2026-04-15T00:00:00.000Z',
          updatedAt: '2026-04-15T00:00:15.000Z',
          startedAt: '2026-04-15T00:00:01.000Z',
          finishedAt: '2026-04-15T00:00:15.000Z',
          findings: [
            {
              id: 'finding_1',
              severity: 'high',
              confidence: 'high',
              title: 'Fallback path can hang',
              description: 'A fallback path can leave the request unresolved.',
              conditions: null,
              locations: [{ path: 'src/request.ts', line: 48 }],
              suggestedFix: { kind: 'text', value: 'Normalize terminal transitions.' },
              evidenceRefs: [],
            },
          ],
          evidence: [],
          provenance: {
            sessionIds: ['ses_aggregate'],
            promptSummary: null,
          },
          markdownSummary: null,
        },
      ],
      latestReview: {
        id: 'rev_1',
        workspaceId: 'ws_1',
        deploymentId: 'dep_1',
        target: {
          type: 'workspace_deployment',
          workspaceId: 'ws_1',
          deploymentId: 'dep_1',
        },
        mode: 'report_only',
        status: 'succeeded',
        idempotencyKey: 'idem_rev_1',
        attemptCount: 1,
        createdAt: '2026-04-15T00:00:00.000Z',
        updatedAt: '2026-04-15T00:00:15.000Z',
        startedAt: '2026-04-15T00:00:01.000Z',
        finishedAt: '2026-04-15T00:00:15.000Z',
        findings: [
          {
            id: 'finding_1',
            severity: 'high',
            confidence: 'high',
            title: 'Fallback path can hang',
            description: 'A fallback path can leave the request unresolved.',
            conditions: null,
            locations: [{ path: 'src/request.ts', line: 48 }],
            suggestedFix: { kind: 'text', value: 'Normalize terminal transitions.' },
            evidenceRefs: [],
          },
        ],
        evidence: [],
        provenance: {
          sessionIds: ['ses_aggregate'],
          promptSummary: null,
        },
        markdownSummary: null,
      },
      activeReview: null,
      findings: {
        unresolved: [
          {
            id: 'finding_1',
            severity: 'high',
            confidence: 'high',
            title: 'Fallback path can hang',
            description: 'A fallback path can leave the request unresolved.',
            conditions: null,
            locations: [{ path: 'src/request.ts', line: 48 }],
            suggestedFix: { kind: 'text', value: 'Normalize terminal transitions.' },
            evidenceRefs: [],
          },
        ],
        resolved: [],
        all: [],
      },
      activity: {
        sessionId: 'ses_aggregate',
        phase: 'completed',
        state: 'terminal',
        currentReviewStatus: null,
        activeReviewId: null,
        latestReviewId: 'rev_1',
        passCount: 1,
        summary: 'Nimbus completed the session.',
        detail: 'Nimbus completed the session.',
        canStream: false,
        streamPath: '/api/studio/sessions/ses_aggregate/activity/events',
        updatedAt: '2026-04-15T00:00:15.000Z',
      },
      reviewedDiff: {
        sessionId: 'ses_aggregate',
        reviewId: 'rev_1',
        available: false,
        status: 'unavailable',
        reason: 'No reviewed diff.',
        path: '/api/studio/sessions/ses_aggregate/reviewed-diff',
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
        self: '/api/studio/sessions/ses_aggregate',
        activity: '/api/studio/sessions/ses_aggregate/activity',
        activityEvents: '/api/studio/sessions/ses_aggregate/activity/events',
        reviewedDiff: '/api/studio/sessions/ses_aggregate/reviewed-diff',
        localEnvironments: '/api/studio/local-review-sessions?sessionId=ses_aggregate',
        adopt: '/api/studio/local-review-sessions/ses_aggregate/adopt',
      },
      adopt: {
        available: false,
        reason: 'No adoptable changes.',
        path: '/api/studio/local-review-sessions/ses_aggregate/adopt',
        modes: ['worktree'],
      },
    });

    expect(payload.latestReview?.findings[0]?.title).toBe('Fallback path can hang');
    expect(payload.latestReview?.findings[0]?.locations[0]?.filePath).toBe('src/request.ts');
    expect(payload.findings.unresolved[0]?.suggestedFix).toBe('Normalize terminal transitions.');
  });

  it('parses detail payload with outcome metadata', () => {
    const payload = parseGetReviewSessionResponse({
      session: {
        id: 'ses_2',
        workspaceId: 'ws_2',
        anchorDeploymentId: 'dep_2',
        repo: 'acme/web',
        branch: 'feature-x',
        initialReviewBasis: 'environment',
        anchorCommitSha: 'fedcba654321',
        anchorCheckpointId: null,
        sourceProjectRoot: '/Users/nickdejesus/Code/nimbus',
        phase: 'completed',
        passCount: 2,
        activeReviewId: null,
        latestReviewId: 'rev_2',
        currentReviewStatus: null,
        stopReason: 'followup_pass_completed',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:05.000Z',
        finishedAt: '2026-03-01T00:00:05.000Z',
        passes: [
          {
            reviewId: 'rev_1',
            status: 'succeeded',
            reviewBasis: 'checkpoint',
            createdAt: '2026-03-01T00:00:00.000Z',
            startedAt: '2026-03-01T00:00:01.000Z',
            finishedAt: '2026-03-01T00:00:02.000Z',
          },
          {
            reviewId: 'rev_2',
            status: 'succeeded',
            reviewBasis: 'environment',
            createdAt: '2026-03-01T00:00:03.000Z',
            startedAt: '2026-03-01T00:00:03.500Z',
            finishedAt: '2026-03-01T00:00:05.000Z',
          },
        ],
        outcome: {
          kind: 'clean',
          summary: 'No remaining findings after follow-up verification.',
          residualRisk: 'low',
          recommendation: 'approve',
          materializeReady: true,
          reviewed: {
            contextMode: 'intent_aware',
            latestReviewBasis: 'environment',
            passCount: 2,
          },
          changes: {
            applied: true,
            remediationCount: 1,
            changedFileCount: 2,
            summaries: ['Applied a small null-guard to request parsing.'],
            environmentRevision: null,
          },
          evidence: {
            passed: 2,
            failed: 0,
            warning: 0,
            info: 1,
            highlights: [],
          },
          unresolved: {
            findingCount: 0,
            highestSeverity: null,
            highlights: [],
          },
        },
      },
    });

    expect(payload.session.outcome?.materializeReady).toBe(true);
    expect(payload.session.outcome?.reviewed.latestReviewBasis).toBe('environment');
    expect(payload.session.outcome?.changes.changedFileCount).toBe(2);
  });
});
