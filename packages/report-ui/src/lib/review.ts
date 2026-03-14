import type { ReviewFinding, ReviewResponse } from '../types';

export const DEFAULT_COUNTS = {
  info: 0,
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

  return finding.locations
    .map((location) => {
      if (location.startLine !== null && location.endLine !== null) {
        return `${location.filePath}:${location.startLine}-${location.endLine}`;
      }
      return location.filePath;
    })
    .join(', ');
}

export function buildFindingText(finding: ReviewFinding): string {
  return [
    `Category: ${finding.category}`,
    `Pass type: ${finding.passType}`,
    `Severity: ${finding.severity}`,
    'Description:',
    finding.description,
    '',
    'Locations:',
    findingLocationsText(finding),
    '',
    'Suggested fix:',
    defaultText(finding.suggestedFix, 'not provided'),
  ].join('\n');
}

export function buildFixPrompt(finding: ReviewFinding): string {
  return [
    'You are helping fix a Nimbus code review finding.',
    '',
    `Category: ${finding.category}`,
    `Pass type: ${finding.passType}`,
    `Severity: ${finding.severity}`,
    'Description:',
    finding.description,
    '',
    'Locations:',
    findingLocationsText(finding),
    '',
    'Suggested fix:',
    defaultText(finding.suggestedFix, 'not provided'),
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
