import { z } from 'zod';

type AgentHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; output: unknown };

type ReviewReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export type AgentAction =
  | { type: 'tool'; tool: 'list_files'; args: { path?: string } }
  | { type: 'tool'; tool: 'read_file'; args: { path: string; maxBytes?: number } }
  | { type: 'tool'; tool: 'read_batch'; args: { paths: string[]; maxBytes?: number } }
  | {
      type: 'tool';
      tool: 'search_code';
      args: { query: string; path?: string; maxResults?: number; maxBytesPerFile?: number; caseSensitive?: boolean };
    }
  | { type: 'tool'; tool: 'write_file'; args: { path: string; content: string } }
  | { type: 'tool'; tool: 'run_command'; args: { command: string; timeoutMs?: number } }
  | { type: 'tool'; tool: 'diff_summary'; args: { maxBytes?: number } }
  | { type: 'complete'; finalOutput?: unknown; summary?: string | null }
  | { type: 'final'; summary: string };

export interface AgentRequest {
  mode?: string;
  prompt?: string;
  model?: string;
  reasoningEffort?: ReviewReasoningEffort;
  maxSteps?: number;
  step?: number;
  history?: AgentHistoryEntry[];
  forceComplete?: boolean;
}

export interface AgentEnv {
  OPENROUTER_API_KEY?: string;
  DEFAULT_MODEL?: string;
  AGENT_SDK_AUTH_TOKEN?: string;
  OPENROUTER_HTTP_REFERER?: string;
  OPENROUTER_X_TITLE?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_BYOK_ALIAS?: string;
  AI_GATEWAY_COLLECT_LOG_PAYLOAD?: string;
}

export class AgentEndpointError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(code);
    this.name = 'AgentEndpointError';
  }
}

export interface ReviewOutputV2 {
  findings: unknown[];
  summary: string;
  furtherPassesLowYield: boolean;
}

interface AiGatewayConfig {
  baseUrl: string;
  authToken: string;
  byokAlias: string | null;
  collectLogPayload: boolean;
}

const REVIEW_FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
const REVIEW_FINDING_CATEGORIES = ['security', 'logic', 'style', 'breaking-change'] as const;

const reviewLocationSchema = z
  .object({
    filePath: z.string().transform((value) => value.trim().replaceAll('\\', '/')).pipe(z.string().min(1)),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
  })
  .superRefine((value, ctx) => {
    const startLine = value.startLine;
    const endLine = value.endLine;
    const hasNullPair = startLine === null && endLine === null;
    const hasIntegerPair = startLine !== null && endLine !== null && Number.isInteger(startLine) && Number.isInteger(endLine);
    if (!hasNullPair && !hasIntegerPair) {
      ctx.addIssue({ code: 'custom', path: [], message: 'startLine/endLine must both be null or both be positive integers' });
      return;
    }
    if (hasIntegerPair && endLine < startLine) {
      ctx.addIssue({ code: 'custom', path: [], message: 'endLine must be greater than or equal to startLine' });
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
  return /\b(timeout|retry|deadline|interval|boundary|poll)\b/i.test(text);
}

function hasBoundaryAndStatusEvidence(failingScenario: string, evidence: string): boolean {
  const combined = `${failingScenario}\n${evidence}`;
  const hasBoundary = /\b\d+\b|>=|<=|>|<|==|\b(deadline|interval|timeout|ms|second|seconds)\b/i.test(combined);
  const hasStatusOutcome = /\b(status|queued|running|succeeded|failed|cancelled|return|returns|result)\b/i.test(combined);
  return hasBoundary && hasStatusOutcome;
}

const reviewFindingSchema = z
  .object({
    severity: z.enum(REVIEW_FINDING_SEVERITIES),
    category: z.enum(REVIEW_FINDING_CATEGORIES),
    passType: z.literal('single'),
    locations: z.array(reviewLocationSchema).min(1),
    description: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
    suggestedFix: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
    failingScenario: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
    evidence: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
    guardGap: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
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

const reviewOutputV2Schema = z.object({
  findings: z.array(reviewFindingSchema),
  summary: z.string().transform((value) => value.trim()).pipe(z.string().min(1)),
  furtherPassesLowYield: z.boolean(),
});

const reviewOutputV2JsonSchema = {
  name: 'ReviewAnalysisOutputV2',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            severity: { type: 'string', enum: [...REVIEW_FINDING_SEVERITIES] },
            category: { type: 'string', enum: [...REVIEW_FINDING_CATEGORIES] },
            passType: { type: 'string', enum: ['single'] },
            locations: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  filePath: { type: 'string' },
                  startLine: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                  endLine: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                },
                required: ['filePath', 'startLine', 'endLine'],
              },
            },
            description: { type: 'string' },
            suggestedFix: { type: 'string' },
            failingScenario: { type: 'string' },
            evidence: { type: 'string' },
            guardGap: { type: 'string' },
          },
          required: [
            'severity',
            'category',
            'passType',
            'locations',
            'description',
            'suggestedFix',
            'failingScenario',
            'evidence',
            'guardGap',
          ],
        },
      },
      summary: { type: 'string' },
      furtherPassesLowYield: { type: 'boolean' },
    },
    required: ['findings', 'summary', 'furtherPassesLowYield'],
  },
} as const;

