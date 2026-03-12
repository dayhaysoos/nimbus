export type ReviewSeverityThreshold = 'low' | 'medium' | 'high' | 'critical';

export function parseReviewSeverityThreshold(value: unknown): ReviewSeverityThreshold | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'critical') {
    return value;
  }
  throw new Error('Invalid --severity-threshold value. Use low, medium, high, or critical.');
}

export function parseReviewMaxFindings(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('Invalid --max-findings value. Use a positive integer.');
  }

  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new Error('Invalid --max-findings value. Use a positive integer.');
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error('Invalid --max-findings value. Use a positive integer.');
  }
  return parsed;
}
