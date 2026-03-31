import type { ReviewApprovedPolicy, ReviewSessionIntentSummary } from '../../types.js';
import { extractPolicyItemsFromIntentContext } from '../../lib/review-redaction.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringList(value: unknown, maxItems = 20): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        )
      ).slice(0, maxItems)
    : [];
}

function normalizePolicySentence(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractChangedPathsFromPatch(value: unknown, maxItems = 5): string[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  const matches = value.matchAll(/^diff --git a\/[^\n\r]+ b\/([^\n\r]+)$/gm);
  const paths = Array.from(matches, (match) => normalizePolicySentence(match[1] ?? ''))
    .filter(Boolean)
    .filter((path) => path !== '/dev/null');
  return Array.from(new Set(paths)).slice(0, maxItems);
}

function extractPolicyHintsFromProvenance(provenance: Record<string, unknown>): {
  goal: string | null;
  prohibitions: string[];
  constraints: string[];
} {
  const intentSessionContext = Array.isArray(provenance.intentSessionContext)
    ? provenance.intentSessionContext
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  const goalCandidates: string[] = [];
  const prohibitions: string[] = [];
  const constraints: string[] = [];

  for (const line of intentSessionContext) {
    const goalMatch = line.match(/^goal\s*signal\s*:\s*(.+)$/i);
    if (goalMatch) {
      const goalText = normalizePolicySentence(goalMatch[1] ?? '');
      if (goalText && !/^you are a code reviewer\b/i.test(goalText)) {
        goalCandidates.push(goalText);
      }
      continue;
    }

    const prohibitionMatch = line.match(/^prohibition\s*:\s*(.+)$/i);
    if (prohibitionMatch) {
      const text = normalizePolicySentence(prohibitionMatch[1] ?? '');
      if (text) {
        prohibitions.push(text);
      }
      continue;
    }

    const constraintMatch = line.match(/^constraint\s*:\s*(.+)$/i);
    if (constraintMatch) {
      const text = normalizePolicySentence(constraintMatch[1] ?? '');
      if (text) {
        constraints.push(text);
      }
    }
  }

  if (prohibitions.length === 0 || constraints.length === 0) {
    const policyHints = extractPolicyItemsFromIntentContext(intentSessionContext);
    for (const hint of policyHints) {
      if (/^prohibition\s*:/i.test(hint)) {
        const text = normalizePolicySentence(hint.replace(/^prohibition\s*:\s*/i, ''));
        if (text) {
          prohibitions.push(text);
        }
        continue;
      }
    }
  }

  const rawSessionPrompts = typeof provenance.rawSessionPrompts === 'string' ? provenance.rawSessionPrompts : '';
  const rawLines = rawSessionPrompts
    .split(/\r?\n/)
    .map((line) => normalizePolicySentence(line))
    .filter(Boolean);
  if (prohibitions.length === 0) {
    for (const line of rawLines) {
      if (/(?:\bdo not\b|\bdon't\b|\bmust not\b|\bnever\b|\bavoid\b)/i.test(line)) {
        prohibitions.push(line);
      }
    }
  }
  if (constraints.length === 0) {
    for (const line of rawLines) {
      if (/(?:\bfocus on\b|\bprefer\b|\bensure\b|\bkeep\b|\brequire\b|\bshould\b)/i.test(line)) {
        constraints.push(line);
      }
    }
  }

  if (constraints.length === 0) {
    const changedPaths = extractChangedPathsFromPatch(provenance.commitDiffPatch, 5);
    for (const path of changedPaths) {
      constraints.push(`Prioritize review coverage for changed file: ${path}`);
    }
  }

  return {
    goal: goalCandidates[0] ?? null,
    prohibitions: normalizeStringList(prohibitions, 5),
    constraints: normalizeStringList(constraints, 5),
  };
}

export function normalizeIntentSummaryModel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) {
    return undefined;
  }
  return trimmed;
}

export function normalizeReviewPolicy(value: unknown): ReviewApprovedPolicy | null {
  if (!isRecord(value)) {
    return null;
  }

  const goal = typeof value.goal === 'string' && value.goal.trim() ? value.goal.trim() : null;
  const policy: ReviewApprovedPolicy = {
    goal,
    prohibitions: normalizeStringList(value.prohibitions),
    constraints: normalizeStringList(value.constraints),
  };

  if (!policy.goal && policy.prohibitions.length === 0 && policy.constraints.length === 0) {
    return null;
  }

  return policy;
}

export function policyFromIntentSummary(summary: ReviewSessionIntentSummary | null): ReviewApprovedPolicy | null {
  if (!summary) {
    return null;
  }

  return normalizeReviewPolicy({
    goal: summary.goal,
    prohibitions: summary.prohibitions,
    constraints: summary.constraints,
  });
}

export function intentSummaryFromPolicy(policy: ReviewApprovedPolicy): ReviewSessionIntentSummary {
  return {
    goal: policy.goal,
    prohibitions: policy.prohibitions,
    constraints: policy.constraints,
  };
}

export function fallbackDerivedPolicy(input: {
  workspaceId: string;
  deploymentId: string;
  provenance: Record<string, unknown>;
}): ReviewApprovedPolicy {
  const hints = extractPolicyHintsFromProvenance(input.provenance);
  const note = typeof input.provenance.note === 'string' && input.provenance.note.trim() ? input.provenance.note.trim() : null;
  const goal = hints.goal ?? note ?? `Review deployment ${input.deploymentId} for workspace ${input.workspaceId}.`;
  return (
    normalizeReviewPolicy({
      goal,
      prohibitions: hints.prohibitions,
      constraints: hints.constraints,
    }) ?? {
      goal,
      prohibitions: [],
      constraints: [],
    }
  );
}