const REVIEW_TOOL_NAMES = ['list_files', 'read_file', 'read_batch', 'diff_summary', 'search_code'] as const;
const WORKSPACE_TASK_TOOL_NAMES = ['list_files', 'read_file', 'write_file', 'run_command', 'diff_summary'] as const;
const CLOUDFLARE_AI_GATEWAY_HOST = 'https://gateway.ai.cloudflare.com';
const AGENT_HISTORY_RECENT_ENTRIES = 10;
const AGENT_HISTORY_MAX_BYTES = 40_000;
const AGENT_HISTORY_PREVIEW_MAX_BYTES = 640;
const AGENT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const AI_GATEWAY_REQUEST_TIMEOUT_MS = 90_000;

const reviewAgentActionJsonSchema = {
  name: 'ReviewAgentAction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['tool', 'complete'] },
      tool: {
        anyOf: [{ type: 'string', enum: [...REVIEW_TOOL_NAMES] }, { type: 'null' }],
      },
      args: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              paths: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
              maxBytes: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              query: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              maxResults: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              maxBytesPerFile: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              caseSensitive: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
            },
            required: ['path', 'paths', 'maxBytes', 'query', 'maxResults', 'maxBytesPerFile', 'caseSensitive'],
          },
          { type: 'null' },
        ],
      },
      summary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      finalOutput: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    severity: { type: 'string', enum: [...REVIEW_FINDING_SEVERITIES] },
                    category: { type: 'string', enum: [...REVIEW_FINDING_CATEGORIES] },
                    passType: { type: 'string', enum: ['single'] },
                    locations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          filePath: { type: 'string' },
                          startLine: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                          endLine: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
                        },
                        required: ['filePath', 'startLine', 'endLine'],
                      },
                    },
                    description: { type: 'string' },
                    suggestedFix: { type: 'string' },
                    failingScenario: { type: 'string' },
                    evidence: { type: 'string' },
                    guardGap: { type: 'string' },
                  },
                  required: [
                    'severity',
                    'category',
                    'passType',
                    'locations',
                    'description',
                    'suggestedFix',
                    'failingScenario',
                    'evidence',
                    'guardGap',
                  ],
                },
              },
              summary: { type: 'string' },
              furtherPassesLowYield: { type: 'boolean' },
            },
            required: ['findings', 'summary', 'furtherPassesLowYield'],
          },
          { type: 'null' },
        ],
      },
    },
    required: ['type', 'tool', 'args', 'summary', 'finalOutput'],
  },
} as const;

const workspaceTaskActionJsonSchema = {
  name: 'WorkspaceTaskAction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['tool', 'final'] },
      tool: {
        anyOf: [{ type: 'string', enum: [...WORKSPACE_TASK_TOOL_NAMES] }, { type: 'null' }],
      },
      args: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              content: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              command: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              maxBytes: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              timeoutMs: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            },
            required: ['path', 'content', 'command', 'maxBytes', 'timeoutMs'],
          },
          { type: 'null' },
        ],
      },
      summary: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['type', 'tool', 'args', 'summary'],
  },
} as const;

function normalizeTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseBooleanEnvValue(value: string | undefined | null, defaultValue: boolean): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return defaultValue;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}

function clampText(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let end = maxBytes;
  while (end > 0) {
    try {
      strictDecoder.decode(bytes.subarray(0, end));
      break;
    } catch {
      end -= 1;
    }
  }

  return new TextDecoder().decode(bytes.subarray(0, end));
}

