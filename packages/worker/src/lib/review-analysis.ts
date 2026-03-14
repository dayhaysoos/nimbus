import type { Sandbox } from '@cloudflare/sandbox';
import type {
  Env,
  ReviewAnalysisOutputV2,
  ReviewContext,
  ReviewFinding,
} from '../types.js';
import { validateAndNormalizeReviewAnalysisOutputV2 } from './review-output-v2.js';

const WORKSPACE_ROOT = '/workspace';
const BUNDLE_BASE64_PATH = '/tmp/review-source.tar.gz.base64';
const BUNDLE_PATH = '/tmp/review-source.tar.gz';
const BUNDLE_BASE64_PART_PREFIX = '/tmp/review-source.tar.gz.base64.part';
const BUNDLE_BASE64_CHUNK_BYTES = 510 * 1024;
const DEFAULT_REVIEW_AGENT_MAX_STEPS = 6;
const DEFAULT_REVIEW_MAX_FILE_BYTES = 48_000;
const DEFAULT_REVIEW_MAX_OUTPUT_BYTES = 96_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 2 * 60_000;
const PROMPT_DIFF_HUNKS_MAX_BYTES = 48_000;
const PROMPT_CHANGED_FILES_MAX_BYTES = 80_000;
const PROMPT_RELATED_FILES_MAX_BYTES = 36_000;
const PROMPT_CONVENTION_FILES_MAX_BYTES = 20_000;
const DEFAULT_REVIEW_MODEL = 'sonnet-4.5';
const REVIEW_PROVIDER_TIMEOUT_MS = 120_000;
const GITHUB_TOKEN_PATTERN = /\bgh[psu]_[A-Za-z0-9_]{20,}\b/g;

interface SandboxClient {
  exec(
    command: string,
    options?: {
      timeout?: number;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, contents: string): Promise<unknown>;
  destroy?(): Promise<void>;
}

type ReviewAgentAction =
  | { type: 'tool'; tool: 'list_files'; args: { path?: string } }
  | { type: 'tool'; tool: 'read_file'; args: { path: string; maxBytes?: number } }
  | { type: 'tool'; tool: 'write_file'; args: { path: string; content?: string } }
  | { type: 'tool'; tool: 'run_command'; args: { command: string; timeoutMs?: number } }
  | { type: 'tool'; tool: 'diff_summary'; args: { maxBytes?: number } }
  | { type: 'final'; summary: string };

type ReviewAgentHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; output: unknown };

interface ReviewAgentProvider {
  next(input: {
    prompt: string;
    model: string;
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
  }): Promise<ReviewAgentAction>;
}

interface ReviewCommandPolicy {
  commandAllow: string[];
  commandDeny: string[];
  maxCommandTimeoutMs: number;
  maxOutputBytes: number;
  rootPath: string;
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

interface ReviewAgentPromptInput {
  reviewId: string;
  workspaceId: string;
  deploymentId: string;
  sourceBundleKey: string;
  authoritativeDiffSnapshot?: unknown;
  goal: string;
  constraints: string[];
  decisions: string[];
  intentSessionContext: string[];
  evidenceCatalog: Array<{ id: string; type: string; label: string; status: string }>;
  deploymentSummary: {
    provider: string;
    deployedUrl: string | null;
    validationSummary: string;
  };
  reviewContext: ReviewContext;
  rootListing: unknown;
  diffSnapshot: unknown;
  onLifecycleEvent?: (eventType: string, payload: Record<string, unknown>) => Promise<void> | void;
}

interface ReviewToolContext {
  request: Record<string, unknown>;
  result: unknown;
}

export interface ReviewSourceFileReadResult {
  path: string;
  content: string | null;
  bytes: number;
  truncated: boolean;
  error: string | null;
}

class ReviewPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewPolicyError';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function parseIntegerString(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function boundedJson(value: unknown, maxBytes: number): string {
  const serialized = JSON.stringify(value);
  const clamped = clampText(serialized, maxBytes);
  return clamped.truncated ? `${clamped.text} [TRUNCATED]` : clamped.text;
}

