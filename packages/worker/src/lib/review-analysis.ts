import type {
  Env,
  ReviewContext,
  ReviewFinding,
} from '../types.js';
import {
  asRecord,
  parseIntegerString,
  readOptionalString,
  extractJsonObject,
  stripCodeFences,
} from './review-analysis/helpers.js';
import {
  buildFallbackAnalysisOutput,
  extractValidationErrors,
  isGenericProviderCompletionSummary,
  normalizeIntent,
  parseJsonOutput,
  ReviewAgentOutputError,
  sanitizeErrorMessage,
  validateOutputOrThrow,
} from './review-analysis/output.js';
import {
  hydrateReviewSandbox,
  resolveReviewSandbox,
  setReviewAnalysisSandboxResolverForTests,
  type SandboxClient,
  WORKSPACE_ROOT,
} from './review-analysis/sandbox.js';
import {
  buildReviewAgentPrompt,
  sanitizePromptInput,
  type ReviewAgentPromptInput,
} from './review-analysis/prompt.js';
import {
  buildToolHistoryLabel,
  executeReviewTool,
  sanitizeToolContext,
  snapshotInitialContext,
  validateReviewAgentAction,
  type ReviewCommandPolicy,
} from './review-analysis/tools.js';
import {
  CloudflareAgentSdkReviewProvider,
  type ReviewAgentHistoryEntry,
} from './review-analysis/provider.js';

const DEFAULT_REVIEW_AGENT_MAX_STEPS = 6;
const DEFAULT_REVIEW_MAX_FILE_BYTES = 48_000;
const DEFAULT_REVIEW_MAX_OUTPUT_BYTES = 96_000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_REVIEW_MODEL = 'sonnet-4.5';

export interface ReviewAgentIntent {
  goal: string | null;
  constraints: string[];
  decisions: string[];
}

export interface ReviewAgentAnalysisResult {
  findings: ReviewFinding[];
  summary: string;
  furtherPassesLowYield: boolean;
  intent: ReviewAgentIntent | null;
  provider: string;
  model: string;
  stepsExecuted: number;
  usedTools: string[];
  validation: {
    firstPassValid: boolean;
    repairAttempted: boolean;
    repairSucceeded: boolean;
    validationErrorCount: number;
    dedupedExactCount: number;
    fallbackApplied: boolean;
    fallbackReason: string | null;
  };
}

export interface ReviewSourceFileReadResult {
  path: string;
  content: string | null;
  bytes: number;
  truncated: boolean;
  error: string | null;
}

export { extractJsonObject, stripCodeFences } from './review-analysis/helpers.js';
export { setReviewAnalysisSandboxResolverForTests } from './review-analysis/sandbox.js';

/**
 * Hydrates a temporary sandbox from a stored source bundle and reads a bounded set of files
 * through the same read-only tool path used by review analysis.
 */