function clampPreview(value: string, maxBytes: number = AGENT_HISTORY_PREVIEW_MAX_BYTES): string {
  return clampText(value, maxBytes);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function summarizeHistoryEntry(entry: AgentHistoryEntry): unknown {
  if (entry.role === 'assistant') {
    return {
      role: 'assistant',
      content: clampPreview(entry.content, 1_200),
    };
  }

  const output = asRecord(entry.output);
  const request = asRecord(output.request);
  const result = asRecord(output.result);
  const summary: Record<string, unknown> = {
    role: 'tool',
    tool: entry.tool,
  };
  if (typeof request.path === 'string') {
    summary.path = request.path;
  }
  if (Array.isArray(request.paths)) {
    summary.paths = request.paths.slice(0, 6);
  }
  if (typeof request.query === 'string' && request.query.trim()) {
    summary.query = clampPreview(request.query.trim(), 200);
  }
  if (typeof result.error === 'string' && result.error.trim()) {
    summary.error = clampPreview(result.error.trim(), 200);
  }
  if (typeof result.content === 'string' && result.content.trim()) {
    summary.preview = clampPreview(result.content, 320);
  }
  if (Array.isArray(result.matches)) {
    summary.matches = result.matches.slice(0, 4);
  }
  if (Array.isArray(result.files)) {
    summary.files = result.files.slice(0, 3);
  }
  if (typeof result.bytes === 'number' && Number.isFinite(result.bytes)) {
    summary.bytes = Math.floor(result.bytes);
  }
  if (typeof result.scannedFiles === 'number' && Number.isFinite(result.scannedFiles)) {
    summary.scannedFiles = Math.floor(result.scannedFiles);
  }
  if (typeof result.truncated === 'boolean') {
    summary.truncated = result.truncated;
  }
  return summary;
}

function buildHistorySummary(history: AgentHistoryEntry[]): string {
  const recent = history.slice(-AGENT_HISTORY_RECENT_ENTRIES).map(summarizeHistoryEntry);
  const envelope = {
    omittedEntryCount: Math.max(0, history.length - recent.length),
    recent,
  };
  return clampText(JSON.stringify(envelope), AGENT_HISTORY_MAX_BYTES);
}

function isAiGatewayModel(model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed) {
    return false;
  }
  return /^[a-z0-9][a-z0-9._-]*\/.+$/i.test(trimmed) && !/^@(cf|hf)\//.test(trimmed);
}

function isOpenAiGatewayModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith('openai/');
}

function normalizeOpenAiGatewayModel(model: string): string {
  return isOpenAiGatewayModel(model) ? model.trim().slice('openai/'.length) : model.trim();
}

function usesOpenAiResponsesApi(model: string): boolean {
  const normalized = normalizeOpenAiGatewayModel(model).toLowerCase();
  return isOpenAiGatewayModel(model) && normalized.includes('codex');
}

function resolveOpenAiGatewayBaseUrl(baseUrl: string): string {
  return normalizeTrailingSlash(baseUrl).replace(/\/compat$/i, '/openai');
}

function parseOpenAiResponsesContent(payload: unknown): string {
  const record = asRecord(payload);
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const itemRecord = asRecord(item);
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const part of content) {
      const entry = asRecord(part);
      if (typeof entry.text === 'string' && entry.text.trim()) {
        parts.push(entry.text.trim());
      }
    }
  }
  return parts.join('').trim();
}

function resolveAiGatewayConfig(env: AgentEnv, options?: { authToken?: string | null }): AiGatewayConfig | null {
  const authToken =
    (typeof options?.authToken === 'string' ? options.authToken.trim() : '') ||
    (typeof env.AI_GATEWAY_AUTH_TOKEN === 'string' ? env.AI_GATEWAY_AUTH_TOKEN.trim() : '');
  if (!authToken) {
    return null;
  }

  const configuredBaseUrl = typeof env.AI_GATEWAY_BASE_URL === 'string' ? env.AI_GATEWAY_BASE_URL.trim() : '';
  let baseUrl = '';
  if (configuredBaseUrl) {
    baseUrl = normalizeTrailingSlash(configuredBaseUrl).replace(/\/chat\/completions$/i, '');
  } else {
    const accountId = typeof env.AI_GATEWAY_ACCOUNT_ID === 'string' ? env.AI_GATEWAY_ACCOUNT_ID.trim() : '';
    if (!accountId) {
      return null;
    }
    const gatewayId = (typeof env.AI_GATEWAY_ID === 'string' ? env.AI_GATEWAY_ID.trim() : '') || 'default';
    baseUrl = `${CLOUDFLARE_AI_GATEWAY_HOST}/v1/${accountId}/${gatewayId}/compat`;
  }

  return {
    baseUrl,
    authToken,
    byokAlias:
      typeof env.AI_GATEWAY_BYOK_ALIAS === 'string' && env.AI_GATEWAY_BYOK_ALIAS.trim()
        ? env.AI_GATEWAY_BYOK_ALIAS.trim()
        : null,
    collectLogPayload: parseBooleanEnvValue(env.AI_GATEWAY_COLLECT_LOG_PAYLOAD, false),
  };
}

