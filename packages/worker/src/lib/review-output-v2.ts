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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/');
}

function addError(errors: ReviewAnalysisValidationError[], path: string, message: string): void {
  errors.push({ path, message });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateEnum<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  errors: ReviewAnalysisValidationError[],
  path: string,
  label: string
): T | null {
  if (typeof value !== 'string') {
    addError(errors, path, `${label} must be a string enum value`);
    return null;
  }
  const trimmed = value.trim();
  if (!allowedValues.includes(trimmed as T)) {
    addError(errors, path, `${label} must be one of: ${allowedValues.join(', ')}`);
    return null;
  }
  return trimmed as T;
}

function validateNonEmptyString(
  value: unknown,
  errors: ReviewAnalysisValidationError[],
  path: string,
  fieldName: string
): string | null {
  if (typeof value !== 'string') {
    addError(errors, path, `${fieldName} must be a string`);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    addError(errors, path, `${fieldName} must not be empty`);
    return null;
  }
  return trimmed;
}

export function validateAndNormalizeReviewAnalysisOutputV2(payload: unknown): ValidationResult {
  const errors: ReviewAnalysisValidationError[] = [];
  if (!isRecord(payload)) {
    return {
      ok: false,
      errors: [{ path: '$', message: 'Output must be a JSON object' }],
    };
  }

  const findingsValue = payload.findings;
  if (!Array.isArray(findingsValue)) {
    addError(errors, '$.findings', 'findings must be an array');
  }

  const summary = validateNonEmptyString(payload.summary, errors, '$.summary', 'summary');
  if (typeof payload.furtherPassesLowYield !== 'boolean') {
    addError(errors, '$.furtherPassesLowYield', 'furtherPassesLowYield must be a boolean');
  }

  const normalizedFindings = Array.isArray(findingsValue)
    ? findingsValue.flatMap((findingValue, findingIndex) => {
        const findingPath = `$.findings[${findingIndex}]`;
        if (!isRecord(findingValue)) {
          addError(errors, findingPath, 'finding must be an object');
          return [];
        }

        const severity = validateEnum(
          findingValue.severity,
          REVIEW_FINDING_SEVERITIES_V2,
          errors,
          `${findingPath}.severity`,
          'severity'
        );
        const category = validateEnum(
          findingValue.category,
          REVIEW_FINDING_CATEGORIES,
          errors,
          `${findingPath}.category`,
          'category'
        );
        const passType = validateEnum(
          findingValue.passType,
          REVIEW_FINDING_PASS_TYPES,
          errors,
          `${findingPath}.passType`,
          'passType'
        );
        if (passType && passType !== 'single') {
          addError(errors, `${findingPath}.passType`, 'passType must be "single" in Phase 2');
        }
        const description = validateNonEmptyString(
          findingValue.description,
          errors,
          `${findingPath}.description`,
          'description'
        );
        const suggestedFix = validateNonEmptyString(
          findingValue.suggestedFix,
          errors,
          `${findingPath}.suggestedFix`,
          'suggestedFix'
        );

        const locationsValue = findingValue.locations;
        if (!Array.isArray(locationsValue)) {
          addError(errors, `${findingPath}.locations`, 'locations must be an array');
          return [];
        }
        if (locationsValue.length === 0) {
          addError(errors, `${findingPath}.locations`, 'locations must contain at least one entry');
        }

        const locations = locationsValue.flatMap((locationValue, locationIndex) => {
          const locationPath = `${findingPath}.locations[${locationIndex}]`;
          if (!isRecord(locationValue)) {
            addError(errors, locationPath, 'location must be an object');
            return [];
          }

          const filePathRaw = locationValue.filePath;
          if (typeof filePathRaw !== 'string') {
            addError(errors, `${locationPath}.filePath`, 'filePath must be a string');
            return [];
          }
          const filePath = normalizePath(filePathRaw);
          if (!filePath) {
            addError(errors, `${locationPath}.filePath`, 'filePath must not be empty');
            return [];
          }

          const startLine = locationValue.startLine;
          const endLine = locationValue.endLine;
          const hasNullPair = startLine === null && endLine === null;
          const hasIntegerPair = isPositiveInteger(startLine) && isPositiveInteger(endLine);

          if (!hasNullPair && !hasIntegerPair) {
            addError(
              errors,
              `${locationPath}`,
              'startLine/endLine must both be null or both be positive integers'
            );
            return [];
          }

          if (hasIntegerPair && (endLine as number) < (startLine as number)) {
            addError(errors, `${locationPath}`, 'endLine must be greater than or equal to startLine');
            return [];
          }

          return [
            {
              filePath,
              startLine: hasNullPair ? null : (startLine as number),
              endLine: hasNullPair ? null : (endLine as number),
            },
          ];
        });

        if (!severity || !category || !passType || !description || !suggestedFix || locations.length === 0) {
          return [];
        }

        return [
          {
            severity,
            category,
            passType,
            locations,
            description,
            suggestedFix,
          },
        ];
      })
    : [];

  if (errors.length > 0 || summary === null || !Array.isArray(findingsValue) || typeof payload.furtherPassesLowYield !== 'boolean') {
    return {
      ok: false,
      errors,
    };
  }

  const seen = new Set<string>();
  const dedupedFindings = normalizedFindings.filter((finding) => {
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
      summary,
      furtherPassesLowYield: payload.furtherPassesLowYield,
    },
    dedupedExactCount: normalizedFindings.length - dedupedFindings.length,
  };
}
