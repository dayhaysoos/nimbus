import { describe, expect, it } from 'vitest';
import {
  buildFixPrompt,
  buildFindingText,
  findingCount,
  parseGetReviewResponse,
  parseListReviewsResponse,
  parseStudioContextResponse,
  parseStudioNewReviewPreflightResponse,
  parseStudioNewReviewStartResponse,
  parseStudioNewReviewStartStreamEvent,
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
    expect(payload.checks[0]?.code).toBe('checkpoint');
  });

  it('parses start payload', () => {
    const payload = parseStudioNewReviewStartResponse({
      reviewId: 'rev_123',
      routePath: '/branches/acme%2Fweb/main/reports/rev_123',
      policyMode: 'auto',
      status: 'queued',
    });

    expect(payload.reviewId).toBe('rev_123');
    expect(payload.routePath).toBe('/branches/acme%2Fweb/main/reports/rev_123');
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
