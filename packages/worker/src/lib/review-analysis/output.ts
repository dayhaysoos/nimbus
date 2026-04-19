import type { ReviewAnalysisOutputV2 } from '../../types.js';
import { validateAndNormalizeReviewAnalysisOutputV2 } from '../review-output-v2.js';
import { redactReviewText } from '../review-redaction.js';
import { asRecord, asStringArray, extractJsonObject, stripCodeFences } from './helpers.js';

export interface ReviewAgentIntent {
  goal: string | null;
  constraints: string[];
  decisions: string[];
}

export class ReviewAgentOutputError extends Error {
  code: string;
  details: Record<string, unknown> | null;

  constructor(message: string) {
    super(message);
    this.name = 'ReviewAgentOutputError';
    this.code = 'review_analysis_invalid_output';
    this.details = null;
  }

  withCode(code: string, details?: Record<string, unknown>): ReviewAgentOutputError {
    this.code = code;
    this.details = details ?? null;
    return this;
  }
}

export function normalizeIntent(value: unknown): ReviewAgentIntent | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }

  return {
    goal: typeof record.goal === 'string' && record.goal.trim() ? record.goal.trim() : null,
    constraints: asStringArray(record.constraints).map((item) => item.trim()).filter(Boolean),
    decisions: asStringArray(record.decisions).map((item) => item.trim()).filter(Boolean),
  };
}

export function parseJsonOutput(summary: string): unknown {
  try {
    return JSON.parse(extractJsonObject(summary)) as unknown;
  } catch {
    const summaryText = stripCodeFences(summary).trim();
    throw new ReviewAgentOutputError(
      summaryText
        ? `Review agent returned malformed final output: ${summaryText.slice(0, 240)}`
        : 'Review agent returned malformed final output'
    ).withCode('review_analysis_invalid_output');
  }
}

export function validateOutputOrThrow(payload: unknown): { output: ReviewAnalysisOutputV2; dedupedExactCount: number } {
  const validated = validateAndNormalizeReviewAnalysisOutputV2(payload);
  if (!validated.ok) {
    throw new ReviewAgentOutputError('Review agent output does not match required schema').withCode(
      'review_analysis_invalid_output',
      { errors: validated.errors }
    );
  }
  return { output: validated.value, dedupedExactCount: validated.dedupedExactCount };
}

export function extractValidationErrors(error: ReviewAgentOutputError | null): Array<{ path: string; message: string }> {
  if (!error?.details || !Array.isArray(error.details.errors)) {
    return [];
  }
  return error.details.errors
    .map((item) => {
      const record = asRecord(item);
      const path = typeof record.path === 'string' ? record.path : '';
      const message = typeof record.message === 'string' ? record.message : '';
      return path && message ? { path, message } : null;
    })
    .filter((item): item is { path: string; message: string } => Boolean(item))
    .slice(0, 20);
}

export function buildFallbackAnalysisOutput(reason: string): ReviewAnalysisOutputV2 {
  return {
    findings: [],
    summary: `Structured model output was invalid after repair (${reason}); emitted fallback empty findings output.`,
    furtherPassesLowYield: true,
  };
}

export function isGenericProviderCompletionSummary(summary: string): boolean {
  return /completed by .*agent endpoint/i.test(summary.trim());
}

export function sanitizeErrorMessage(
  input: string,
  options?: { openrouterApiKey?: string | null; providerApiKey?: string | null }
): string {
  let sanitized = redactReviewText(input) ?? '';
  const providerApiKey = options?.providerApiKey?.trim();
  if (providerApiKey) {
    sanitized = sanitized.split(providerApiKey).join('[REDACTED_PROVIDER_API_KEY]');
  }
  const openrouterApiKey = options?.openrouterApiKey?.trim();
  if (openrouterApiKey) {
    sanitized = sanitized.split(openrouterApiKey).join('[REDACTED_OPENROUTER_API_KEY]');
  }
  return sanitized;
}

export function isWorkerToWorkerFetchRestriction(status: number, responseBody: string): boolean {
  return status === 404 && /error\s*code\s*:\s*1042/i.test(responseBody);
}

export function isMissingOpenRouterApiKeyError(responseBody: string): boolean {
  if (!responseBody.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    const errorCode = typeof parsed.error === 'string' ? parsed.error : '';
    const details = asRecord(parsed.details);
    const detailsMessage = typeof details.message === 'string' ? details.message : '';
    return errorCode === 'missing_openrouter_api_key' || /openrouter_api_key\s+is\s+required/i.test(detailsMessage);
  } catch {
    return /missing_openrouter_api_key|openrouter_api_key\s+is\s+required/i.test(responseBody);
  }
}

export function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError') {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes('timeout') || message.includes('timed out') || message.includes('aborted');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
