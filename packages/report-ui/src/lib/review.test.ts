import { describe, expect, it } from 'vitest';
import { buildFixPrompt, buildFindingText, findingCount } from './review';
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
      status: 'succeeded',
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
      markdownSummary: null,
    } satisfies ReviewResponse;

    expect(findingCount(review)).toBe(10);
  });
});