export async function readWorkspaceFilesFromSourceBundle(
  env: Env,
  input: {
    sourceBundleKey: string;
    sandboxId: string;
    paths: string[];
    maxFileBytes?: number;
  }
): Promise<ReviewSourceFileReadResult[]> {
  const maxFileBytes = parseIntegerString(env.REVIEW_AGENT_MAX_FILE_BYTES, DEFAULT_REVIEW_MAX_FILE_BYTES, 1_024, 200_000);
  const effectiveMaxFileBytes =
    typeof input.maxFileBytes === 'number' && Number.isFinite(input.maxFileBytes)
      ? Math.max(1_024, Math.min(maxFileBytes, Math.floor(input.maxFileBytes)))
      : maxFileBytes;

  if (!env.WORKSPACE_ARTIFACTS && !env.SOURCE_BUNDLES) {
    throw new Error('WORKSPACE_ARTIFACTS or SOURCE_BUNDLES binding is required for review context assembly');
  }
  const bundle =
    (env.WORKSPACE_ARTIFACTS ? await env.WORKSPACE_ARTIFACTS.get(input.sourceBundleKey) : null) ??
    (env.SOURCE_BUNDLES ? await env.SOURCE_BUNDLES.get(input.sourceBundleKey) : null);
  if (!bundle) {
    throw new Error(`Review source bundle not found: ${input.sourceBundleKey}`);
  }

  const sandbox = await resolveReviewSandbox(env, input.sandboxId);
  try {
    await hydrateReviewSandbox(sandbox, await bundle.arrayBuffer());

    const policy: ReviewCommandPolicy = {
      commandAllow: [],
      commandDeny: [],
      maxCommandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_REVIEW_MAX_OUTPUT_BYTES,
      rootPath: WORKSPACE_ROOT,
    };

    const uniquePaths = Array.from(new Set(input.paths.map((path) => path.trim()).filter(Boolean)));
    const results: ReviewSourceFileReadResult[] = [];
    for (const path of uniquePaths) {
      const toolResult = await executeReviewTool(
        sandbox,
        { type: 'tool', tool: 'read_file', args: { path, maxBytes: effectiveMaxFileBytes } },
        policy,
        effectiveMaxFileBytes
      );
      const resultRecord = asRecord(toolResult.result);
      const error = typeof resultRecord.error === 'string' ? resultRecord.error : null;
      const content = typeof resultRecord.content === 'string' ? resultRecord.content : null;
      const bytes = typeof resultRecord.bytes === 'number' && Number.isFinite(resultRecord.bytes)
        ? Math.max(0, Math.floor(resultRecord.bytes))
        : 0;
      const truncated = Boolean(resultRecord.truncated);
      results.push({ path, content, bytes, truncated, error });
    }

    return results;
  } finally {
    if (typeof sandbox.destroy === 'function') {
      try {
        await sandbox.destroy();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

/**
 * Runs the model-backed review analysis loop against a hydrated deployment snapshot using
 * the read-only review tools and strict structured-output validation.
 */
export async function runWorkspaceDeploymentAgentAnalysis(
  env: Env,
  input: ReviewAgentPromptInput & {
    deploymentSandboxId: string;
    modelOverride?: string;
  }
): Promise<ReviewAgentAnalysisResult | null> {
  const endpoint = (env.AGENT_SDK_URL ?? '').trim();
  if (!endpoint) {
    return null;
  }

  const model =
    readOptionalString(input.modelOverride) ??
    readOptionalString(env.REVIEW_MODEL) ??
    readOptionalString(env.AGENT_MODEL) ??
    DEFAULT_REVIEW_MODEL;
  const authToken = (env.AGENT_SDK_AUTH_TOKEN ?? '').trim() || null;
  let endpointHost: string | null = null;
  let endpointPath: string | null = null;
  try {
    const parsedEndpoint = new URL(endpoint);
    endpointHost = parsedEndpoint.host;
    endpointPath = parsedEndpoint.pathname;
  } catch {
    endpointHost = null;
    endpointPath = null;
  }

  const maxSteps = parseIntegerString(env.REVIEW_AGENT_MAX_STEPS, DEFAULT_REVIEW_AGENT_MAX_STEPS, 1, 12);
  const maxFileBytes = parseIntegerString(env.REVIEW_AGENT_MAX_FILE_BYTES, DEFAULT_REVIEW_MAX_FILE_BYTES, 1_024, 200_000);
  if (!env.WORKSPACE_ARTIFACTS && !env.SOURCE_BUNDLES) {
    throw new Error('WORKSPACE_ARTIFACTS or SOURCE_BUNDLES binding is required for review analysis');
  }
  const bundle =
    (env.WORKSPACE_ARTIFACTS ? await env.WORKSPACE_ARTIFACTS.get(input.sourceBundleKey) : null) ??
    (env.SOURCE_BUNDLES ? await env.SOURCE_BUNDLES.get(input.sourceBundleKey) : null);
  if (!bundle) {
    throw new Error(`Review source bundle not found: ${input.sourceBundleKey}`);
  }

  const sandbox = await resolveReviewSandbox(env, input.deploymentSandboxId);
  try {
    await hydrateReviewSandbox(sandbox, await bundle.arrayBuffer());
    const { rootListing, diffSnapshot } = await snapshotInitialContext(sandbox, maxFileBytes);
    const prompt = buildReviewAgentPrompt(
      sanitizePromptInput({
        ...input,
        rootListing,
        diffSnapshot,
      })
    );
    if (input.onLifecycleEvent) {
      await input.onLifecycleEvent('review_analysis_prompt_built', {
        reviewContextId: input.reviewContext.id,
      });
    }

    const provider = new CloudflareAgentSdkReviewProvider(
      endpoint,
      authToken,
      env.AGENT_ENDPOINT ?? null,
      readOptionalString(input.openrouterApiKey),
      validateReviewAgentAction
    );
    const policy: ReviewCommandPolicy = {
      commandAllow: [],
      commandDeny: ['git ', 'rm ', 'npm ', 'pnpm ', 'yarn ', 'bun ', 'mkdir ', 'mv ', 'cp ', 'touch '],
      maxCommandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_REVIEW_MAX_OUTPUT_BYTES,
      rootPath: WORKSPACE_ROOT,
    };

    const history: ReviewAgentHistoryEntry[] = [];
    const usedTools: string[] = [];
    let finalValidationError: ReviewAgentOutputError | null = null;
    let repairAttempted = false;
    let repairSucceeded = false;
    let firstPassValid = false;
    let validationErrorCount = 0;
    let dedupedExactCount = 0;
    let fallbackApplied = false;
    let fallbackReason: string | null = null;

    for (let step = 1; step <= maxSteps; step += 1) {
      if (input.onLifecycleEvent) {
        await input.onLifecycleEvent('review_analysis_provider_request_started', {
          step,
          endpointHost,
          endpointPath,
          hasAuthToken: Boolean(authToken),
          hasOpenrouterApiKey: Boolean(readOptionalString(input.openrouterApiKey)),
        });
      }

      const action = await provider.next({ prompt, model, maxSteps, step, history });

      if (action.type === 'final') {
        if (input.onLifecycleEvent) {
          await input.onLifecycleEvent('review_analysis_model_output_received', { step, repairAttempted });
        }
        try {
          const parsed = parseJsonOutput(action.summary);
          const validated = validateOutputOrThrow(parsed);
          firstPassValid = !repairAttempted;
          repairSucceeded = repairAttempted;
          validationErrorCount = finalValidationError?.details && Array.isArray(finalValidationError.details.errors)
            ? finalValidationError.details.errors.length
            : 0;
          dedupedExactCount = validated.dedupedExactCount;
          if (repairAttempted && input.onLifecycleEvent) {
            await input.onLifecycleEvent('review_analysis_repair_output_received', { validationErrorCount, valid: true });
          }
          if (input.onLifecycleEvent) {
            await input.onLifecycleEvent('review_analysis_output_validated', {
              firstPassValid,
              repairAttempted,
              repairSucceeded,
              validationErrorCount,
              findingCount: validated.output.findings.length,
            });
          }
          return {
            findings: validated.output.findings,
            summary: validated.output.summary,
            furtherPassesLowYield: validated.output.furtherPassesLowYield,
            intent: null,
            provider: 'cloudflare_agents_sdk',
            model,
            stepsExecuted: step,
            usedTools,
            validation: {
              firstPassValid,
              repairAttempted,
              repairSucceeded,
              validationErrorCount,
              dedupedExactCount,
              fallbackApplied,
              fallbackReason,
            },
          };
        } catch (error) {
          if (error instanceof ReviewAgentOutputError && isGenericProviderCompletionSummary(action.summary)) {
            error = new ReviewAgentOutputError(
              'Review agent returned provider completion text instead of structured JSON; applying schema repair/fallback path'
            ).withCode('review_analysis_invalid_output', {
              errors: [{ path: '$', message: 'Provider completion summary returned instead of required JSON payload.' }],
            });
          }

          if (error instanceof ReviewAgentOutputError && !repairAttempted && step < maxSteps) {
            finalValidationError = error;
            repairAttempted = true;
            const validationErrors = extractValidationErrors(error);
            validationErrorCount = validationErrors.length;
            if (input.onLifecycleEvent) {
              await input.onLifecycleEvent('review_analysis_output_validation_failed', {
                errorCode: error.code,
                validationErrorCount,
                validationErrors,
              });
              await input.onLifecycleEvent('review_analysis_repair_requested', { validationErrorCount });
            }
            history.push({
              role: 'assistant',
              content: `final_output_validator: output failed schema; return corrected JSON only. Fix exactly these validation errors: ${JSON.stringify(validationErrors)}. Ensure summary is a plain string and furtherPassesLowYield is a JSON boolean true|false.`,
            });
            history.push({
              role: 'tool',
              tool: 'final_output_validator',
              output: {
                ok: false,
                error: 'Output must match ReviewAnalysisOutputV2 exactly.',
                requiredShape: {
                  findings: [{ severity: 'info|low|medium|high|critical', category: 'security|logic|style|breaking-change', passType: 'single', locations: [{ filePath: 'string', startLine: 'number|null', endLine: 'number|null' }], description: 'string', suggestedFix: 'string', failingScenario: 'string', evidence: 'string', guardGap: 'string' }],
                  summary: 'string',
                  furtherPassesLowYield: 'boolean',
                },
                validationErrors,
              },
            });
            continue;
          }

          if (error instanceof ReviewAgentOutputError && repairAttempted) {
            finalValidationError = error;
            const validationErrors = extractValidationErrors(error);
            validationErrorCount = validationErrors.length;
            if (input.onLifecycleEvent) {
              await input.onLifecycleEvent('review_analysis_repair_output_received', {
                validationErrorCount,
                valid: false,
                validationErrors,
              });
              await input.onLifecycleEvent('review_analysis_output_fallback_applied', {
                reason: 'invalid_after_repair',
                validationErrorCount,
                validationErrors,
              });
            }
            fallbackApplied = true;
            fallbackReason = 'invalid_after_repair';
            const fallback = buildFallbackAnalysisOutput(fallbackReason);
            return {
              findings: fallback.findings,
              summary: fallback.summary,
              furtherPassesLowYield: fallback.furtherPassesLowYield,
              intent: null,
              provider: 'cloudflare_agents_sdk',
              model,
              stepsExecuted: step,
              usedTools,
              validation: {
                firstPassValid: false,
                repairAttempted: true,
                repairSucceeded: false,
                validationErrorCount,
                dedupedExactCount,
                fallbackApplied,
                fallbackReason,
              },
            };
          }

          throw error;
        }
      }

      const output = await executeReviewTool(
        sandbox,
        action,
        policy,
        maxFileBytes,
        action.tool === 'diff_summary' ? input.authoritativeDiffSnapshot : undefined
      );
      usedTools.push(action.tool);
      history.push({ role: 'assistant', content: buildToolHistoryLabel(action) });
      history.push({ role: 'tool', tool: action.tool, output: sanitizeToolContext(output) });
    }

    if (finalValidationError) {
      throw finalValidationError;
    }
    throw new Error('Review analysis exceeded maximum step count');
  } finally {
    if (typeof sandbox.destroy === 'function') {
      try {
        await sandbox.destroy();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

/**
 * Redacts sensitive provider details from analysis errors before they are persisted or surfaced.
 */
export function formatReviewAnalysisError(error: unknown, options?: { openrouterApiKey?: string | null }): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeErrorMessage(message, options);
}