function hasToolOutput(history: AgentHistoryEntry[], tool: string): boolean {
  return history.some((entry) => entry.role === 'tool' && entry.tool === tool);
}

function isReviewPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes('you are nimbus review') ||
    normalized.includes('furtherpasseslowyield') ||
    normalized.includes('return your final answer as raw json')
  );
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractJsonObjectCandidate(raw: string): string | null {
  const source = raw.trim();
  const first = source.indexOf('{');
  if (first < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(first, i + 1).trim();
      }
    }
  }
  return null;
}

function parseJsonCandidate(content: string): unknown {
  try {
    return JSON.parse(stripCodeFences(content));
  } catch {
    const candidate = extractJsonObjectCandidate(content);
    if (!candidate) {
      throw new AgentEndpointError('invalid_model_output', 422, {
        errors: [{ path: '$', message: 'model response was not valid JSON' }],
        preview: content.slice(0, 500),
      });
    }
    try {
      return JSON.parse(candidate);
    } catch {
      throw new AgentEndpointError('invalid_model_output', 422, {
        errors: [{ path: '$', message: 'model response was not valid JSON' }],
        preview: content.slice(0, 500),
      });
    }
  }
}

function resolveOpenRouterModel(requestModel: string | undefined, defaultModel: string | undefined): string {
  const raw = (typeof requestModel === 'string' ? requestModel : '').trim() || (defaultModel ?? '').trim();
  if (!raw) {
    return 'anthropic/claude-sonnet-4-5';
  }
  if (raw === 'sonnet-4.5') {
    return 'anthropic/claude-sonnet-4-5';
  }
  return raw;
}

function buildWorkspaceTaskStepPrompt(input: {
  prompt: string;
  maxSteps: number;
  step: number;
  history: AgentHistoryEntry[];
}): string {
  return [
    input.prompt,
    '',
    'Task loop instructions:',
    `- Current step: ${input.step} of ${input.maxSteps}.`,
    '- You are inside Nimbus\'s internal workspace remediation loop.',
    '- Decide whether to request exactly ONE tool call or finish with type="final".',
    '- Tools available: list_files, read_file, write_file, diff_summary, run_command.',
    '- Prefer using the exact file paths and file snapshots already present in the task prompt.',
    '- If the prompt already includes the full current file contents for the target file and the fix is straightforward, you may go directly to write_file.',
    '- Do not stop after list_files or a failed read_file unless the prompt truly lacks enough information to continue safely.',
    '- Use write_file with the FULL desired file contents, not a patch.',
    '- Use run_command only when the file tools are insufficient.',
    '- Return ONLY a valid action object matching the response schema.',
    '',
    `Prior loop history JSON: ${buildHistorySummary(input.history)}`,
  ].join('\n');
}

function buildReviewAnalysisStepPrompt(input: {
  prompt: string;
  maxSteps: number;
  step: number;
  history: AgentHistoryEntry[];
  forceComplete: boolean;
}): string {
  return [
    input.prompt,
    '',
    'Agent loop instructions:',
    `- Current step: ${input.step} of ${input.maxSteps}.`,
    '- You are inside Nimbus\'s internal review harness loop.',
    '- Decide whether to request ONE read-only tool call or finish with complete structured review JSON.',
    '- Tools available: list_files, read_file, read_batch, diff_summary, search_code.',
    '- Never request write_file or run_command.',
    input.forceComplete
      ? '- HARD REQUIREMENT: return type="complete" now. Do not request any tool.'
      : '- If critical evidence is still missing, request one targeted tool call; otherwise finish.',
    '- For type="complete", set finalOutput to a JSON object payload for ReviewAnalysisOutputV2.',
    '- For type="complete", set summary to null or a short plain-text note (never structured payload).',
    '- Return ONLY a valid action object matching the response schema.',
    '',
    `Prior loop history JSON: ${buildHistorySummary(input.history)}`,
  ].join('\n');
}

