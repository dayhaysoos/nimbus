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
const MAX_REVIEW_AGENT_MAX_STEPS = 24;
const DEFAULT_REVIEW_MAX_FILE_BYTES = 48_000;
const DEFAULT_REVIEW_MAX_OUTPUT_BYTES = 96_000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_REVIEW_MODEL = 'gpt-5.1';
const MAX_VALIDATION_REPAIR_ATTEMPTS = 1;
const MIN_PROVIDER_REASONING_STEPS = 6;
const MAX_DIRECT_CHANGED_FILE_COVERAGE_REQUIREMENT = 8;
const MIN_DIRECT_CHANGED_FILE_COVERAGE = 3;
const MAX_DETERMINISTIC_READ_PATHS = 8;
const MAX_DETERMINISTIC_SEARCH_QUERIES = 3;
const MAX_DETERMINISTIC_CROSS_FILE_READS = 2;
const MAX_INTEGRATION_CALLBACK_QUERIES_PER_FILE = 2;
const MAX_INTEGRATION_IMPORTED_SYMBOL_QUERIES_PER_FILE = 2;
const DETERMINISTIC_SEARCH_MIN_QUERY_LENGTH = 4;
const IGNORABLE_SEARCH_TOKENS = new Set([
  'async',
  'await',
  'const',
  'default',
  'export',
  'false',
  'from',
  'function',
  'import',
  'null',
  'return',
  'review',
  'string',
  'true',
  'type',
  'undefined',
  'update',
  'value',
]);
const INTEGRATION_SYMBOL_KEYWORDS = /(?:start|resolve|create|recover|retry|fail|deploy|review|context|workspace|policy|event)/i;
const INTEGRATION_CALLBACK_PATTERN = /^on(?:Progress|Event|Status|Stage|Update|Complete|Message|Stream|Data|Error)[A-Za-z0-9_]*$/;

interface ReviewEvidenceState {
  diffSummaryUsed: boolean;
  readChangedPaths: Set<string>;
  readCrossFilePaths: Set<string>;
  searchUsed: boolean;
  searchMatchedChangedPath: boolean;
}

type ReviewReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

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
    readCrossFilePaths: new Set<string>(),
    searchUsed: false,
    searchMatchedChangedPath: false,
  };
}

