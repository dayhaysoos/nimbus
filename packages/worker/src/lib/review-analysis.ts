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
  type ReviewAgentAction,
  type ReviewCommandPolicy,
} from './review-analysis/tools.js';
import {
  CloudflareAgentSdkReviewProvider,
  OpenRouterReviewProvider,
  type ReviewAgentHistoryEntry,
} from './review-analysis/provider.js';

const DEFAULT_REVIEW_AGENT_MAX_STEPS = 8;
const DEFAULT_REVIEW_MAX_FILE_BYTES = 48_000;
const DEFAULT_REVIEW_MAX_OUTPUT_BYTES = 96_000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_REVIEW_MODEL = 'gpt-5.1';
const MAX_DIRECT_CHANGED_FILE_COVERAGE_REQUIREMENT = 8;
const MIN_DIRECT_CHANGED_FILE_COVERAGE = 3;
const MAX_DETERMINISTIC_READ_PATHS = 8;

interface ReviewEvidenceState {
  diffSummaryUsed: boolean;
  readChangedPaths: Set<string>;
  searchUsed: boolean;
  searchMatchedChangedPath: boolean;
}

export interface ReviewAgentIntent {
  goal: string | null;
  constraints: string[];
  decisions: string[];
}

export interface ReviewAgentAnalysisResult {
  findings: ReviewFinding[];
  summary: string;
  furtherPassesLowYield: boolean;
  followUpReviewScore: 1 | 2 | 3;
  followUpReviewRationale: string;
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

function inferFollowUpReviewScore(output: { findings: ReviewFinding[]; furtherPassesLowYield: boolean }): 1 | 2 | 3 {
  const severities = new Set(output.findings.map((finding) => finding.severity));
  if (severities.has('critical') || severities.has('high')) {
    return 3;
  }
  if (severities.has('medium')) {
    return 2;
  }
  if (output.findings.length === 0) {
    return output.furtherPassesLowYield ? 1 : 2;
  }
  return 1;
}

function deriveFollowUpReviewMetadata(
  payload: unknown,
  output: { findings: ReviewFinding[]; furtherPassesLowYield: boolean }
): { score: 1 | 2 | 3; rationale: string } {
  const record = asRecord(payload);
  const rawScore = typeof record.followUpReviewScore === 'number' ? Math.floor(record.followUpReviewScore) : null;
  const score = rawScore === 1 || rawScore === 2 || rawScore === 3 ? rawScore : inferFollowUpReviewScore(output);
  const rationaleCandidate = typeof record.followUpReviewRationale === 'string' ? record.followUpReviewRationale.trim() : '';
  const rationale =
    rationaleCandidate ||
    (score === 3
      ? 'High-severity findings remain in changed paths; another review pass is required after fixes.'
      : score === 2
        ? 'At least one non-trivial issue remains; a follow-up review pass is recommended after fixes.'
        : 'Findings are low severity or low signal; additional review passes are likely diminishing returns.');

  return { score, rationale };
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

function parseCompleteActionPayload(action: Extract<ReviewAgentAction, { type: 'complete' }>): unknown {
  if (action.finalOutput !== undefined && action.finalOutput !== null) {
    return action.finalOutput;
  }
  if (typeof action.summary === 'string' && action.summary.trim()) {
    return parseJsonOutput(action.summary);
  }
  throw new ReviewAgentOutputError(
    'Review agent complete action requires finalOutput or a summary containing valid JSON payload'
  ).withCode(
    'review_analysis_invalid_output',
    {
      errors: [
        {
          path: '$',
          message: 'Complete action must include finalOutput or summary containing valid JSON payload.',
        },
      ],
    }
  );
}

function isSensitiveChangedPath(path: string): boolean {
  return /(?:recovery|retry|queue|status|state|workflow|db|auth)/i.test(path);
}

function initializeEvidenceState(): ReviewEvidenceState {
  return {
    diffSummaryUsed: false,
    readChangedPaths: new Set<string>(),
    searchUsed: false,
    searchMatchedChangedPath: false,
  };
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().replace(/\\/g, '/');
  return trimmed ? trimmed : null;
}

function recordEvidenceFromToolExecution(
  state: ReviewEvidenceState,
  action: Extract<ReviewAgentAction, { type: 'tool' }>,
  toolOutput: unknown,
  changedPaths: Set<string>
): void {
  if (action.tool === 'diff_summary') {
    state.diffSummaryUsed = true;
    return;
  }

  if (action.tool === 'read_file') {
    const readPath = normalizePath(action.args.path);
    if (readPath && changedPaths.has(readPath)) {
      state.readChangedPaths.add(readPath);
    }
    return;
  }

  if (action.tool === 'search_code') {
    state.searchUsed = true;
    const matches = Array.isArray(asRecord(toolOutput).matches) ? (asRecord(toolOutput).matches as unknown[]) : [];
    state.searchMatchedChangedPath = matches.some((match) => {
      const matchPath = normalizePath(asRecord(match).path);
      return Boolean(matchPath && changedPaths.has(matchPath));
    });
  }
}

function collectMissingEvidenceRequirements(input: {
  evidence: ReviewEvidenceState;
  changedPaths: string[];
}): string[] {
  const missing: string[] = [];
  const sensitiveChangedPaths = input.changedPaths.filter((path) => isSensitiveChangedPath(path));

  if (input.changedPaths.length > 0 && !input.evidence.diffSummaryUsed) {
    missing.push('Run diff_summary at least once before completing analysis.');
  }

  const requiredReadCoverage =
    input.changedPaths.length <= MAX_DIRECT_CHANGED_FILE_COVERAGE_REQUIREMENT
      ? input.changedPaths.length
      : Math.min(MIN_DIRECT_CHANGED_FILE_COVERAGE, input.changedPaths.length);
  if (input.evidence.readChangedPaths.size < requiredReadCoverage) {
    missing.push(
      `Read at least ${requiredReadCoverage} changed file(s) directly with read_file (currently ${input.evidence.readChangedPaths.size}).`
    );
  }

  const missingSensitivePaths = sensitiveChangedPaths.filter((path) => !input.evidence.readChangedPaths.has(path));
  if (missingSensitivePaths.length > 0) {
    missing.push(`Read sensitive changed file(s) directly: ${missingSensitivePaths.join(', ')}.`);
  }

  if (input.changedPaths.length > 0 && !input.evidence.searchUsed) {
    missing.push('Run search_code at least once before completing analysis.');
  }

  return missing;
}

function selectDeterministicReadPaths(changedPaths: string[]): string[] {
  const deduped = Array.from(new Set(changedPaths));
  const sensitive = deduped.filter((path) => isSensitiveChangedPath(path));
  const requiredCount =
    deduped.length <= MAX_DIRECT_CHANGED_FILE_COVERAGE_REQUIREMENT
      ? deduped.length
      : Math.min(MIN_DIRECT_CHANGED_FILE_COVERAGE, deduped.length);
  const selected = [...sensitive];
  for (const path of deduped) {
    if (selected.length >= Math.max(requiredCount, sensitive.length)) {
      break;
    }
    if (!selected.includes(path)) {
      selected.push(path);
    }
  }
  return selected.slice(0, MAX_DETERMINISTIC_READ_PATHS);
}

async function runDeterministicEvidenceCollection(input: {
  sandbox: SandboxClient;
  policy: ReviewCommandPolicy;
  maxFileBytes: number;
  authoritativeDiffSnapshot: unknown;
  changedPaths: string[];
  changedPathsSet: Set<string>;
  evidence: ReviewEvidenceState;
  usedTools: string[];
  history: ReviewAgentHistoryEntry[];
  onLifecycleEvent?: (eventType: string, payload: Record<string, unknown>) => void | Promise<void>;
}): Promise<void> {
  const deterministicTools: Array<Extract<ReviewAgentAction, { type: 'tool' }>> = [
    { type: 'tool', tool: 'diff_summary', args: { maxBytes: 64_000 } },
    ...selectDeterministicReadPaths(input.changedPaths).map((path) => ({
      type: 'tool' as const,
      tool: 'read_file' as const,
      args: { path, maxBytes: Math.min(input.maxFileBytes, 48_000) },
    })),
    { type: 'tool', tool: 'search_code', args: { query: 'function', path: '.', maxResults: 40 } },
  ];

  let deterministicStep = 0;
  for (const action of deterministicTools) {
    deterministicStep += 1;
    const output = await executeReviewTool(
      input.sandbox,
      action,
      input.policy,
      input.maxFileBytes,
      action.tool === 'diff_summary' ? input.authoritativeDiffSnapshot : undefined
    );
    input.usedTools.push(action.tool);
    recordEvidenceFromToolExecution(input.evidence, action, output.result, input.changedPathsSet);
    if (input.onLifecycleEvent) {
      await input.onLifecycleEvent('review_analysis_tool_executed', {
        step: deterministicStep,
        tool: action.tool,
        deterministic: true,
      });
    }
    input.history.push({ role: 'assistant', content: `deterministic:${buildToolHistoryLabel(action)}` });
    input.history.push({ role: 'tool', tool: action.tool, output: sanitizeToolContext(output) });
  }
}

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
  const openrouterApiKey = readOptionalString(input.openrouterApiKey) ?? readOptionalString(env.OPENROUTER_API_KEY);
  if (!endpoint && !openrouterApiKey) {
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

    const provider = openrouterApiKey
      ? new OpenRouterReviewProvider(openrouterApiKey, validateReviewAgentAction, 'https://nimbus.dayhaysoos.com', 'Nimbus Review Harness')
      : new CloudflareAgentSdkReviewProvider(
          endpoint,
          authToken,
          env.AGENT_ENDPOINT ?? null,
          readOptionalString(input.openrouterApiKey),
          validateReviewAgentAction
        );
    const providerName = openrouterApiKey ? 'openrouter' : 'cloudflare_agents_sdk';
    const policy: ReviewCommandPolicy = {
      commandAllow: [],
      commandDeny: ['git ', 'rm ', 'npm ', 'pnpm ', 'yarn ', 'bun ', 'mkdir ', 'mv ', 'cp ', 'touch '],
      maxCommandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_REVIEW_MAX_OUTPUT_BYTES,
      rootPath: WORKSPACE_ROOT,
    };

    const history: ReviewAgentHistoryEntry[] = [];
    const usedTools: string[] = [];
    const changedPaths = input.reviewContext.retrieval.changedFiles.map((file) => file.path);
    const changedPathsSet = new Set(changedPaths);
    const evidence = initializeEvidenceState();
    let finalValidationError: ReviewAgentOutputError | null = null;
    let repairAttempted = false;
    let repairSucceeded = false;
    let firstPassValid = false;
    let validationErrorCount = 0;
    let dedupedExactCount = 0;
    let fallbackApplied = false;
    let fallbackReason: string | null = null;

    await runDeterministicEvidenceCollection({
      sandbox,
      policy,
      maxFileBytes,
      authoritativeDiffSnapshot: input.authoritativeDiffSnapshot,
      changedPaths,
      changedPathsSet,
      evidence,
      usedTools,
      history,
      onLifecycleEvent: input.onLifecycleEvent,
    });

    for (let step = 1; step <= maxSteps; step += 1) {
      if (input.onLifecycleEvent) {
        await input.onLifecycleEvent('review_analysis_provider_request_started', {
          step,
          endpointHost,
          endpointPath,
          hasAuthToken: Boolean(authToken),
          hasOpenrouterApiKey: Boolean(openrouterApiKey),
          provider: providerName,
        });
      }

      const action = await provider.next({ prompt, model, maxSteps, step, history });

      if (input.onLifecycleEvent) {
        await input.onLifecycleEvent('review_analysis_step_planned', {
          step,
          type: action.type,
          tool: action.type === 'tool' ? action.tool : null,
        });
      }

      if (action.type === 'complete') {
        const missingEvidence = collectMissingEvidenceRequirements({
          evidence,
          changedPaths,
        });
        if (missingEvidence.length > 0 && step <= maxSteps) {
          if (input.onLifecycleEvent) {
            await input.onLifecycleEvent('review_analysis_evidence_insufficient', {
              step,
              missingEvidence,
            });
          }
          history.push({
            role: 'assistant',
            content: 'analysis_guard: completion rejected due to insufficient evidence; gather required tool evidence before completing.',
          });
          history.push({
            role: 'tool',
            tool: 'analysis_guard',
            output: {
              ok: false,
              missingEvidence,
              changedFiles: changedPaths,
            },
          });
          continue;
        }

        if (input.onLifecycleEvent) {
          await input.onLifecycleEvent('review_analysis_model_output_received', { step, repairAttempted });
        }
        try {
          const parsed = parseCompleteActionPayload(action);
          const validated = validateOutputOrThrow(parsed);
          const followUpReview = deriveFollowUpReviewMetadata(parsed, {
            findings: validated.output.findings,
            furtherPassesLowYield: validated.output.furtherPassesLowYield,
          });
          firstPassValid = true;
          repairAttempted = false;
          repairSucceeded = false;
          validationErrorCount = 0;
          dedupedExactCount = validated.dedupedExactCount;
          if (input.onLifecycleEvent) {
            await input.onLifecycleEvent('review_analysis_output_validated', {
              firstPassValid,
              repairAttempted,
              repairSucceeded,
              validationErrorCount,
              findingCount: validated.output.findings.length,
              followUpReviewScore: followUpReview.score,
            });
          }
          return {
            findings: validated.output.findings,
            summary: validated.output.summary,
            furtherPassesLowYield: validated.output.furtherPassesLowYield,
            followUpReviewScore: followUpReview.score,
            followUpReviewRationale: followUpReview.rationale,
            intent: null,
            provider: providerName,
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
          if (error instanceof ReviewAgentOutputError && action.summary && isGenericProviderCompletionSummary(action.summary)) {
            error = new ReviewAgentOutputError(
              'Review agent returned provider completion text instead of structured JSON output'
            ).withCode('review_analysis_invalid_output', {
              errors: [{ path: '$', message: 'Provider completion summary returned instead of required JSON payload.' }],
            });
          }

          if (error instanceof ReviewAgentOutputError) {
            finalValidationError = error;
            const validationErrors = extractValidationErrors(error);
            validationErrorCount = validationErrors.length;
            if (input.onLifecycleEvent) {
              await input.onLifecycleEvent('review_analysis_output_validation_failed', {
                errorCode: error.code,
                validationErrorCount,
                validationErrors,
              });
            }
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
      recordEvidenceFromToolExecution(evidence, action, output.result, changedPathsSet);
      if (input.onLifecycleEvent) {
        await input.onLifecycleEvent('review_analysis_tool_executed', {
          step,
          tool: action.tool,
        });
      }
      history.push({ role: 'assistant', content: buildToolHistoryLabel(action) });
      history.push({ role: 'tool', tool: action.tool, output: sanitizeToolContext(output) });
    }

    const missingEvidence = collectMissingEvidenceRequirements({
      evidence,
      changedPaths,
    });
    if (missingEvidence.length > 0) {
      throw new ReviewAgentOutputError('Review analysis completion rejected due to insufficient tool evidence').withCode(
        'review_analysis_insufficient_evidence',
        {
          errors: missingEvidence.map((message) => ({ path: '$', message })),
        }
      );
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