function validateReviewAgentAction(payload: unknown): AgentAction {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!record) {
    throw new AgentEndpointError('invalid_model_output', 422, {
      errors: [{ path: '$', message: 'review action must be an object' }],
    });
  }

  if (record.type === 'complete') {
    const summary = typeof record.summary === 'string' ? record.summary : null;
    const finalOutput = record.finalOutput ?? null;
    return {
      type: 'complete',
      ...(summary !== null ? { summary } : {}),
      ...(finalOutput !== null ? { finalOutput } : {}),
    };
  }

  if (record.type !== 'tool') {
    throw new AgentEndpointError('invalid_model_output', 422, {
      errors: [{ path: '$.type', message: 'review action type must be tool or complete' }],
    });
  }

  const tool = typeof record.tool === 'string' ? record.tool : '';
  const args =
    record.args && typeof record.args === 'object' && !Array.isArray(record.args)
      ? (record.args as Record<string, unknown>)
      : {};

  switch (tool) {
    case 'list_files': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      return path ? { type: 'tool', tool, args: { path } } : { type: 'tool', tool, args: {} };
    }
    case 'read_file': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) {
        break;
      }
      const maxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? args.maxBytes : undefined;
      return { type: 'tool', tool, args: maxBytes !== undefined ? { path, maxBytes } : { path } };
    }
    case 'read_batch': {
      const paths = Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
      if (paths.length === 0) {
        break;
      }
      const maxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? args.maxBytes : undefined;
      return { type: 'tool', tool, args: maxBytes !== undefined ? { paths, maxBytes } : { paths } };
    }
    case 'search_code': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        break;
      }
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      const maxResults = typeof args.maxResults === 'number' && Number.isFinite(args.maxResults) ? args.maxResults : undefined;
      const maxBytesPerFile =
        typeof args.maxBytesPerFile === 'number' && Number.isFinite(args.maxBytesPerFile) ? args.maxBytesPerFile : undefined;
      const caseSensitive = typeof args.caseSensitive === 'boolean' ? args.caseSensitive : undefined;
      return {
        type: 'tool',
        tool,
        args: {
          query,
          ...(path ? { path } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
          ...(maxBytesPerFile !== undefined ? { maxBytesPerFile } : {}),
          ...(caseSensitive !== undefined ? { caseSensitive } : {}),
        },
      };
    }
    case 'diff_summary': {
      const maxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? args.maxBytes : undefined;
      return { type: 'tool', tool, args: maxBytes !== undefined ? { maxBytes } : {} };
    }
    default:
      break;
  }

  throw new AgentEndpointError('invalid_model_output', 422, {
    errors: [{ path: '$', message: `invalid review action for tool '${tool || 'unknown'}'` }],
  });
}

function validateWorkspaceTaskAction(payload: unknown): AgentAction {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  if (!record) {
    throw new AgentEndpointError('invalid_model_output', 422, {
      errors: [{ path: '$', message: 'workspace task action must be an object' }],
    });
  }

  if (record.type === 'final') {
    const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
    if (!summary) {
      throw new AgentEndpointError('invalid_model_output', 422, {
        errors: [{ path: '$.summary', message: 'final workspace task action requires a non-empty summary' }],
      });
    }
    return { type: 'final', summary };
  }

  if (record.type !== 'tool') {
    throw new AgentEndpointError('invalid_model_output', 422, {
      errors: [{ path: '$.type', message: 'workspace task action type must be tool or final' }],
    });
  }

  const tool = typeof record.tool === 'string' ? record.tool : '';
  const args =
    record.args && typeof record.args === 'object' && !Array.isArray(record.args)
      ? (record.args as Record<string, unknown>)
      : {};

  switch (tool) {
    case 'list_files': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      return path ? { type: 'tool', tool, args: { path } } : { type: 'tool', tool, args: {} };
    }
    case 'read_file': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) {
        break;
      }
      const maxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? args.maxBytes : undefined;
      return { type: 'tool', tool, args: maxBytes !== undefined ? { path, maxBytes } : { path } };
    }
    case 'write_file': {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      const content = typeof args.content === 'string' ? args.content : null;
      if (!path || content === null) {
        break;
      }
      return { type: 'tool', tool, args: { path, content } };
    }
    case 'run_command': {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) {
        break;
      }
      const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined;
      return { type: 'tool', tool, args: timeoutMs !== undefined ? { command, timeoutMs } : { command } };
    }
    case 'diff_summary': {
      const maxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) ? args.maxBytes : undefined;
      return { type: 'tool', tool, args: maxBytes !== undefined ? { maxBytes } : {} };
    }
    default:
      break;
  }

  throw new AgentEndpointError('invalid_model_output', 422, {
    errors: [{ path: '$', message: `invalid workspace task action for tool '${tool || 'unknown'}'` }],
  });
}

