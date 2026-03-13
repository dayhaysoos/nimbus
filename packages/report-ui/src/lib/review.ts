import type { ReviewFinding, ReviewResponse } from '../types';

export const DEFAULT_COUNTS = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
};

function defaultText(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function findingLocationsText(finding: ReviewFinding): string {
  if (!finding.locations.length) {
    return 'none provided';
  }

  return finding.locations.map((location) => `${location.path}:${location.line}`).join(', ');
}

export function findingEvidenceRefsText(finding: ReviewFinding): string {
  if (!finding.evidenceRefs.length) {
    return 'none provided';
  }

  return finding.evidenceRefs.join(', ');
}

export function buildFindingText(finding: ReviewFinding): string {
  return [
    `Finding title: ${finding.title}`,
    `Severity: ${finding.severity}`,
    `Confidence: ${finding.confidence}`,
    'Description:',
    finding.description,
    '',
    'Conditions:',
    defaultText(finding.conditions, 'none provided'),
    '',
    'Locations:',
    findingLocationsText(finding),
    '',
    'Suggested fix:',
    defaultText(finding.suggestedFix?.value, 'not provided'),
    '',
    'Evidence refs:',
    findingEvidenceRefsText(finding),
  ].join('\n');
}

export function buildFixPrompt(finding: ReviewFinding): string {
  return [
    'You are helping fix a Nimbus code review finding.',
    '',
    `Finding title: ${finding.title}`,
    `Severity: ${finding.severity}`,
    `Confidence: ${finding.confidence}`,
    'Description:',
    finding.description,
    '',
    'Conditions:',
    defaultText(finding.conditions, 'none provided'),
    '',
    'Locations:',
    findingLocationsText(finding),
    '',
    'Suggested fix:',
    defaultText(finding.suggestedFix?.value, 'not provided'),
    '',
    'Evidence refs:',
    findingEvidenceRefsText(finding),
    '',
    'Please:',
    '1) Propose a minimal safe code change.',
    '2) Explain why it resolves the issue.',
    '3) List any tests to run.',
    '4) Return a patch-style diff when possible.',
  ].join('\n');
}

export function findingCount(review: ReviewResponse): number {
  if (review.summary?.findingCounts) {
    return Object.values(review.summary.findingCounts).reduce((total, value) => total + value, 0);
  }

  return review.findings.length;
}

export function recommendationLabel(value: string | undefined): string {
  if (!value) {
    return 'unknown';
  }

  return value.replace('_', ' ');
}

export function dateTimeLabel(value: string | null): string {
  if (!value) {
    return 'n/a';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
