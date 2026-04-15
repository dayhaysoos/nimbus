import type { ReviewFinding, ReviewFindingCategory, ReviewFindingSeverityV2, ReviewRunResponse } from '../../types.js';

const LINE_BUCKET_SIZE = 5;
const MAX_DESCRIPTION_FINGERPRINT_CHARS = 120;
const MAX_MEMORY_ENTRIES = 8;

export interface SessionFindingMemoryEntry {
  fingerprint: string;
  severity: ReviewFindingSeverityV2;
  category: ReviewFindingCategory;
  description: string;
  filePath: string | null;
  startLine: number | null;
  firstSeenPassIndex: number;
  lastSeenPassIndex: number;
  occurrenceCount: number;
}

export interface SessionFindingMemory {
  schema: 'v1';
  remediationSourceReviewId: string;
  sourcePassIndex: number;
  sourceOpenFindings: SessionFindingMemoryEntry[];
  remediationTargets: SessionFindingMemoryEntry[];
  repeatedTargets: SessionFindingMemoryEntry[];
  previouslyResolvedFindings: SessionFindingMemoryEntry[];
}

export interface SessionFindingProgress {
  sourceFindingCount: number;
  currentFindingCount: number;
  remediationTargetCount: number;
  repeatedTargetCount: number;
  resolvedTargetCount: number;
  repeatedSourceCount: number;
  newFindingCount: number;
  noProgressAfterRemediation: boolean;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bucketLine(startLine: number | null): string {
  if (!startLine || !Number.isFinite(startLine) || startLine < 1) {
    return '?';
  }
  const bucketFloor = Math.floor((startLine - 1) / LINE_BUCKET_SIZE) * LINE_BUCKET_SIZE + 1;
  return String(bucketFloor);
}

function primaryLocation(finding: ReviewFinding): { filePath: string | null; startLine: number | null } {
  const location = finding.locations[0];
  if (!location) {
    return { filePath: null, startLine: null };
  }
  return {
    filePath: location.filePath?.trim() || null,
    startLine: typeof location.startLine === 'number' && Number.isFinite(location.startLine) ? location.startLine : null,
  };
}

export function fingerprintReviewFinding(finding: ReviewFinding): string {
  const location = primaryLocation(finding);
  return [
    finding.category,
    (location.filePath ?? '?').toLowerCase(),
    bucketLine(location.startLine),
    normalizeText(finding.description).slice(0, MAX_DESCRIPTION_FINGERPRINT_CHARS),
  ].join('|');
}

function entrySort(left: SessionFindingMemoryEntry, right: SessionFindingMemoryEntry): number {
  return (
    right.occurrenceCount - left.occurrenceCount ||
    left.firstSeenPassIndex - right.firstSeenPassIndex ||
    left.description.localeCompare(right.description)
  );
}

function summarizeFindings(findings: ReviewFinding[], passIndex: number): Map<string, SessionFindingMemoryEntry> {
  const summaries = new Map<string, SessionFindingMemoryEntry>();
  for (const finding of findings) {
    const fingerprint = fingerprintReviewFinding(finding);
    const existing = summaries.get(fingerprint);
    const location = primaryLocation(finding);
    if (existing) {
      existing.lastSeenPassIndex = Math.max(existing.lastSeenPassIndex, passIndex);
      existing.occurrenceCount += 1;
      continue;
    }
    summaries.set(fingerprint, {
      fingerprint,
      severity: finding.severity,
      category: finding.category,
      description: finding.description.trim(),
      filePath: location.filePath,
      startLine: location.startLine,
      firstSeenPassIndex: passIndex,
      lastSeenPassIndex: passIndex,
      occurrenceCount: 1,
    });
  }
  return summaries;
}

function summarizeReviewHistory(reviews: ReviewRunResponse[]): Map<string, SessionFindingMemoryEntry> {
  const summaries = new Map<string, SessionFindingMemoryEntry>();
  reviews.forEach((review, index) => {
    const passIndex = index + 1;
    const passFindings = summarizeFindings(review.findings, passIndex);
    for (const [fingerprint, finding] of passFindings) {
      const existing = summaries.get(fingerprint);
      if (existing) {
        existing.lastSeenPassIndex = Math.max(existing.lastSeenPassIndex, finding.lastSeenPassIndex);
        existing.occurrenceCount += finding.occurrenceCount;
        continue;
      }
      summaries.set(fingerprint, { ...finding });
    }
  });
  return summaries;
}

function selectEntries(source: Iterable<SessionFindingMemoryEntry>, maxEntries = MAX_MEMORY_ENTRIES): SessionFindingMemoryEntry[] {
  return [...source].sort(entrySort).slice(0, maxEntries);
}

export function buildSessionFindingMemory(input: {
  sessionReviews: ReviewRunResponse[];
  remediationSourceReviewId: string;
  remediationTargets: ReviewFinding[];
}): SessionFindingMemory | null {
  const sourceIndex = input.sessionReviews.findIndex((review) => review.id === input.remediationSourceReviewId);
  if (sourceIndex < 0) {
    return null;
  }

  const sourceReview = input.sessionReviews[sourceIndex];
  const priorReviews = input.sessionReviews.slice(0, sourceIndex);
  const priorHistory = summarizeReviewHistory(priorReviews);
  const sourceOpen = summarizeFindings(sourceReview.findings, sourceIndex + 1);
  const remediationTargets = summarizeFindings(input.remediationTargets, sourceIndex + 1);
  const repeatedTargets = [...remediationTargets.values()].filter((entry) => priorHistory.has(entry.fingerprint));
  const previouslyResolvedFindings = [...priorHistory.values()].filter((entry) => !sourceOpen.has(entry.fingerprint));

  return {
    schema: 'v1',
    remediationSourceReviewId: input.remediationSourceReviewId,
    sourcePassIndex: sourceIndex + 1,
    sourceOpenFindings: selectEntries(sourceOpen.values()),
    remediationTargets: selectEntries(remediationTargets.values()),
    repeatedTargets: selectEntries(repeatedTargets),
    previouslyResolvedFindings: selectEntries(previouslyResolvedFindings),
  };
}

function isMemoryEntry(value: unknown): value is SessionFindingMemoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.fingerprint === 'string' &&
    typeof entry.severity === 'string' &&
    typeof entry.category === 'string' &&
    typeof entry.description === 'string' &&
    (typeof entry.filePath === 'string' || entry.filePath === null) &&
    (typeof entry.startLine === 'number' || entry.startLine === null) &&
    typeof entry.firstSeenPassIndex === 'number' &&
    typeof entry.lastSeenPassIndex === 'number' &&
    typeof entry.occurrenceCount === 'number'
  );
}

