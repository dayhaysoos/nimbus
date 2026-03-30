import type { ReviewFinding } from '../../../types.js';

export const REVIEW_SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
  info: 0,
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export const LARGE_DIFF_ADVISORY_THRESHOLD = 30;
export const DEFAULT_REVIEW_ANALYSIS_TIMEOUT_MS = 4 * 60 * 1000;

export function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return fallback;
}

export function parsePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export function parseTimeoutMs(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  createError: () => Error
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(createError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}