function parseReviewReasoningEffort(value: string | null | undefined): ReviewReasoningEffort | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high'
    ? normalized
    : undefined;
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
    if (readPath) {
      if (changedPaths.has(readPath)) {
        state.readChangedPaths.add(readPath);
      } else {
        state.readCrossFilePaths.add(readPath);
      }
    }
    return;
  }

  if (action.tool === 'read_batch') {
    const files = Array.isArray(asRecord(toolOutput).files) ? (asRecord(toolOutput).files as unknown[]) : [];
    for (const file of files) {
      const readPath = normalizePath(asRecord(file).path);
      if (!readPath) {
        continue;
      }
      if (changedPaths.has(readPath)) {
        state.readChangedPaths.add(readPath);
      } else {
        state.readCrossFilePaths.add(readPath);
      }
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
  requiresCrossFileEvidence: boolean;
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

  if (input.requiresCrossFileEvidence && input.evidence.readCrossFilePaths.size === 0) {
    missing.push('Read at least one non-changed file that defines or handles an integration boundary touched by the diff.');
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

function pathStem(path: string): string | null {
  const fileName = path.split('/').pop() ?? '';
  const stem = fileName.replace(/\.[^.]+$/, '').trim();
  if (stem.length < DETERMINISTIC_SEARCH_MIN_QUERY_LENGTH) {
    return null;
  }
  return stem;
}

function maybeAddSearchQuery(queries: string[], seen: Set<string>, candidate: string): void {
  const normalized = candidate.trim();
  if (normalized.length < DETERMINISTIC_SEARCH_MIN_QUERY_LENGTH) {
    return;
  }
  if (!/[A-Za-z]/.test(normalized)) {
    return;
  }
  const lowered = normalized.toLowerCase();
  if (IGNORABLE_SEARCH_TOKENS.has(lowered)) {
    return;
  }
  if (seen.has(lowered)) {
    return;
  }
  seen.add(lowered);
  queries.push(normalized);
}

type DeterministicSearchKind = 'api_route' | 'imported_symbol' | 'callback' | 'dependency';

interface DeterministicSearchQuery {
  query: string;
  sourcePath: string;
  kind: DeterministicSearchKind;
}

function maybeAddDeterministicSearchQuery(
  queries: DeterministicSearchQuery[],
  seen: Set<string>,
  candidate: string,
  sourcePath: string,
  kind: DeterministicSearchKind
): void {
  const tempQueries: string[] = [];
  const beforeSize = seen.size;
  maybeAddSearchQuery(tempQueries, seen, candidate);
  if (seen.size > beforeSize && tempQueries.length > 0) {
    queries.push({ query: tempQueries[0], sourcePath, kind });
  }
}

function extractDeterministicSearchQueries(changedFiles: ReviewContext['retrieval']['changedFiles']): DeterministicSearchQuery[] {
  const queries: DeterministicSearchQuery[] = [];
  const seen = new Set<string>();
  const sensitiveFiles = changedFiles.filter((file) => isSensitiveChangedPath(file.path));
  for (const file of sensitiveFiles) {
    const importMatches = file.content.matchAll(/\bimport\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))/g);
    for (const match of importMatches) {
      const importedBlock = match[1] ?? match[2] ?? '';
      for (const item of importedBlock.split(',')) {
        const cleaned = item.replace(/\bas\b.+$/i, '').trim();
        maybeAddDeterministicSearchQuery(queries, seen, cleaned, file.path, 'dependency');
        if (queries.length >= MAX_DETERMINISTIC_SEARCH_QUERIES) {
          return queries;
        }
      }
    }

    const callMatches = file.content.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{3,})\s*\(/g);
    for (const match of callMatches) {
      maybeAddDeterministicSearchQuery(queries, seen, match[1] ?? '', file.path, 'dependency');
      if (queries.length >= MAX_DETERMINISTIC_SEARCH_QUERIES) {
        return queries;
      }
    }

    const stem = pathStem(file.path);
    if (stem) {
      maybeAddDeterministicSearchQuery(queries, seen, stem, file.path, 'dependency');
      if (queries.length >= MAX_DETERMINISTIC_SEARCH_QUERIES) {
        return queries;
      }
    }
  }

  if (queries.length === 0) {
    const fallbackStem = changedFiles.map((file) => pathStem(file.path)).find(Boolean);
    if (fallbackStem) {
      maybeAddDeterministicSearchQuery(queries, seen, fallbackStem, changedFiles[0]?.path ?? '.', 'dependency');
    }
  }

  return queries.slice(0, MAX_DETERMINISTIC_SEARCH_QUERIES);
}

export function extractDeterministicSearchQueriesForTests(
  changedFiles: ReviewContext['retrieval']['changedFiles']
): string[] {
  return extractDeterministicSearchQueries(changedFiles).map((entry) => entry.query);
}

function extractStaticApiTailQueries(content: string): string[] {
  const queries: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.includes('/api/')) {
      continue;
    }
    const segments = Array.from(line.matchAll(/\/([A-Za-z][A-Za-z0-9_-]{3,})(?=(?:\/|\$|['"`)}\],; ]))/g))
      .map((match) => match[1] ?? '')
      .filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (segment === 'api' || segment === 'review' || segment === 'reviews' || segment === 'workspace' || segment === 'workspaces') {
        continue;
      }
      queries.push(`/${segment}`);
      break;
    }
  }
  return queries;
}

function extractIntegrationSearchQueries(changedFiles: ReviewContext['retrieval']['changedFiles']): DeterministicSearchQuery[] {
  const queries: DeterministicSearchQuery[] = [];
  const seen = new Set<string>();

  for (const file of changedFiles) {
    for (const query of extractStaticApiTailQueries(file.content)) {
      maybeAddDeterministicSearchQuery(queries, seen, query, file.path, 'api_route');
      if (queries.length >= MAX_DETERMINISTIC_SEARCH_QUERIES) {
        return queries;
      }
    }

    const importedNames = new Set<string>();
    const importMatches = file.content.matchAll(/\bimport\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))/g);
    for (const match of importMatches) {
      const importedBlock = match[1] ?? match[2] ?? '';
      for (const item of importedBlock.split(',')) {
        const cleaned = item.replace(/\bas\b.+$/i, '').trim();
        if (!cleaned || !INTEGRATION_SYMBOL_KEYWORDS.test(cleaned)) {
          continue;
        }
        importedNames.add(cleaned);
      }
    }
    let importedQueriesAdded = 0;
    for (const importedName of importedNames) {
      if (!new RegExp(`\\b${importedName}\\s*\\(`).test(file.content)) {
        continue;
      }
      maybeAddDeterministicSearchQuery(queries, seen, importedName, file.path, 'imported_symbol');
      importedQueriesAdded += 1;
      if (
        queries.length >= MAX_DETERMINISTIC_SEARCH_QUERIES ||
        importedQueriesAdded >= MAX_INTEGRATION_IMPORTED_SYMBOL_QUERIES_PER_FILE
      ) {
        break;
      }
    }
    if (queries.length >= MAX_DETERMINISTIC_SEARCH_QUERIES) {
      return queries;
    }

    let callbackQueriesAdded = 0;
    const callbackMatches = file.content.matchAll(/\bon[A-Z][A-Za-z0-9_]{3,}\b/g);
    for (const match of callbackMatches) {
      const callbackName = match[0] ?? '';
      if (!INTEGRATION_CALLBACK_PATTERN.test(callbackName)) {
        continue;
      }
      maybeAddDeterministicSearchQuery(queries, seen, callbackName, file.path, 'callback');
      callbackQueriesAdded += 1;
      if (
        queries.length >= MAX_DETERMINISTIC_SEARCH_QUERIES ||
        callbackQueriesAdded >= MAX_INTEGRATION_CALLBACK_QUERIES_PER_FILE
      ) {
        break;
      }
    }
    if (queries.length >= MAX_DETERMINISTIC_SEARCH_QUERIES) {
      return queries;
    }
  }

  return queries.slice(0, MAX_DETERMINISTIC_SEARCH_QUERIES);
}

