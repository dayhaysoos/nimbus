import { z } from 'zod';

import type {
  ReviewAnalysisOutputV2,
  ReviewFindingCategory,
  ReviewFindingPassType,
  ReviewFindingSeverityV2,
} from '../types.js';

export const REVIEW_FINDING_SEVERITIES_V2: ReviewFindingSeverityV2[] = ['info', 'low', 'medium', 'high', 'critical'];
export const REVIEW_FINDING_CATEGORIES: ReviewFindingCategory[] = ['security', 'logic', 'style', 'breaking-change'];
export const REVIEW_FINDING_PASS_TYPES: ReviewFindingPassType[] = ['single', 'security', 'logic', 'style', 'breaking-change'];

export interface ReviewAnalysisValidationError {
  path: string;
  message: string;
}

type ValidationResult =
  | {
      ok: true;
      value: ReviewAnalysisOutputV2;
      dedupedExactCount: number;
    }
  | {
      ok: false;
      errors: ReviewAnalysisValidationError[];
    };

const STRING_WITH_CONTENT = z.string().transform((value) => value.trim()).pipe(z.string().min(1));
const NORMALIZED_PATH = z.string().transform((value) => value.trim().replaceAll('\\', '/')).pipe(z.string().min(1));

const locationSchema = z
  .object({
    filePath: NORMALIZED_PATH,
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
  })
  .superRefine((value, ctx) => {
    const hasNullPair = value.startLine === null && value.endLine === null;
    const hasIntegerPair = Number.isInteger(value.startLine) && Number.isInteger(value.endLine);
    if (!hasNullPair && !hasIntegerPair) {
      ctx.addIssue({
        code: 'custom',
        message: 'startLine/endLine must both be null or both be positive integers',
        path: [],
      });
      return;
    }
    if (hasIntegerPair && (value.endLine as number) < (value.startLine as number)) {
      ctx.addIssue({
        code: 'custom',
        message: 'endLine must be greater than or equal to startLine',
        path: [],
      });
    }
  });

function isValidationLikeFinding(text: string): boolean {
  return /\b(regex|normalize|normalization|validate|validation|pattern)\b/i.test(text);
}

function hasConcreteSampleAndOutcomeEvidence(failingScenario: string, evidence: string): boolean {
  const combined = `${failingScenario}\n${evidence}`;
  const hasConcreteSample =
    /\b(input|sample|string|value)\b/i.test(combined) || /`[^`]+`|'[^']+'|"[^"]+"/.test(combined);
  const hasOutcome = /\b(match|matches|reject|rejected|accept|accepted|return|returns|result|status|passes|fails)\b/i.test(
    combined
  );
  return hasConcreteSample && hasOutcome;
}

function isTimeoutBoundaryLikeFinding(text: string): boolean {
  return /\b(timeout|deadline|interval|boundary|poll)\b/i.test(text);
}

function hasBoundaryAndStatusEvidence(failingScenario: string, evidence: string): boolean {
  const combined = `${failingScenario}\n${evidence}`;
  const hasBoundary = /\b\d+\b|>=|<=|>|<|==|\b(deadline|interval|timeout|ms|second|seconds)\b/i.test(combined);
  const hasStatusOutcome = /\b(status|queued|running|succeeded|failed|cancelled|return|returns|result)\b/i.test(combined);
  return hasBoundary && hasStatusOutcome;
}

const findingSchema = z
  .object({
    severity: z.enum(REVIEW_FINDING_SEVERITIES_V2 as [ReviewFindingSeverityV2, ...ReviewFindingSeverityV2[]]),
    category: z.enum(REVIEW_FINDING_CATEGORIES as [ReviewFindingCategory, ...ReviewFindingCategory[]]),
    passType: z.literal('single'),
    locations: z.array(locationSchema).min(1),
    description: STRING_WITH_CONTENT,
    suggestedFix: STRING_WITH_CONTENT,
    failingScenario: STRING_WITH_CONTENT,
    evidence: STRING_WITH_CONTENT,
    guardGap: STRING_WITH_CONTENT,
  })
  .superRefine((value, ctx) => {
    const behaviorText = `${value.description}\n${value.suggestedFix}\n${value.failingScenario}`;
    if (isValidationLikeFinding(behaviorText) && !hasConcreteSampleAndOutcomeEvidence(value.failingScenario, value.evidence)) {
      ctx.addIssue({
        code: 'custom',
        message: 'validation/regex findings require concrete sample input and observed outcome in failingScenario/evidence',
        path: ['evidence'],
      });
    }
    if (isTimeoutBoundaryLikeFinding(behaviorText) && !hasBoundaryAndStatusEvidence(value.failingScenario, value.evidence)) {
      ctx.addIssue({
        code: 'custom',
        message: 'timeout/retry findings require explicit boundary values and resulting status in failingScenario/evidence',
        path: ['evidence'],
      });
    }
  });

const reviewAnalysisOutputV2Schema = z.object({
  findings: z.array(findingSchema),
  summary: STRING_WITH_CONTENT,
  furtherPassesLowYield: z.boolean(),
});

function issuePathToJsonPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) {
    return '$';
  }
  let full = '$';
  for (const segment of path) {
    if (typeof segment === 'number') {
      full += `[${segment}]`;
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      full += `.${segment}`;
    } else {
      full += `[${JSON.stringify(segment)}]`;
    }
  }
  return full;
}

export function validateAndNormalizeReviewAnalysisOutputV2(payload: unknown): ValidationResult {
  const parsed = reviewAnalysisOutputV2Schema.safeParse(payload);
  if (!parsed.success) {
    const errors: ReviewAnalysisValidationError[] = parsed.error.issues.map((issue) => ({
      path: issuePathToJsonPath(issue.path),
      message: issue.message,
    }));
    return { ok: false, errors };
  }

  const seen = new Set<string>();
  const dedupedFindings = parsed.data.findings.filter((finding) => {
    const key = JSON.stringify(finding);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return {
    ok: true,
    value: {
      findings: dedupedFindings,
      summary: parsed.data.summary,
      furtherPassesLowYield: parsed.data.furtherPassesLowYield,
    },
    dedupedExactCount: parsed.data.findings.length - dedupedFindings.length,
  };
}
