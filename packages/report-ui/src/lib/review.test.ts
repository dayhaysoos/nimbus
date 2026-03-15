import { describe, expect, it } from 'vitest';
import { buildFixPrompt, buildFindingText, findingCount, parseGetReviewResponse } from './review';
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