function stripCodeFences(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonObject(value: string): string {
  const stripped = stripCodeFences(value);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return stripped.slice(start, end + 1);
  }
  return stripped;
}

function normalizeIntent(value: unknown): ReviewAgentIntent | null {
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

class ReviewAgentOutputError extends Error {
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

function parseJsonOutput(summary: string): unknown {
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

function validateOutputOrThrow(payload: unknown): { output: ReviewAnalysisOutputV2; dedupedExactCount: number } {
  const validated = validateAndNormalizeReviewAnalysisOutputV2(payload);
  if (!validated.ok) {
    throw new ReviewAgentOutputError('Review agent output does not match required schema').withCode(
      'review_analysis_invalid_output',
      {
        errors: validated.errors,
      }
    );
  }
  return {
    output: validated.value,
    dedupedExactCount: validated.dedupedExactCount,
  };
}

function extractValidationErrors(error: ReviewAgentOutputError | null): Array<{ path: string; message: string }> {
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

function buildFallbackAnalysisOutput(reason: string): ReviewAnalysisOutputV2 {
  return {
    findings: [],
    summary: `Structured model output was invalid after repair (${reason}); emitted fallback empty findings output.`,
    furtherPassesLowYield: true,
  };
}

function isGenericProviderCompletionSummary(summary: string): boolean {
  return /completed by .*agent endpoint/i.test(summary.trim());
}

function sanitizeErrorMessage(input: string): string {
  return redactReviewText(input) ?? '';
}

function isWorkerToWorkerFetchRestriction(status: number, responseBody: string): boolean {
  return status === 404 && /error\s*code\s*:\s*1042/i.test(responseBody);
}

function redactReviewText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const redacted = value
    .replace(/(authorization:\s*bearer\s+)[a-z0-9._-]+/gi, '$1[REDACTED]')
    .replace(GITHUB_TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(/((?:"|')?api[_-]?key(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
    .replace(/((?:"|')?token(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]');
  return redacted.length > 600 ? `${redacted.slice(0, 597)}...` : redacted;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function writeBundleBase64InChunks(sandbox: SandboxClient, bundleBytes: ArrayBuffer): Promise<void> {
  const bytes = new Uint8Array(bundleBytes);
  await runSandboxCommand(sandbox, `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`);

  let partIndex = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += BUNDLE_BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + BUNDLE_BASE64_CHUNK_BYTES, bytes.byteLength));
    const chunkBase64 = toBase64(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    const partPath = `${BUNDLE_BASE64_PART_PREFIX}.${String(partIndex).padStart(4, '0')}`;
    await sandbox.writeFile(partPath, chunkBase64);
    partIndex += 1;
  }

  await runSandboxCommand(sandbox, `cat ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}.* > ${shellQuote(BUNDLE_BASE64_PATH)}`);
}

async function hydrateReviewSandbox(sandbox: SandboxClient, sourceBytes: ArrayBuffer): Promise<void> {
  await runSandboxCommand(sandbox, `rm -rf ${shellQuote(WORKSPACE_ROOT)} && mkdir -p ${shellQuote(WORKSPACE_ROOT)}`);
  await writeBundleBase64InChunks(sandbox, sourceBytes);
  await runSandboxCommand(
    sandbox,
    `base64 -d ${shellQuote(BUNDLE_BASE64_PATH)} > ${shellQuote(BUNDLE_PATH)} && tar -xzf ${shellQuote(BUNDLE_PATH)} -C ${shellQuote(WORKSPACE_ROOT)}`
  );
  await runSandboxCommand(
    sandbox,
    `rm -f ${shellQuote(BUNDLE_BASE64_PATH)} ${shellQuote(BUNDLE_PATH)} ${shellQuote(BUNDLE_BASE64_PART_PREFIX)}*`
  );
}

function sanitizePromptInput(input: ReviewAgentPromptInput): ReviewAgentPromptInput {
  return {
    ...input,
    goal: redactReviewText(input.goal) ?? input.goal,
    constraints: input.constraints.map((item) => redactReviewText(item) ?? '').filter(Boolean),
    decisions: input.decisions.map((item) => redactReviewText(item) ?? '').filter(Boolean),
    intentSessionContext: input.intentSessionContext
      .map((item) => redactReviewText(item) ?? '')
      .filter(Boolean),
  };
}

function buildReviewAgentPrompt(input: ReviewAgentPromptInput): string {
  const promptDiffSnapshot = input.authoritativeDiffSnapshot !== undefined
    ? clampAuthoritativeDiffSnapshot(input.authoritativeDiffSnapshot, 32_000)
    : undefined;
  const context = input.reviewContext;

  const changedFiles = context.retrieval.changedFiles.map((file) => ({
    path: file.path,
    content: file.content,
    byteSize: file.byteSize,
  }));
  const relatedFiles = context.retrieval.relatedFiles.map((file) => ({
    path: file.path,
    content: file.content,
    byteSize: file.byteSize,
    coChangeFrequency: file.coChangeFrequency,
    supportingSessionIds: file.supportingSessionIds,
  }));
  const conventionFiles = context.retrieval.conventionFiles.map((file) => ({
    path: file.path,
    content: file.content,
    byteSize: file.byteSize,
  }));

  return [
    'You are Nimbus Review, a non-mutating code review agent.',
    'Analyze the provided full ReviewContext and return only actionable findings supported by code context.',
    'Never propose edits or run mutating commands. Prefer no findings over weak findings.',
    'Use only these tools when needed: list_files, read_file, diff_summary.',
    '',
    'Return your final answer as raw JSON with this shape and no surrounding prose:',
    '{',
    '  "findings": [',
    '    {',
    '      "severity": "info|low|medium|high|critical",',
    '      "category": "security|logic|style|breaking-change",',
    '      "passType": "single|security|logic|style|breaking-change",',
    '      "locations": [{ "filePath": string, "startLine": number|null, "endLine": number|null }],',
    '      "description": string,',
    '      "suggestedFix": string',
    '    }',
    '  ],',
    '  "summary": string,',
    '  "furtherPassesLowYield": boolean',
    '}',
    '',
    'Critical field typing requirements:',
    '- summary must be a plain JSON string value (not an object, array, number, or nested structure).',
    '- furtherPassesLowYield must be exactly true or false (JSON boolean only; do not use strings like "true"/"false" and do not use null).',
    '- Do not return summary as an object (for example with riskLevel/recommendation).',
    '- Do not return summaryText or any alternate summary field; only return summary.',
    '',
    'Phase 2 constraints:',
    '- passType must be set explicitly on every finding and be "single" in this phase.',
    '- category must be one of security, logic, style, breaking-change.',
    '- locations must contain at least one location; file-only location is allowed with null line values.',
    '- findings must be self-contained and actionable without rereading the diff.',
    '',
    'Context weighting rules:',
    '- Changed files are directly modified in this commit and should get highest weight.',
    '- Related files are historical co-change context from Entire checkpoint session history and are not directly modified in this commit.',
    '- Use related files to understand coupling/impact, but do not treat them as direct modified evidence.',
    '',
    `Review Context ID: ${context.id}`,
    `Review ID: ${input.reviewId}`,
    `Workspace ID: ${input.workspaceId}`,
    `Deployment ID: ${input.deploymentId}`,
    `Checkpoint: ${context.checkpoint.checkpointId} (${context.checkpoint.branch})`,
    `Checkpoint Session ID: ${context.checkpoint.session.sessionId}`,
    `Goal: ${input.goal}`,
    `Constraints: ${JSON.stringify(input.constraints)}`,
    `Decisions: ${JSON.stringify(input.decisions)}`,
    input.intentSessionContext.length > 0
      ? `Intent session context excerpts: ${JSON.stringify(input.intentSessionContext)}`
      : 'Intent session context excerpts: []',
    `Deployment summary: ${JSON.stringify(input.deploymentSummary)}`,
    `Evidence catalog: ${JSON.stringify(input.evidenceCatalog)}`,
    '',
    `Diff hunks (direct changes): ${boundedJson(context.retrieval.diffHunks, PROMPT_DIFF_HUNKS_MAX_BYTES)}`,
    `Changed files (directly modified): ${boundedJson(changedFiles, PROMPT_CHANGED_FILES_MAX_BYTES)}`,
    `Related files (historical co-change context only): ${boundedJson(relatedFiles, PROMPT_RELATED_FILES_MAX_BYTES)}`,
    `Convention/config files: ${boundedJson(conventionFiles, PROMPT_CONVENTION_FILES_MAX_BYTES)}`,
    `Co-change retrieval stats: ${JSON.stringify(context.retrieval.coChange)}`,
    `Review context stats: ${JSON.stringify(context.stats)}`,
    promptDiffSnapshot !== undefined
      ? `Authoritative deployed diff snapshot: ${JSON.stringify(promptDiffSnapshot)}`
      : 'Authoritative deployed diff snapshot: unavailable',
    `Initial root listing: ${JSON.stringify(input.rootListing)}`,
    `Initial diff snapshot: ${JSON.stringify(input.diffSnapshot)}`,
    '',
    'If you cannot justify a concrete issue, return an empty findings array with a concise summary.',
  ].join('\n');
}

function clampText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }
  const sliced = bytes.slice(0, Math.max(0, maxBytes - 3));
  return { text: new TextDecoder().decode(sliced) + '...', truncated: true };
}

function clampAuthoritativeDiffSnapshot(value: unknown, maxBytes: number): unknown {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return value;
  }

  const patch = typeof record.patch === 'string' ? record.patch : null;
  if (!patch) {
    return value;
  }

  const clamped = clampText(patch, maxBytes);
  return {
    ...record,
    patch: clamped.text,
    truncated: clamped.truncated || Boolean(record.truncated),
  };
}

function sanitizeToolValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactReviewText(value) ?? '';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((result, [key, nested]) => {
      result[key] = sanitizeToolValue(nested);
      return result;
    }, {});
  }
  return value;
}

function sanitizeToolContext(context: ReviewToolContext): ReviewToolContext {
  return {
    request: sanitizeToolValue(context.request) as Record<string, unknown>,
    result: sanitizeToolValue(context.result),
  };
}

function buildToolHistoryLabel(action: Extract<ReviewAgentAction, { type: 'tool' }>): string {
  return `tool:${action.tool} ${JSON.stringify(action.args)}`;
}

function buildListFilesCommand(absolutePath: string, rootPath: string): string {
  return `python3 - ${shellQuote(absolutePath)} ${shellQuote(rootPath)} <<'PY'
import json
import os
import sys

path = sys.argv[1]
root = sys.argv[2]
root_real = os.path.realpath(root)
target = path if os.path.isabs(path) else os.path.join(root, path)
target_real = os.path.realpath(target)
if os.path.commonpath([root_real, target_real]) != root_real:
    print(json.dumps({'error':'path_escape'}))
    raise SystemExit(0)
if not os.path.exists(target_real):
    print(json.dumps({'error':'not_found'}))
    raise SystemExit(0)
if not os.path.isdir(target_real):
    print(json.dumps({'error':'not_directory'}))
    raise SystemExit(0)
entries = []
for name in sorted(os.listdir(target_real)):
    full = os.path.join(target_real, name)
    entries.append({'name': name, 'type': 'directory' if os.path.isdir(full) else 'file'})
print(json.dumps({'entries': entries[:200]}))
PY`;
}

function buildReadFileCommand(absolutePath: string, maxBytes: number, rootPath: string): string {
  return `python3 - ${shellQuote(absolutePath)} ${maxBytes} ${shellQuote(rootPath)} <<'PY'
import json
import os
import sys

path = sys.argv[1]
max_bytes = int(sys.argv[2])
root = sys.argv[3]
root_real = os.path.realpath(root)
target = path if os.path.isabs(path) else os.path.join(root, path)
target_real = os.path.realpath(target)
if os.path.commonpath([root_real, target_real]) != root_real:
    print(json.dumps({'error':'path_escape'}))
    raise SystemExit(0)
if not os.path.exists(target_real):
    print(json.dumps({'error':'not_found'}))
    raise SystemExit(0)
if not os.path.isfile(target_real):
    print(json.dumps({'error':'not_file'}))
    raise SystemExit(0)
with open(target_real, 'rb') as f:
    data = f.read(max_bytes + 1)
truncated = len(data) > max_bytes
if truncated:
    data = data[:max_bytes]
text = data.decode('utf-8', errors='replace')
print(json.dumps({'content': text, 'truncated': truncated, 'bytes': len(data)}))
PY`;
}

function assertWorkspacePath(pathInput: string, policy: ReviewCommandPolicy): string {
  const trimmed = (pathInput || '.').trim();
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.includes('\u0000')) {
    throw new ReviewPolicyError('Path contains null bytes');
  }
  if (normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new ReviewPolicyError('Path escapes workspace root');
  }
  const collapsed = normalized
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
  if (collapsed.startsWith('..')) {
    throw new ReviewPolicyError('Path escapes workspace root');
  }
  if (collapsed === '.git' || collapsed.startsWith('.git/')) {
    throw new ReviewPolicyError('Access to .git is denied by policy');
  }
  return `${policy.rootPath}/${collapsed}`;
}

async function runSandboxCommand(
  sandbox: SandboxClient,
  command: string,
  timeout?: number
): Promise<{ stdout: string; stderr: string }> {
  const result = await sandbox.exec(command, { timeout });
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Sandbox command failed with exit ${result.exitCode}: ${output || 'No output'}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function executeReviewTool(
  sandbox: SandboxClient,
  action: Extract<ReviewAgentAction, { type: 'tool' }>,
  policy: ReviewCommandPolicy,
  maxFileBytes: number,
  authoritativeDiffSnapshot?: unknown
): Promise<ReviewToolContext> {
  if (action.tool === 'list_files') {
    const absolutePath = assertWorkspacePath(action.args.path ?? '.', policy);
    const output = await runSandboxCommand(
      sandbox,
      buildListFilesCommand(absolutePath, policy.rootPath)
    );
    return {
      request: { path: action.args.path ?? '.' },
      result: JSON.parse(output.stdout || '{}'),
    };
  }

  if (action.tool === 'read_file') {
    const absolutePath = assertWorkspacePath(action.args.path, policy);
    const maxBytes = typeof action.args.maxBytes === 'number' && Number.isFinite(action.args.maxBytes)
      ? Math.max(1, Math.min(maxFileBytes, Math.floor(action.args.maxBytes)))
      : maxFileBytes;
    const output = await runSandboxCommand(
      sandbox,
      buildReadFileCommand(absolutePath, maxBytes, policy.rootPath)
    );
    return {
      request: { path: action.args.path, maxBytes },
      result: JSON.parse(output.stdout || '{}'),
    };
  }

  if (action.tool === 'run_command') {
    return {
      request: { command: action.args.command, timeoutMs: action.args.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS },
      result: {
        error: 'run_command is disabled in review mode; use list_files, read_file, or diff_summary only',
        disabled: true,
      },
    };
  }

  if (action.tool === 'write_file') {
    return {
      request: { path: action.args.path },
      result: {
        ok: false,
        error: 'write_file is disabled in review mode; use read-only tools and return findings only',
        path: action.args.path,
      },
    };
  }

  if (authoritativeDiffSnapshot !== undefined) {
    const maxBytes = typeof action.args.maxBytes === 'number' && Number.isFinite(action.args.maxBytes)
      ? Math.max(1_024, Math.min(policy.maxOutputBytes, Math.floor(action.args.maxBytes)))
      : Math.min(policy.maxOutputBytes, 64_000);
    return {
      request: { maxBytes },
      result: clampAuthoritativeDiffSnapshot(authoritativeDiffSnapshot, maxBytes),
    };
  }

  return {
    request: { maxBytes: typeof action.args.maxBytes === 'number' ? action.args.maxBytes : undefined },
    result: {
      error: 'authoritative diff snapshot unavailable',
      changedFiles: [],
      patch: '',
      truncated: false,
    },
  };
}

class CloudflareAgentSdkReviewProvider implements ReviewAgentProvider {
  constructor(
    private readonly endpoint: string,
    private readonly authToken: string | null
  ) {}

  async next(input: {
    prompt: string;
    model: string;
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
  }): Promise<ReviewAgentAction> {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort('review_provider_timeout');
        reject(new Error('review_provider_timeout'));
      }, REVIEW_PROVIDER_TIMEOUT_MS);
    });
    let response: Response;
    try {
      response = await Promise.race([
        fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
          },
          body: JSON.stringify({
            mode: 'workspace_task',
            prompt: input.prompt,
            model: input.model,
            maxSteps: input.maxSteps,
            step: input.step,
            history: input.history,
          }),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(
          `Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds`
        );
      }
      throw error;
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }

    if (!response.ok) {
      const providerErrorBody = redactReviewText(await response.text()) ?? '';
      if (isWorkerToWorkerFetchRestriction(response.status, providerErrorBody)) {
        throw new Error(
          `Review analysis provider request blocked by Cloudflare Worker-to-Worker fetch restriction (error code 1042). Enable the 'global_fetch_strictly_public' compatibility flag on this worker or switch to a service binding.${providerErrorBody ? ` Provider response: ${providerErrorBody}` : ''}`
        );
      }
      if (response.status >= 500 || response.status === 429) {
        throw new Error(
          `Review analysis provider temporarily unavailable (status ${response.status})${providerErrorBody ? `: ${providerErrorBody}` : ''}`
        );
      }
      throw new Error(
        `Review analysis provider request failed with status ${response.status}${providerErrorBody ? `: ${providerErrorBody}` : ''}`
      );
    }

    const parsed = (await response.json()) as unknown;
    const action = asRecord(parsed).action;
    return validateReviewAgentAction(action);
  }
}