function parseOpenRouterContent(payload: unknown): string {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = choices[0];
  const choiceRecord = first && typeof first === 'object' && !Array.isArray(first) ? (first as Record<string, unknown>) : null;
  const message = choiceRecord?.message;
  const messageRecord = message && typeof message === 'object' && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : null;
  const content = messageRecord?.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) {
          return '';
        }
        const text = (part as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .join('')
      .trim();
    return joined;
  }
  return '';
}

async function readResponseTextWithIdleTimeout(
  response: Response,
  options?: { idleTimeoutMs?: number; maxBytes?: number }
): Promise<string> {
  const idleTimeoutMs = options?.idleTimeoutMs ?? AGENT_STREAM_IDLE_TIMEOUT_MS;
  const maxBytes =
    typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes) ? Math.max(1_024, Math.floor(options.maxBytes)) : 512_000;
  if (!response.body || typeof response.body.getReader !== 'function') {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new Error(`Response body stream idle for more than ${Math.floor(idleTimeoutMs / 1000)} seconds`)),
            idleTimeoutMs
          );
        }),
      ]);
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
      }

      if (result.done) {
        text += decoder.decode();
        break;
      }

      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Response body exceeded ${maxBytes} bytes before completion`);
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text;
  } catch (error) {
    try {
      await reader.cancel(error instanceof Error ? error.message : 'stream_read_failed');
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function callOpenRouter(input: {
  apiKey: string;
  model: string;
  prompt: string;
  httpReferer?: string;
  xTitle?: string;
  responseSchema?: typeof reviewOutputV2JsonSchema | typeof workspaceTaskActionJsonSchema | typeof reviewAgentActionJsonSchema;
}): Promise<string> {
  let response: Response;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const signal =
      typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(90_000)
        : (() => {
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort('openrouter_timeout'), 90_000);
            return controller.signal;
          })();
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
        ...(input.httpReferer ? { 'HTTP-Referer': input.httpReferer } : {}),
        ...(input.xTitle ? { 'X-Title': input.xTitle } : {}),
      },
      body: JSON.stringify({
        model: input.model,
        response_format: { type: 'json_schema', json_schema: input.responseSchema ?? reviewOutputV2JsonSchema },
        plugins: [{ id: 'response-healing' }],
        messages: [{ role: 'user', content: input.prompt }],
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /timeout|timed out|aborted/i.test(error.message))) {
      throw new AgentEndpointError('openrouter_request_timeout', 504, {
        message: 'OpenRouter request timed out after 90 seconds',
      });
    }
    throw error;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }

  const bodyText = await readResponseTextWithIdleTimeout(response);
  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const upstreamStatus = response.status;
    if (upstreamStatus >= 500 || upstreamStatus === 429) {
      throw new AgentEndpointError('openrouter_request_failed', 502, {
        status: upstreamStatus,
        body: bodyText.slice(0, 2_000),
      });
    }
    throw new AgentEndpointError('openrouter_request_rejected', 422, {
      status: upstreamStatus,
      body: bodyText.slice(0, 2_000),
    });
  }

  const content = parseOpenRouterContent(parsed);
  if (!content) {
    throw new AgentEndpointError('openrouter_invalid_response', 502, {
      reason: 'empty_content',
    });
  }
  return content;
}

export async function callAiGateway(input: {
  config: AiGatewayConfig;
  providerApiKey: string | null;
  model: string;
  prompt: string;
  reasoningEffort?: ReviewReasoningEffort;
  responseSchema: typeof reviewOutputV2JsonSchema | typeof workspaceTaskActionJsonSchema | typeof reviewAgentActionJsonSchema;
}): Promise<string> {
  const openAiResponsesApi = usesOpenAiResponsesApi(input.model);
  const requestUrl = openAiResponsesApi
    ? `${resolveOpenAiGatewayBaseUrl(input.config.baseUrl)}/responses`
    : `${normalizeTrailingSlash(input.config.baseUrl)}/chat/completions`;
  if (!input.providerApiKey && !input.config.byokAlias) {
    throw new AgentEndpointError('missing_provider_api_key', 500, {
      message: 'Provider API key is required for AI Gateway inference unless BYOK is configured',
    });
  }

  let response: Response;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const signal =
      typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(AI_GATEWAY_REQUEST_TIMEOUT_MS)
        : (() => {
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort('ai_gateway_timeout'), AI_GATEWAY_REQUEST_TIMEOUT_MS);
            return controller.signal;
          })();
    response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-aig-authorization': `Bearer ${input.config.authToken}`,
        'cf-aig-collect-log-payload': input.config.collectLogPayload ? 'true' : 'false',
        ...(input.config.byokAlias ? { 'cf-aig-byok-alias': input.config.byokAlias } : {}),
        ...(input.providerApiKey ? { Authorization: `Bearer ${input.providerApiKey}` } : {}),
      },
      body: JSON.stringify(
        openAiResponsesApi
          ? {
              model: normalizeOpenAiGatewayModel(input.model),
              ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
              text: {
                format: {
                  type: 'json_schema',
                  ...input.responseSchema,
                },
              },
              max_output_tokens: 4_096,
              input: input.prompt,
            }
          : {
              model: input.model,
              ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
              response_format: { type: 'json_schema', json_schema: input.responseSchema },
              max_tokens: 4_096,
              messages: [{ role: 'user', content: input.prompt }],
            }
      ),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /timeout|timed out|aborted/i.test(error.message))) {
      throw new AgentEndpointError('ai_gateway_request_timeout', 504, {
        message: `AI Gateway request timed out after ${Math.floor(AI_GATEWAY_REQUEST_TIMEOUT_MS / 1000)} seconds`,
      });
    }
    throw error;
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }

  const bodyText = await readResponseTextWithIdleTimeout(response);
  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const upstreamStatus = response.status;
    if (upstreamStatus >= 500 || upstreamStatus === 429) {
      throw new AgentEndpointError('ai_gateway_request_failed', 502, {
        status: upstreamStatus,
        body: bodyText.slice(0, 2_000),
      });
    }
    throw new AgentEndpointError('ai_gateway_request_rejected', 422, {
      status: upstreamStatus,
      body: bodyText.slice(0, 2_000),
    });
  }

  const content = openAiResponsesApi ? parseOpenAiResponsesContent(parsed) : parseOpenRouterContent(parsed);
  if (!content) {
    throw new AgentEndpointError('ai_gateway_invalid_response', 502, {
      reason: 'empty_content',
    });
  }
  return content;
}

function validateReviewOutputV2(payload: unknown): ReviewOutputV2 {
  const parsed = reviewOutputV2Schema.safeParse(payload);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.length === 0
        ? '$'
        : `$${issue.path
            .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`))
            .join('')}`;
      return { path, message: issue.message };
    });
    throw new AgentEndpointError('invalid_model_output', 422, { errors });
  }
  return parsed.data;
}