export function extractIntegrationSearchQueriesForTests(
  changedFiles: ReviewContext['retrieval']['changedFiles']
): string[] {
  return extractIntegrationSearchQueries(changedFiles).map((entry) => entry.query);
}

function topLevelPackage(path: string): string {
  return path.split('/').slice(0, 2).join('/');
}

function scoreSearchMatch(input: {
  sourcePath: string;
  candidatePath: string;
  kind: DeterministicSearchKind;
  query: string;
}): number {
  let score = pathDistanceScore(input.sourcePath, input.candidatePath);
  if (input.kind === 'api_route') {
    if (/\/src\/api\//.test(input.candidatePath)) {
      score -= 6;
    }
    if (/packages\/worker\//.test(input.candidatePath)) {
      score -= 3;
    }
    if (/recover|fail|retry|events/i.test(input.query) && /recover|fail|retry|events/i.test(input.candidatePath)) {
      score -= 3;
    }
    if (/reviews/i.test(input.candidatePath)) {
      score -= 1;
    }
    return score;
  }

  if (input.kind === 'imported_symbol' || input.kind === 'callback') {
    if (topLevelPackage(input.candidatePath) === topLevelPackage(input.sourcePath)) {
      score -= 4;
    }
    if (input.candidatePath.split('/').slice(0, 3).join('/') === input.sourcePath.split('/').slice(0, 3).join('/')) {
      score -= 2;
    }
  }

  return score;
}

function combineDeterministicSearchQueries(
  primary: DeterministicSearchQuery[],
  secondary: DeterministicSearchQuery[]
): DeterministicSearchQuery[] {
  const combined: DeterministicSearchQuery[] = [];
  const seen = new Set<string>();
  for (const query of [...primary, ...secondary]) {
    const lowered = query.query.trim().toLowerCase();
    if (!lowered || seen.has(lowered)) {
      continue;
    }
    seen.add(lowered);
    combined.push(query);
    if (combined.length >= MAX_DETERMINISTIC_SEARCH_QUERIES) {
      break;
    }
  }
  return combined;
}

function pathDistanceScore(sourcePath: string, candidatePath: string): number {
  const sourceSegments = sourcePath.split('/');
  const candidateSegments = candidatePath.split('/');
  let shared = 0;
  while (
    shared < sourceSegments.length &&
    shared < candidateSegments.length &&
    sourceSegments[shared] === candidateSegments[shared]
  ) {
    shared += 1;
  }
  return (sourceSegments.length - shared) + (candidateSegments.length - shared);
}

export function computeReviewStepBudgetsForTests(maxSteps: number): { deterministicMaxSteps: number; providerMaxSteps: number } {
  const providerMaxSteps = Math.max(1, maxSteps - Math.max(0, maxSteps - MIN_PROVIDER_REASONING_STEPS));
  const deterministicMaxSteps = Math.max(0, maxSteps - providerMaxSteps);
  return { deterministicMaxSteps, providerMaxSteps };
}