function validateReviewAgentAction(action: unknown): ReviewAgentAction {
  const record = asRecord(action);
  if (record.type === 'final') {
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!summary) {
      throw new ReviewPolicyError('Final action requires a non-empty summary');
    }
    return { type: 'final', summary };
  }
  if (record.type !== 'tool') {
    throw new ReviewPolicyError('Action type must be tool or final');
  }

  const tool = typeof record.tool === 'string' ? record.tool : '';
  const args = asRecord(record.args);
  switch (tool) {
    case 'list_files':
      if (args.path !== undefined && typeof args.path !== 'string') {
        throw new ReviewPolicyError('list_files.path must be a string when provided');
      }
      return { type: 'tool', tool, args };
    case 'read_file':
      if (typeof args.path !== 'string' || !args.path.trim()) {
        throw new ReviewPolicyError('read_file.path is required');
      }
      if (args.maxBytes !== undefined && (typeof args.maxBytes !== 'number' || !Number.isFinite(args.maxBytes))) {
        throw new ReviewPolicyError('read_file.maxBytes must be a number when provided');
      }
      return { type: 'tool', tool, args: { path: args.path, maxBytes: args.maxBytes as number | undefined } };
    case 'write_file':
      if (typeof args.path !== 'string' || !args.path.trim()) {
        throw new ReviewPolicyError('write_file.path is required');
      }
      return { type: 'tool', tool, args: { path: args.path, content: typeof args.content === 'string' ? args.content : undefined } };
    case 'run_command':
      if (typeof args.command !== 'string' || !args.command.trim()) {
        throw new ReviewPolicyError('run_command.command is required');
      }
      if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs))) {
        throw new ReviewPolicyError('run_command.timeoutMs must be a number when provided');
      }
      return { type: 'tool', tool, args: { command: args.command, timeoutMs: args.timeoutMs as number | undefined } };
    case 'diff_summary':
      if (args.maxBytes !== undefined && (typeof args.maxBytes !== 'number' || !Number.isFinite(args.maxBytes))) {
        throw new ReviewPolicyError('diff_summary.maxBytes must be a number when provided');
      }
      return { type: 'tool', tool, args: { maxBytes: args.maxBytes as number | undefined } };
    default:
      throw new ReviewPolicyError(`Tool '${tool}' is not supported in review mode`);
  }
}