function buildReviewFinalSummary(): string {
  return JSON.stringify({
    findings: [],
    summary: 'No actionable findings identified from the provided review context.',
    furtherPassesLowYield: true,
  });
}

function nextReviewAction(history: AgentHistoryEntry[]): AgentAction {
  if (!hasToolOutput(history, 'diff_summary')) {
    return { type: 'tool', tool: 'diff_summary', args: { maxBytes: 32_000 } };
  }
  if (!hasToolOutput(history, 'list_files')) {
    return { type: 'tool', tool: 'list_files', args: { path: '.' } };
  }
  return {
    type: 'final',
    summary: buildReviewFinalSummary(),
  };
}

function nextWorkspaceTaskAction(history: AgentHistoryEntry[]): AgentAction {
  if (!hasToolOutput(history, 'list_files')) {
    return { type: 'tool', tool: 'list_files', args: { path: '.' } };
  }
  if (!hasToolOutput(history, 'read_file')) {
    return { type: 'tool', tool: 'read_file', args: { path: 'README.md', maxBytes: 2000 } };
  }
  return { type: 'final', summary: 'Completed by Nimbus agent endpoint.' };
}

export function nextAgentAction(request: AgentRequest): AgentAction {
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';
  const history = Array.isArray(request.history) ? request.history : [];
  if (isReviewPrompt(prompt)) {
    return nextReviewAction(history);
  }
  return nextWorkspaceTaskAction(history);
}