async function runDeterministicEvidenceCollection(input: {
  sandbox: SandboxClient;
  policy: ReviewCommandPolicy;
  maxFileBytes: number;
  authoritativeDiffSnapshot: unknown;
  changedPaths: string[];
  changedFiles: ReviewContext['retrieval']['changedFiles'];
  changedPathsSet: Set<string>;
  evidence: ReviewEvidenceState;
  usedTools: string[];
  history: ReviewAgentHistoryEntry[];
  maxDeterministicSteps: number;
  onLifecycleEvent?: (eventType: string, payload: Record<string, unknown>) => void | Promise<void>;
}): Promise<number> {
  const deterministicTools: Array<Extract<ReviewAgentAction, { type: 'tool' }>> = [
    { type: 'tool', tool: 'diff_summary', args: { maxBytes: 64_000 } },
    ...selectDeterministicReadPaths(input.changedPaths).map((path) => ({
      type: 'tool' as const,
      tool: 'read_file' as const,
      args: { path, maxBytes: Math.min(input.maxFileBytes, 48_000) },
    })),
  ];
  const followUpReadPaths: string[] = [];

  let deterministicStep = 0;
  for (const action of deterministicTools) {
    if (deterministicStep >= input.maxDeterministicSteps) {
      break;
    }
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

  const deterministicSearchQueries = combineDeterministicSearchQueries(
    extractIntegrationSearchQueries(input.changedFiles),
    extractDeterministicSearchQueries(input.changedFiles)
  );
  for (const searchQuery of deterministicSearchQueries) {
    if (deterministicStep >= input.maxDeterministicSteps) {
      break;
    }
    const action: Extract<ReviewAgentAction, { type: 'tool' }> = {
      type: 'tool',
      tool: 'search_code',
      args: {
        query: searchQuery.query,
        path: '.',
        maxResults: 20,
        maxBytesPerFile: Math.min(input.maxFileBytes, 16_000),
      },
    };
    deterministicStep += 1;
    const output = await executeReviewTool(
      input.sandbox,
      action,
      input.policy,
      input.maxFileBytes,
    );
    input.usedTools.push(action.tool);
    recordEvidenceFromToolExecution(input.evidence, action, output.result, input.changedPathsSet);
    if (input.onLifecycleEvent) {
      await input.onLifecycleEvent('review_analysis_tool_executed', {
        step: deterministicStep,
        tool: action.tool,
        deterministic: true,
        query: searchQuery.query,
      });
    }
    input.history.push({ role: 'assistant', content: `deterministic:${buildToolHistoryLabel(action)}` });
    input.history.push({ role: 'tool', tool: action.tool, output: sanitizeToolContext(output) });

    const matches = Array.isArray(asRecord(output.result).matches) ? (asRecord(output.result).matches as unknown[]) : [];
    const rankedMatches = matches
      .map((match) => {
        const matchPath = normalizePath(asRecord(match).path);
        return matchPath
          ? {
              matchPath,
              score: scoreSearchMatch({
                sourcePath: searchQuery.sourcePath,
                candidatePath: matchPath,
                kind: searchQuery.kind,
                query: searchQuery.query,
              }),
            }
          : null;
      })
      .filter((match): match is { matchPath: string; score: number } => Boolean(match))
      .sort((left, right) => left.score - right.score);
    for (const match of rankedMatches) {
      const matchPath = match.matchPath;
      if (input.changedPathsSet.has(matchPath) || followUpReadPaths.includes(matchPath)) {
        continue;
      }
      followUpReadPaths.push(matchPath);
      if (followUpReadPaths.length >= MAX_DETERMINISTIC_CROSS_FILE_READS) {
        break;
      }
    }
  }

  for (const path of followUpReadPaths) {
    if (deterministicStep >= input.maxDeterministicSteps) {
      break;
    }
    const batchPaths = [path, ...followUpReadPaths.filter((candidate) => candidate !== path)].slice(0, 2);
    const action: Extract<ReviewAgentAction, { type: 'tool' }> = {
      type: 'tool',
      tool: 'read_batch',
      args: { paths: batchPaths, maxBytes: Math.min(input.maxFileBytes, 32_000) },
    };
    deterministicStep += 1;
    const output = await executeReviewTool(
      input.sandbox,
      action,
      input.policy,
      input.maxFileBytes,
    );
    input.usedTools.push(action.tool);
    recordEvidenceFromToolExecution(input.evidence, action, output.result, input.changedPathsSet);
    if (input.onLifecycleEvent) {
      await input.onLifecycleEvent('review_analysis_tool_executed', {
        step: deterministicStep,
        tool: action.tool,
        deterministic: true,
        crossFile: true,
      });
    }
    input.history.push({ role: 'assistant', content: `deterministic:${buildToolHistoryLabel(action)}` });
    input.history.push({ role: 'tool', tool: action.tool, output: sanitizeToolContext(output) });
    break;
  }

  return deterministicStep;
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
  const reasoningEffort = parseReviewReasoningEffort(readOptionalString(env.REVIEW_REASONING_EFFORT));
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

  const maxSteps = parseIntegerString(env.REVIEW_AGENT_MAX_STEPS, DEFAULT_REVIEW_AGENT_MAX_STEPS, 1, MAX_REVIEW_AGENT_MAX_STEPS);
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
        reasoningEffort: reasoningEffort ?? null,
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
    const integrationSearchQueries = extractIntegrationSearchQueries(input.reviewContext.retrieval.changedFiles);
    const evidence = initializeEvidenceState();
    let finalValidationError: ReviewAgentOutputError | null = null;
    let repairAttempted = false;
    let repairSucceeded = false;
    let firstPassValid = false;
    let validationErrorCount = 0;
    let dedupedExactCount = 0;
    let fallbackApplied = false;
    let fallbackReason: string | null = null;
    let repairAttemptsUsed = 0;
    let forceCompleteNextStep = false;

    const { deterministicMaxSteps, providerMaxSteps } = computeReviewStepBudgetsForTests(maxSteps);

    const deterministicExecutedSteps = await runDeterministicEvidenceCollection({
      sandbox,
      policy,
      maxFileBytes,
      authoritativeDiffSnapshot: input.authoritativeDiffSnapshot,
      changedPaths,
      changedFiles: input.reviewContext.retrieval.changedFiles,
      changedPathsSet,
      evidence,
      usedTools,
      history,
      maxDeterministicSteps: deterministicMaxSteps,
      onLifecycleEvent: input.onLifecycleEvent,
    });
    const providerLoopMaxSteps = Math.max(providerMaxSteps, maxSteps - deterministicExecutedSteps);
    const sensitiveChangedPaths = changedPaths.filter((path) => isSensitiveChangedPath(path));
    if (sensitiveChangedPaths.length > 0) {
      history.push({
        role: 'assistant',
        content:
          `analysis_focus: prioritize concrete correctness review in sensitive changed paths before lower-risk neighboring code: ${JSON.stringify(sensitiveChangedPaths)}.`,
      });
    }

    for (let step = 1; step <= providerLoopMaxSteps; step += 1) {
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

      const action = await provider.next({
        prompt,
        model,
        reasoningEffort,
        maxSteps: providerLoopMaxSteps,
        step,
        history,
        forceComplete: forceCompleteNextStep,
      });
      forceCompleteNextStep = false;

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
          requiresCrossFileEvidence: integrationSearchQueries.length > 0,
        });
        if (missingEvidence.length > 0 && step <= providerLoopMaxSteps) {
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
          firstPassValid = repairAttemptsUsed === 0;
          repairAttempted = repairAttemptsUsed > 0;
          repairSucceeded = repairAttemptsUsed > 0;
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

            if (repairAttemptsUsed < MAX_VALIDATION_REPAIR_ATTEMPTS && step < providerLoopMaxSteps) {
              repairAttemptsUsed += 1;
              repairAttempted = true;
              forceCompleteNextStep = true;
              history.push({
                role: 'assistant',
                content:
                  'analysis_guard: previous complete action was schema-invalid; return one corrected complete action only, preserving concrete findings supported by evidence.',
              });
              history.push({
                role: 'tool',
                tool: 'validation_guard',
                output: {
                  ok: false,
                  errorCode: error.code,
                  validationErrors,
                  requiredShape: 'ReviewAnalysisOutputV2',
                },
              });
              if (input.onLifecycleEvent) {
                await input.onLifecycleEvent('review_analysis_output_repair_requested', {
                  repairAttempt: repairAttemptsUsed,
                  validationErrorCount,
                });
              }
              continue;
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
      requiresCrossFileEvidence: integrationSearchQueries.length > 0,
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