function normalizeMemoryEntries(value: unknown): SessionFindingMemoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isMemoryEntry).slice(0, MAX_MEMORY_ENTRIES);
}

export function readSessionFindingMemory(value: unknown): SessionFindingMemory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== 'v1' || typeof record.remediationSourceReviewId !== 'string' || typeof record.sourcePassIndex !== 'number') {
    return null;
  }
  return {
    schema: 'v1',
    remediationSourceReviewId: record.remediationSourceReviewId.trim(),
    sourcePassIndex: Math.max(1, Math.floor(record.sourcePassIndex)),
    sourceOpenFindings: normalizeMemoryEntries(record.sourceOpenFindings),
    remediationTargets: normalizeMemoryEntries(record.remediationTargets),
    repeatedTargets: normalizeMemoryEntries(record.repeatedTargets),
    previouslyResolvedFindings: normalizeMemoryEntries(record.previouslyResolvedFindings),
  };
}

export function deriveSessionFindingProgress(
  memory: SessionFindingMemory,
  currentFindings: ReviewFinding[]
): SessionFindingProgress {
  const currentFingerprints = new Set(currentFindings.map((finding) => fingerprintReviewFinding(finding)));
  const sourceFingerprints = new Set(memory.sourceOpenFindings.map((entry) => entry.fingerprint));
  const remediationTargetFingerprints = new Set(memory.remediationTargets.map((entry) => entry.fingerprint));

  let repeatedSourceCount = 0;
  let repeatedTargetCount = 0;
  for (const fingerprint of currentFingerprints) {
    if (sourceFingerprints.has(fingerprint)) {
      repeatedSourceCount += 1;
    }
    if (remediationTargetFingerprints.has(fingerprint)) {
      repeatedTargetCount += 1;
    }
  }

  let resolvedTargetCount = 0;
  for (const fingerprint of remediationTargetFingerprints) {
    if (!currentFingerprints.has(fingerprint)) {
      resolvedTargetCount += 1;
    }
  }

  let newFindingCount = 0;
  for (const fingerprint of currentFingerprints) {
    if (!sourceFingerprints.has(fingerprint)) {
      newFindingCount += 1;
    }
  }

  return {
    sourceFindingCount: sourceFingerprints.size,
    currentFindingCount: currentFingerprints.size,
    remediationTargetCount: remediationTargetFingerprints.size,
    repeatedTargetCount,
    resolvedTargetCount,
    repeatedSourceCount,
    newFindingCount,
    noProgressAfterRemediation:
      remediationTargetFingerprints.size > 0 &&
      repeatedTargetCount === remediationTargetFingerprints.size &&
      resolvedTargetCount === 0,
  };
}