export async function nextAgentActionWithInference(
  request: AgentRequest,
  env: AgentEnv,
  options?: { openrouterApiKey?: string | null; providerApiKey?: string | null; aiGatewayAuthToken?: string | null }
): Promise<AgentAction> {
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';
  const history = Array.isArray(request.history) ? request.history : [];
  const reasoningEffort = request.reasoningEffort;
  const requestProviderApiKey = typeof options?.providerApiKey === 'string' ? options.providerApiKey.trim() : '';
  const aiGatewayConfig = resolveAiGatewayConfig(env, { authToken: options?.aiGatewayAuthToken ?? null });

  const requestApiKey = typeof options?.openrouterApiKey === 'string' ? options.openrouterApiKey.trim() : '';
  const envApiKey = (env.OPENROUTER_API_KEY ?? '').trim();
  const apiKey = requestApiKey || envApiKey;
  const model = resolveOpenRouterModel(request.model, env.DEFAULT_MODEL);
  const useAiGateway = Boolean(aiGatewayConfig && isAiGatewayModel(model));

  if (!useAiGateway && !apiKey) {
    throw new AgentEndpointError('missing_openrouter_api_key', 500, {
      message: 'OPENROUTER_API_KEY is required',
    });
  }

  const httpReferer = typeof env.OPENROUTER_HTTP_REFERER === 'string' ? env.OPENROUTER_HTTP_REFERER.trim() : '';
  const xTitle = typeof env.OPENROUTER_X_TITLE === 'string' ? env.OPENROUTER_X_TITLE.trim() : '';
  if (request.mode === 'review_analysis') {
    const step = typeof request.step === 'number' && Number.isFinite(request.step) ? Math.max(1, Math.floor(request.step)) : 1;
    const maxSteps =
      typeof request.maxSteps === 'number' && Number.isFinite(request.maxSteps) ? Math.max(step, Math.floor(request.maxSteps)) : step;
    const content = useAiGateway
      ? await callAiGateway({
          config: aiGatewayConfig!,
          providerApiKey: requestProviderApiKey || null,
          model,
          prompt: buildReviewAnalysisStepPrompt({
            prompt,
            maxSteps,
            step,
            history,
            forceComplete: request.forceComplete === true,
          }),
          reasoningEffort,
          responseSchema: reviewAgentActionJsonSchema,
        })
      : await callOpenRouter({
          apiKey,
          model,
          prompt: buildReviewAnalysisStepPrompt({
            prompt,
            maxSteps,
            step,
            history,
            forceComplete: request.forceComplete === true,
          }),
          responseSchema: reviewAgentActionJsonSchema,
          ...(httpReferer ? { httpReferer } : {}),
          ...(xTitle ? { xTitle } : {}),
        });
    return validateReviewAgentAction(parseJsonCandidate(content));
  }

  if (!isReviewPrompt(prompt)) {
    const step = typeof request.step === 'number' && Number.isFinite(request.step) ? Math.max(1, Math.floor(request.step)) : 1;
    const maxSteps =
      typeof request.maxSteps === 'number' && Number.isFinite(request.maxSteps) ? Math.max(step, Math.floor(request.maxSteps)) : step;
    const content = useAiGateway
      ? await callAiGateway({
          config: aiGatewayConfig!,
          providerApiKey: requestProviderApiKey || null,
          model,
          prompt: buildWorkspaceTaskStepPrompt({
            prompt,
            maxSteps,
            step,
            history,
          }),
          reasoningEffort,
          responseSchema: workspaceTaskActionJsonSchema,
        })
      : await callOpenRouter({
          apiKey,
          model,
          prompt: buildWorkspaceTaskStepPrompt({
            prompt,
            maxSteps,
            step,
            history,
          }),
          responseSchema: workspaceTaskActionJsonSchema,
          ...(httpReferer ? { httpReferer } : {}),
          ...(xTitle ? { xTitle } : {}),
        });
    return validateWorkspaceTaskAction(parseJsonCandidate(content));
  }

  const content = useAiGateway
    ? await callAiGateway({
        config: aiGatewayConfig!,
        providerApiKey: requestProviderApiKey || null,
        model,
        prompt,
        reasoningEffort,
        responseSchema: reviewOutputV2JsonSchema,
      })
    : await callOpenRouter({
        apiKey,
        model,
        prompt,
        responseSchema: reviewOutputV2JsonSchema,
        ...(httpReferer ? { httpReferer } : {}),
        ...(xTitle ? { xTitle } : {}),
      });
  const validated = validateReviewOutputV2(parseJsonCandidate(content));
  return {
    type: 'final',
    summary: JSON.stringify(validated),
  };
}