async function getWorkspaceSandbox(env: Env, sandboxId: string): Promise<SandboxClient> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(env.Sandbox as DurableObjectNamespace<Sandbox>, sandboxId) as SandboxClient;
}

let sandboxResolver: (env: Env, sandboxId: string) => Promise<SandboxClient> = getWorkspaceSandbox;

export function setReviewAnalysisSandboxResolverForTests(
  resolver: ((env: Env, sandboxId: string) => Promise<SandboxClient>) | null
): void {
  sandboxResolver = resolver ?? getWorkspaceSandbox;
}

async function snapshotInitialContext(sandbox: SandboxClient, maxFileBytes: number): Promise<{
  rootListing: unknown;
  diffSnapshot: unknown;
}> {
  const policy: ReviewCommandPolicy = {
    commandAllow: [],
    commandDeny: [],
    maxCommandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_REVIEW_MAX_OUTPUT_BYTES,
    rootPath: WORKSPACE_ROOT,
  };

  const rootListing = await executeReviewTool(
    sandbox,
    { type: 'tool', tool: 'list_files', args: { path: '.' } },
    policy,
    maxFileBytes
  );
  const diffSnapshot = await executeReviewTool(
    sandbox,
    { type: 'tool', tool: 'diff_summary', args: { maxBytes: 32_000 } },
    policy,
    maxFileBytes
  );
  return { rootListing, diffSnapshot };
}

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
  const effectiveMaxFileBytes = typeof input.maxFileBytes === 'number' && Number.isFinite(input.maxFileBytes)
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

  const sandbox = await sandboxResolver(env, input.sandboxId);
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
      results.push({
        path,
        content,
        bytes,
        truncated,
        error,
      });
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

  const sandbox = await sandboxResolver(env, input.deploymentSandboxId);
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

    const provider = new CloudflareAgentSdkReviewProvider(endpoint, authToken);
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
        });
      }
      const action = await provider.next({
        prompt,
        model,
        maxSteps,
        step,
        history,
      });

      if (action.type === 'final') {
        if (input.onLifecycleEvent) {
          await input.onLifecycleEvent('review_analysis_model_output_received', {
            step,
            repairAttempted,
          });
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
            await input.onLifecycleEvent('review_analysis_repair_output_received', {
              validationErrorCount,
              valid: true,
            });
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
            const wrapped = new ReviewAgentOutputError(
              'Review agent returned provider completion text instead of structured JSON; applying schema repair/fallback path'
            ).withCode('review_analysis_invalid_output', {
              errors: [{ path: '$', message: 'Provider completion summary returned instead of required JSON payload.' }],
            });
            error = wrapped;
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
              await input.onLifecycleEvent('review_analysis_repair_requested', {
                validationErrorCount,
              });
            }
            history.push({
              role: 'assistant',
              content: `final_output_validator: output failed schema; return corrected JSON only. Fix exactly these validation errors: ${JSON.stringify(
                validationErrors
              )}. Ensure summary is a plain string and furtherPassesLowYield is a JSON boolean true|false.`,
            });
            history.push({
              role: 'tool',
              tool: 'final_output_validator',
              output: {
                ok: false,
                error: 'Output must match ReviewAnalysisOutputV2 exactly.',
                requiredShape: {
                  findings: [
                    {
                      severity: 'info|low|medium|high|critical',
                      category: 'security|logic|style|breaking-change',
                      passType: 'single|security|logic|style|breaking-change',
                      locations: [{ filePath: 'string', startLine: 'number|null', endLine: 'number|null' }],
                      description: 'string',
                      suggestedFix: 'string',
                    },
                  ],
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

export function formatReviewAnalysisError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeErrorMessage(message);
}
