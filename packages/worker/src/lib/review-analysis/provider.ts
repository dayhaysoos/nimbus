import type { Env, WorkersAiBinding } from '../../types.js';
import type { ReviewAgentAction } from './tools.js';
import { asRecord, clampText, extractJsonObject, stripCodeFences } from './helpers.js';
import {
  isMissingOpenRouterApiKeyError,
  isTimeoutLikeError,
  isWorkerToWorkerFetchRestriction,
  sanitizeErrorMessage,
  sleep,
} from './output.js';

const REVIEW_PROVIDER_TIMEOUT_MS = 120_000;
const REVIEW_AGENT_ENDPOINT_TIMEOUT_MS = 90_000;
const REVIEW_PROVIDER_MAX_ATTEMPTS = 2;
const REVIEW_AGENT_ENDPOINT_MAX_ATTEMPTS = 1;
const REVIEW_PROVIDER_RETRY_DELAY_MS = 750;
const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CLOUDFLARE_AI_GATEWAY_HOST = 'https://gateway.ai.cloudflare.com';
const REVIEW_HISTORY_MAX_BYTES = 40_000;
const REVIEW_HISTORY_RECENT_ENTRIES = 10;
const REVIEW_HISTORY_ENTRY_MAX_BYTES = 2_000;
const REVIEW_HISTORY_PREVIEW_MAX_BYTES = 640;
const REVIEW_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 30_000;
const REVIEW_PROVIDER_MAX_TOKENS = 4_096;
const CLOUDFLARE_REVIEW_CONTEXT_WINDOW_TOKENS = 32_768;
const CLOUDFLARE_REVIEW_CONTEXT_SAFETY_TOKENS = 2_048;
const CLOUDFLARE_REVIEW_MIN_COMPLETION_TOKENS = 256;

export const DEFAULT_CLOUDFLARE_REVIEW_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct';

export type ReviewAgentProviderName =
  | 'cloudflare_workers_ai'
  | 'cloudflare_ai_gateway'
  | 'cloudflare_agents_sdk'
  | 'openrouter';

export interface CloudflareAiGatewayConfig {
  baseUrl: string;
  authToken: string;
  byokAlias: string | null;
  collectLogPayload: boolean;
}

export interface ReviewAgentProviderSelection {
  providerName: ReviewAgentProviderName;
  model: string;
  aiBinding: WorkersAiBinding | null;
  gatewayConfig: CloudflareAiGatewayConfig | null;
  endpoint: string | null;
  providerApiKey: string | null;
  openrouterApiKey: string | null;
}

export type ReviewAgentHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; output: unknown };

export interface ReviewAgentProvider {
  next(input: {
    prompt: string;
    model: string;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
    forceComplete?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<ReviewAgentAction>;
}

interface HistoryPromptEnvelope {
  omitted: Record<string, unknown> | null;
  recent: unknown[];
}

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

function buildProviderAbortError(): Error {
  const error = new Error('Review analysis aborted by external signal');
  error.name = 'AbortError';
  return error;
}

const reviewAgentActionJsonSchema = {
  name: 'ReviewAgentAction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['tool', 'complete', 'final'] },
      tool: {
        anyOf: [
          { type: 'string', enum: ['list_files', 'read_file', 'read_batch', 'diff_summary', 'search_code'] },
          { type: 'null' },
        ],
      },
      args: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              paths: {
                anyOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
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
                    severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
                    category: { type: 'string', enum: ['security', 'logic', 'style', 'breaking-change'] },
                    passType: { type: 'string', enum: ['single'] },
                    locations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          filePath: { type: 'string' },
                          startLine: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                          endLine: { anyOf: [{ type: 'number' }, { type: 'null' }] },
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
                  required: ['severity', 'category', 'passType', 'locations', 'description', 'suggestedFix', 'failingScenario', 'evidence', 'guardGap'],
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

function parseOpenRouterContent(payload: unknown): string {
  const record = asRecord(payload);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const content = message.content;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const entry = asRecord(part);
        return typeof entry.text === 'string' ? entry.text : '';
      })
      .join('')
      .trim();
  }

  return '';
}

export function isOpenAiGatewayModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith('openai/');
}

export function normalizeOpenAiGatewayModel(model: string): string {
  return isOpenAiGatewayModel(model) ? model.trim().slice('openai/'.length) : model.trim();
}

export function usesOpenAiResponsesApi(model: string): boolean {
  const normalized = normalizeOpenAiGatewayModel(model).toLowerCase();
  return isOpenAiGatewayModel(model) && normalized.includes('codex');
}

export function resolveOpenAiGatewayBaseUrl(baseUrl: string): string {
  return normalizeTrailingSlash(baseUrl).replace(/\/compat$/i, '/openai');
}

export function parseOpenAiResponsesContent(payload: unknown): string {
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

function clampHistoryText(value: string, maxBytes: number = REVIEW_HISTORY_PREVIEW_MAX_BYTES): string {
  return clampText(value, maxBytes).text;
}

function summarizeStringArray(values: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  return values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .slice(0, maxItems)
    .map((value) => clampHistoryText(value, 240));
}

function summarizeToolRequest(request: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (typeof request.path === 'string' && request.path.trim()) {
    summary.path = request.path.trim();
  }
  const paths = summarizeStringArray(request.paths, 6);
  if (paths && paths.length > 0) {
    summary.paths = {
      count: Array.isArray(request.paths) ? request.paths.length : paths.length,
      sample: paths,
    };
  }
  if (typeof request.query === 'string' && request.query.trim()) {
    summary.query = clampHistoryText(request.query.trim(), 240);
  }
  if (typeof request.maxBytes === 'number' && Number.isFinite(request.maxBytes)) {
    summary.maxBytes = Math.floor(request.maxBytes);
  }
  if (typeof request.maxResults === 'number' && Number.isFinite(request.maxResults)) {
    summary.maxResults = Math.floor(request.maxResults);
  }
  if (typeof request.maxBytesPerFile === 'number' && Number.isFinite(request.maxBytesPerFile)) {
    summary.maxBytesPerFile = Math.floor(request.maxBytesPerFile);
  }
  if (typeof request.caseSensitive === 'boolean') {
    summary.caseSensitive = request.caseSensitive;
  }
  return summary;
}

function summarizeMatchList(matches: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(matches)) {
    return undefined;
  }
  const compact = matches
    .slice(0, 6)
    .map((item) => {
      const record = asRecord(item);
      const summary: Record<string, unknown> = {};
      if (typeof record.path === 'string') {
        summary.path = record.path;
      }
      if (typeof record.lineNumber === 'number' && Number.isFinite(record.lineNumber)) {
        summary.lineNumber = Math.floor(record.lineNumber);
      }
      if (typeof record.line === 'string' && record.line.trim()) {
        summary.line = clampHistoryText(record.line.trim(), 240);
      }
      return summary;
    })
    .filter((item) => Object.keys(item).length > 0);
  return compact.length > 0 ? compact : undefined;
}

function summarizeToolResult(tool: string, result: unknown): unknown {
  const record = asRecord(result);
  if (Object.keys(record).length === 0) {
    return result === null || result === undefined ? null : clampHistoryText(JSON.stringify(result), REVIEW_HISTORY_ENTRY_MAX_BYTES);
  }

  const summary: Record<string, unknown> = {};
  if (typeof record.error === 'string' && record.error.trim()) {
    summary.error = clampHistoryText(record.error.trim(), 240);
  }
  if (typeof record.bytes === 'number' && Number.isFinite(record.bytes)) {
    summary.bytes = Math.floor(record.bytes);
  }
  if (typeof record.scannedFiles === 'number' && Number.isFinite(record.scannedFiles)) {
    summary.scannedFiles = Math.floor(record.scannedFiles);
  }
  if (typeof record.truncated === 'boolean') {
    summary.truncated = record.truncated;
  }

  if (tool === 'read_file' && typeof record.content === 'string') {
    summary.preview = clampHistoryText(record.content, REVIEW_HISTORY_PREVIEW_MAX_BYTES);
  }

  if (tool === 'read_batch' && Array.isArray(record.files)) {
    summary.files = record.files.slice(0, 4).map((item) => {
      const file = asRecord(item);
      const fileSummary: Record<string, unknown> = {};
      if (typeof file.path === 'string') {
        fileSummary.path = file.path;
      }
      if (typeof file.bytes === 'number' && Number.isFinite(file.bytes)) {
        fileSummary.bytes = Math.floor(file.bytes);
      }
      if (typeof file.truncated === 'boolean') {
        fileSummary.truncated = file.truncated;
      }
      if (typeof file.error === 'string' && file.error.trim()) {
        fileSummary.error = clampHistoryText(file.error.trim(), 180);
      }
      if (typeof file.content === 'string' && file.content.trim()) {
        fileSummary.preview = clampHistoryText(file.content, 280);
      }
      return fileSummary;
    });
    summary.fileCount = record.files.length;
  }

  if (tool === 'list_files' && Array.isArray(record.entries)) {
    summary.entries = record.entries.slice(0, 12).map((item) => {
      const entry = asRecord(item);
      return {
        name: typeof entry.name === 'string' ? entry.name : '',
        type: typeof entry.type === 'string' ? entry.type : '',
      };
    });
    summary.entryCount = record.entries.length;
  }

  if (tool === 'search_code') {
    const matches = summarizeMatchList(record.matches);
    if (matches) {
      summary.matches = matches;
    }
    if (typeof record.query === 'string' && record.query.trim()) {
      summary.query = clampHistoryText(record.query.trim(), 180);
    }
  }

  if (tool === 'diff_summary') {
    const textualValue =
      typeof record.summary === 'string'
        ? record.summary
        : typeof record.content === 'string'
          ? record.content
          : typeof record.diff === 'string'
            ? record.diff
            : '';
    if (textualValue.trim()) {
      summary.preview = clampHistoryText(textualValue, REVIEW_HISTORY_PREVIEW_MAX_BYTES);
    }
  }

  if ((tool === 'analysis_guard' || tool === 'validation_guard') && Object.keys(summary).length < 4) {
    summary.guard = clampHistoryText(JSON.stringify(record), REVIEW_HISTORY_ENTRY_MAX_BYTES);
  }

  if (Object.keys(summary).length === 0) {
    summary.preview = clampHistoryText(JSON.stringify(record), REVIEW_HISTORY_ENTRY_MAX_BYTES);
  }

  return summary;
}

function summarizeHistoryEntry(entry: ReviewAgentHistoryEntry): unknown {
  if (entry.role === 'assistant') {
    return {
      role: entry.role,
      content: clampHistoryText(entry.content, REVIEW_HISTORY_ENTRY_MAX_BYTES),
    };
  }

  const output = asRecord(entry.output);
  return {
    role: entry.role,
    tool: entry.tool,
    request: summarizeToolRequest(asRecord(output.request)),
    result: summarizeToolResult(entry.tool, output.result),
  };
}

function summarizeOmittedHistoryEntries(entries: ReviewAgentHistoryEntry[]): Record<string, unknown> | null {
  if (entries.length === 0) {
    return null;
  }

  const toolCounts: Record<string, number> = {};
  const paths = new Set<string>();
  const queries = new Set<string>();
  const notes: string[] = [];

  for (const entry of entries) {
    if (entry.role === 'assistant') {
      if (notes.length < 4 && entry.content.trim()) {
        notes.push(clampHistoryText(entry.content, 220));
      }
      continue;
    }

    toolCounts[entry.tool] = (toolCounts[entry.tool] ?? 0) + 1;
    const output = asRecord(entry.output);
    const request = asRecord(output.request);
    if (typeof request.path === 'string' && paths.size < 8) {
      paths.add(request.path);
    }
    if (Array.isArray(request.paths)) {
      for (const path of request.paths) {
        if (typeof path === 'string' && paths.size < 8) {
          paths.add(path);
        }
      }
    }
    if (typeof request.query === 'string' && queries.size < 5) {
      queries.add(clampHistoryText(request.query, 120));
    }
  }

  return {
    omittedEntryCount: entries.length,
    toolCallsByType: toolCounts,
    touchedPaths: Array.from(paths),
    searchQueries: Array.from(queries),
    assistantNotes: notes,
  };
}

function buildHistoryForPrompt(history: ReviewAgentHistoryEntry[]): string {
  let recentCount = Math.min(REVIEW_HISTORY_RECENT_ENTRIES, history.length);

  while (recentCount >= 1) {
    const recentEntries = history.slice(-recentCount).map(summarizeHistoryEntry);
    const omittedEntries = history.slice(0, Math.max(0, history.length - recentCount));
    const envelope: HistoryPromptEnvelope = {
      omitted: summarizeOmittedHistoryEntries(omittedEntries),
      recent: recentEntries,
    };
    const serialized = JSON.stringify(envelope);
    const clamped = clampText(serialized, REVIEW_HISTORY_MAX_BYTES);
    if (!clamped.truncated) {
      return serialized;
    }
    recentCount -= 1;
  }

  const minimalEnvelope: HistoryPromptEnvelope = {
    omitted: summarizeOmittedHistoryEntries(history),
    recent: [],
  };
  return clampText(JSON.stringify(minimalEnvelope), REVIEW_HISTORY_MAX_BYTES).text;
}

export function buildHistoryForPromptForTests(history: ReviewAgentHistoryEntry[]): string {
  return buildHistoryForPrompt(history);
}

export async function readResponseTextWithIdleTimeout(
  response: Response,
  options?: { idleTimeoutMs?: number; maxBytes?: number }
): Promise<string> {
  const idleTimeoutMs = options?.idleTimeoutMs ?? REVIEW_PROVIDER_STREAM_IDLE_TIMEOUT_MS;
  const maxBytes = typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes)
    ? Math.max(1_024, Math.floor(options.maxBytes))
    : 512_000;
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
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => reject(new Error(`Response body stream idle for more than ${Math.floor(idleTimeoutMs / 1000)} seconds`)), idleTimeoutMs);
        }),
      ]);
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
      }

      if (readResult.done) {
        text += decoder.decode();
        break;
      }

      totalBytes += readResult.value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Response body exceeded ${maxBytes} bytes before completion`);
      }
      text += decoder.decode(readResult.value, { stream: true });
    }

    return text;
  } catch (error) {
    try {
      await reader.cancel(error instanceof Error ? error.message : 'response_body_read_failed');
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function isCloudflareAiModel(model: string): boolean {
  return /^@(cf|hf)\//.test(model.trim());
}

export function isCloudflareAiGatewayModel(model: string): boolean {
  const trimmed = model.trim();
  if (!trimmed || isCloudflareAiModel(trimmed)) {
    return false;
  }
  return /^(dynamic|workers-ai)\//.test(trimmed) || /^[a-z0-9][a-z0-9._-]*\/.+$/i.test(trimmed);
}

export function resolveCloudflareAiModel(model: string | null | undefined): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return trimmed && isCloudflareAiModel(trimmed) ? trimmed : DEFAULT_CLOUDFLARE_REVIEW_MODEL;
}

export function resolveCloudflareAiGatewayConfig(
  env: Pick<
    Env,
    'AI_GATEWAY_ACCOUNT_ID' | 'AI_GATEWAY_ID' | 'AI_GATEWAY_AUTH_TOKEN' | 'AI_GATEWAY_BASE_URL' | 'AI_GATEWAY_BYOK_ALIAS' | 'AI_GATEWAY_COLLECT_LOG_PAYLOAD' | 'CF_ACCOUNT_ID'
  >
): CloudflareAiGatewayConfig | null {
  const authToken = typeof env.AI_GATEWAY_AUTH_TOKEN === 'string' ? env.AI_GATEWAY_AUTH_TOKEN.trim() : '';
  if (!authToken) {
    return null;
  }

  const configuredBaseUrl = typeof env.AI_GATEWAY_BASE_URL === 'string' ? env.AI_GATEWAY_BASE_URL.trim() : '';
  let baseUrl = '';
  if (configuredBaseUrl) {
    baseUrl = normalizeTrailingSlash(configuredBaseUrl).replace(/\/chat\/completions$/i, '');
  } else {
    const accountId =
      (typeof env.AI_GATEWAY_ACCOUNT_ID === 'string' ? env.AI_GATEWAY_ACCOUNT_ID.trim() : '') ||
      (typeof env.CF_ACCOUNT_ID === 'string' ? env.CF_ACCOUNT_ID.trim() : '');
    if (!accountId) {
      return null;
    }
    const gatewayId = (typeof env.AI_GATEWAY_ID === 'string' ? env.AI_GATEWAY_ID.trim() : '') || 'default';
    baseUrl = `${CLOUDFLARE_AI_GATEWAY_HOST}/v1/${accountId}/${gatewayId}/compat`;
  }

  return {
    baseUrl,
    authToken,
    byokAlias: typeof env.AI_GATEWAY_BYOK_ALIAS === 'string' && env.AI_GATEWAY_BYOK_ALIAS.trim()
      ? env.AI_GATEWAY_BYOK_ALIAS.trim()
      : null,
    collectLogPayload: parseBooleanEnvValue(env.AI_GATEWAY_COLLECT_LOG_PAYLOAD, false),
  };
}

export function selectReviewAgentProvider(input: {
  env: Pick<
    Env,
    | 'AI'
    | 'OPENROUTER_API_KEY'
    | 'AI_GATEWAY_ACCOUNT_ID'
    | 'AI_GATEWAY_ID'
    | 'AI_GATEWAY_AUTH_TOKEN'
    | 'AI_GATEWAY_BASE_URL'
    | 'AI_GATEWAY_BYOK_ALIAS'
    | 'AI_GATEWAY_COLLECT_LOG_PAYLOAD'
    | 'CF_ACCOUNT_ID'
  >;
  model: string;
  endpoint?: string | null;
  providerApiKey?: string | null;
  openrouterApiKey?: string | null;
}): ReviewAgentProviderSelection | null {
  const model = input.model.trim();
  const endpoint = typeof input.endpoint === 'string' && input.endpoint.trim() ? input.endpoint.trim() : null;
  const providerApiKey = typeof input.providerApiKey === 'string' && input.providerApiKey.trim()
    ? input.providerApiKey.trim()
    : '';
  const openrouterApiKey =
    (typeof input.openrouterApiKey === 'string' ? input.openrouterApiKey.trim() : '') ||
    (typeof input.env.OPENROUTER_API_KEY === 'string' ? input.env.OPENROUTER_API_KEY.trim() : '') ||
    '';
  const aiBinding = typeof input.env.AI?.run === 'function' ? input.env.AI : null;
  const gatewayConfig = resolveCloudflareAiGatewayConfig(input.env);

  if (gatewayConfig && isCloudflareAiGatewayModel(model)) {
    return {
      providerName: 'cloudflare_ai_gateway',
      model,
      aiBinding,
      gatewayConfig,
      endpoint,
      providerApiKey: providerApiKey || null,
      openrouterApiKey: openrouterApiKey || null,
    };
  }

  if (aiBinding && (isCloudflareAiModel(model) || !model)) {
    return {
      providerName: 'cloudflare_workers_ai',
      model: resolveCloudflareAiModel(model),
      aiBinding,
      gatewayConfig,
      endpoint,
      providerApiKey: providerApiKey || null,
      openrouterApiKey: openrouterApiKey || null,
    };
  }

  if (endpoint) {
    return {
      providerName: 'cloudflare_agents_sdk',
      model,
      aiBinding,
      gatewayConfig,
      endpoint,
      providerApiKey: providerApiKey || null,
      openrouterApiKey: openrouterApiKey || null,
    };
  }

  if (openrouterApiKey) {
    return {
      providerName: 'openrouter',
      model,
      aiBinding,
      gatewayConfig,
      endpoint,
      providerApiKey: providerApiKey || null,
      openrouterApiKey,
    };
  }

  return null;
}

function buildProviderStepPrompt(input: {
  prompt: string;
  maxSteps: number;
  step: number;
  history: ReviewAgentHistoryEntry[];
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
    `Prior loop history JSON: ${buildHistoryForPrompt(input.history)}`,
  ].join('\n');
}

export class OpenRouterReviewProvider implements ReviewAgentProvider {
  constructor(
    private readonly apiKey: string,
    private readonly validateAction: (action: unknown) => ReviewAgentAction,
    private readonly httpReferer: string,
    private readonly xTitle: string
  ) {}

  async next(input: {
    prompt: string;
    model: string;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
    forceComplete?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<ReviewAgentAction> {
    const forceComplete = input.forceComplete === true;

    for (let attempt = 1; attempt <= REVIEW_AGENT_ENDPOINT_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      let activeResponse: Response | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const handleExternalAbort = (): void => {
        controller.abort();
      };

      try {
        if (input.abortSignal?.aborted) {
          throw buildProviderAbortError();
        }
        input.abortSignal?.addEventListener('abort', handleExternalAbort, { once: true });
        const requestPromise = (async (): Promise<{ response: Response; bodyText: string }> => {
          const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
              'HTTP-Referer': this.httpReferer,
              'X-Title': this.xTitle,
            },
            body: JSON.stringify({
              model: input.model,
              ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
              response_format: { type: 'json_schema', json_schema: reviewAgentActionJsonSchema },
              plugins: [{ id: 'response-healing' }],
              messages: [
                {
                  role: 'user',
                  content: buildProviderStepPrompt({
                    prompt: input.prompt,
                    maxSteps: input.maxSteps,
                    step: input.step,
                    history: input.history,
                    forceComplete,
                  }),
                },
              ],
            }),
            signal: controller.signal,
          });
          activeResponse = response;
          const bodyText = await readResponseTextWithIdleTimeout(response);
          return { response, bodyText };
        })();

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort('review_provider_timeout');
            const cancelPromise = activeResponse?.body?.cancel('review_provider_timeout');
            if (cancelPromise) {
              void cancelPromise.catch(() => undefined);
            }
            reject(new Error(`Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds`));
          }, REVIEW_PROVIDER_TIMEOUT_MS);
        });

        const { response, bodyText } = await Promise.race([requestPromise, timeoutPromise]);
        if (!response.ok) {
          const providerErrorBody = sanitizeErrorMessage(bodyText, { openrouterApiKey: this.apiKey });
          if (isMissingOpenRouterApiKeyError(providerErrorBody) || response.status === 401 || response.status === 403) {
            throw new Error('missing_openrouter_api_key: valid OpenRouter API key is required for review analysis');
          }
          if (isWorkerToWorkerFetchRestriction(response.status, providerErrorBody)) {
            throw new Error(
              `Review analysis provider request blocked by Cloudflare Worker-to-Worker fetch restriction (error code 1042). Enable the 'global_fetch_strictly_public' compatibility flag on this worker or switch to a service binding.${providerErrorBody ? ` Provider response: ${providerErrorBody}` : ''}`
            );
          }

          const transientStatus = response.status >= 500 || response.status === 429;
          const statusError = new Error(
            transientStatus
              ? `Review analysis provider temporarily unavailable (status ${response.status})${providerErrorBody ? `: ${providerErrorBody}` : ''}`
              : `Review analysis provider request failed with status ${response.status}${providerErrorBody ? `: ${providerErrorBody}` : ''}`
          );

          if (transientStatus && attempt < REVIEW_AGENT_ENDPOINT_MAX_ATTEMPTS) {
            await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
            continue;
          }

          throw statusError;
        }

        let parsedResponse: unknown = null;
        try {
          parsedResponse = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          parsedResponse = null;
        }

        const content = parseOpenRouterContent(parsedResponse);
        if (!content) {
          throw new Error('Review analysis provider returned empty model content');
        }
        const actionPayload = JSON.parse(extractJsonObject(stripCodeFences(content))) as unknown;
        const action = this.validateAction(actionPayload);
        if (forceComplete && action.type !== 'complete') {
          throw new Error('Review analysis finalization step must return type="complete"');
        }
        return action;
      } catch (error) {
        if (input.abortSignal?.aborted) {
          throw buildProviderAbortError();
        }
        const timeoutLike = isTimeoutLikeError(error);
        const transientNetworkError = error instanceof Error && /fetch failed|network|connection reset|econnreset|socket hang up/i.test(error.message);
        if ((timeoutLike || transientNetworkError) && attempt < REVIEW_PROVIDER_MAX_ATTEMPTS) {
          await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
          continue;
        }
        if (timeoutLike) {
          throw new Error(
            `Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds (attempt ${attempt}/${REVIEW_PROVIDER_MAX_ATTEMPTS})`
          );
        }
        throw error;
      } finally {
        input.abortSignal?.removeEventListener('abort', handleExternalAbort);
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    }

    throw new Error('Review analysis provider exhausted retry attempts without a valid response');
  }
}

function extractWorkersAiContent(payload: unknown): string {
  const record = asRecord(payload);
  const response = record.response;
  if (typeof response === 'string') {
    return response.trim();
  }
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return JSON.stringify(response);
  }
  return '';
}

function parseReviewAgentActionPayload(content: string): unknown {
  return JSON.parse(extractJsonObject(stripCodeFences(content))) as unknown;
}

export class CloudflareWorkersAiReviewProvider implements ReviewAgentProvider {
  constructor(
    private readonly ai: WorkersAiBinding,
    private readonly validateAction: (action: unknown) => ReviewAgentAction
  ) {}

  async next(input: {
    prompt: string;
    model: string;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
    forceComplete?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<ReviewAgentAction> {
    const forceComplete = input.forceComplete === true;
    const model = resolveCloudflareAiModel(input.model);
    const stepPrompt = buildProviderStepPrompt({
      prompt: input.prompt,
      maxSteps: input.maxSteps,
      step: input.step,
      history: input.history,
      forceComplete,
    });
    const estimatedPromptTokens = Math.ceil(stepPrompt.length / 4);
    const remainingCompletionBudget = Math.max(
      CLOUDFLARE_REVIEW_MIN_COMPLETION_TOKENS,
      CLOUDFLARE_REVIEW_CONTEXT_WINDOW_TOKENS - estimatedPromptTokens - CLOUDFLARE_REVIEW_CONTEXT_SAFETY_TOKENS
    );
    const maxTokens = Math.min(REVIEW_PROVIDER_MAX_TOKENS, remainingCompletionBudget);

    for (let attempt = 1; attempt <= REVIEW_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let abortHandler: (() => void) | null = null;

      try {
        if (input.abortSignal?.aborted) {
          throw buildProviderAbortError();
        }

        const response = await new Promise<unknown>((resolve, reject) => {
          let settled = false;
          const settle = (callback: () => void): void => {
            if (settled) {
              return;
            }
            settled = true;
            if (timeoutId !== null) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            if (abortHandler) {
              input.abortSignal?.removeEventListener('abort', abortHandler);
            }
            callback();
          };

          abortHandler = (): void => {
            settle(() => reject(buildProviderAbortError()));
          };

          if (input.abortSignal) {
            input.abortSignal.addEventListener('abort', abortHandler, { once: true });
          }

          timeoutId = setTimeout(() => {
            settle(() =>
              reject(new Error(`Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds`))
            );
          }, REVIEW_PROVIDER_TIMEOUT_MS);

          this.ai
            .run(model, {
              messages: [
                {
                  role: 'user',
                  content: stepPrompt,
                },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: reviewAgentActionJsonSchema.schema,
              },
              max_tokens: maxTokens,
              temperature: 0,
            })
            .then((value) => settle(() => resolve(value)))
            .catch((error) => settle(() => reject(error)));
        });

        const content = extractWorkersAiContent(response);
        if (!content) {
          throw new Error('Review analysis provider returned empty model content');
        }

        const action = this.validateAction(parseReviewAgentActionPayload(content));
        if (forceComplete && action.type !== 'complete') {
          throw new Error('Review analysis finalization step must return type="complete"');
        }
        return action;
      } catch (error) {
        if (input.abortSignal?.aborted) {
          throw buildProviderAbortError();
        }
        const timeoutLike = isTimeoutLikeError(error);
        const transientNetworkError =
          error instanceof Error && /fetch failed|network|connection reset|econnreset|socket hang up|internal error/i.test(error.message);
        if ((timeoutLike || transientNetworkError) && attempt < REVIEW_PROVIDER_MAX_ATTEMPTS) {
          await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
          continue;
        }
        if (timeoutLike) {
          throw new Error(
            `Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds (attempt ${attempt}/${REVIEW_PROVIDER_MAX_ATTEMPTS})`
          );
        }
        throw error;
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        if (abortHandler) {
          input.abortSignal?.removeEventListener('abort', abortHandler);
        }
      }
    }

    throw new Error('Review analysis provider exhausted retry attempts without a valid response');
  }
}

export class CloudflareAiGatewayReviewProvider implements ReviewAgentProvider {
  constructor(
    private readonly config: CloudflareAiGatewayConfig,
    private readonly providerApiKey: string | null,
    private readonly validateAction: (action: unknown) => ReviewAgentAction
  ) {}

  async next(input: {
    prompt: string;
    model: string;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
    forceComplete?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<ReviewAgentAction> {
    const forceComplete = input.forceComplete === true;
    const openAiResponsesApi = usesOpenAiResponsesApi(input.model);
    const requestUrl = openAiResponsesApi
      ? `${resolveOpenAiGatewayBaseUrl(this.config.baseUrl)}/responses`
      : `${normalizeTrailingSlash(this.config.baseUrl)}/chat/completions`;
    const stepPrompt = buildProviderStepPrompt({
      prompt: input.prompt,
      maxSteps: input.maxSteps,
      step: input.step,
      history: input.history,
      forceComplete,
    });
    if (!this.providerApiKey && !this.config.byokAlias) {
      throw new Error(
        'missing_provider_api_key: valid provider API key is required for AI Gateway review analysis unless AI Gateway BYOK is configured'
      );
    }

    for (let attempt = 1; attempt <= REVIEW_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      let activeResponse: Response | null = null;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const handleExternalAbort = (): void => {
        controller.abort();
      };

      try {
        if (input.abortSignal?.aborted) {
          throw buildProviderAbortError();
        }
        input.abortSignal?.addEventListener('abort', handleExternalAbort, { once: true });
        const requestPromise = (async (): Promise<{ response: Response; bodyText: string }> => {
          const response = await fetch(requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'cf-aig-authorization': `Bearer ${this.config.authToken}`,
              'cf-aig-collect-log-payload': this.config.collectLogPayload ? 'true' : 'false',
              ...(this.config.byokAlias ? { 'cf-aig-byok-alias': this.config.byokAlias } : {}),
              ...(this.providerApiKey ? { Authorization: `Bearer ${this.providerApiKey}` } : {}),
            },
            body: JSON.stringify(
              openAiResponsesApi
                ? {
                    model: normalizeOpenAiGatewayModel(input.model),
                    ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
                    text: {
                      format: {
                        type: 'json_schema',
                        ...reviewAgentActionJsonSchema,
                      },
                    },
                    max_output_tokens: REVIEW_PROVIDER_MAX_TOKENS,
                    input: stepPrompt,
                  }
                : {
                    model: input.model,
                    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
                    response_format: { type: 'json_schema', json_schema: reviewAgentActionJsonSchema },
                    max_tokens: REVIEW_PROVIDER_MAX_TOKENS,
                    temperature: 0,
                    messages: [
                      {
                        role: 'user',
                        content: stepPrompt,
                      },
                    ],
                  }
            ),
            signal: controller.signal,
          });
          activeResponse = response;
          const bodyText = await readResponseTextWithIdleTimeout(response);
          return { response, bodyText };
        })();

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort('review_provider_timeout');
            const cancelPromise = activeResponse?.body?.cancel('review_provider_timeout');
            if (cancelPromise) {
              void cancelPromise.catch(() => undefined);
            }
            reject(new Error(`Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds`));
          }, REVIEW_PROVIDER_TIMEOUT_MS);
        });

        const { response, bodyText } = await Promise.race([requestPromise, timeoutPromise]);
        if (!response.ok) {
          const providerErrorBody = sanitizeErrorMessage(bodyText, {
            providerApiKey: this.providerApiKey,
          });
          const transientStatus = response.status >= 500 || response.status === 429;
          const statusError = new Error(
            transientStatus
              ? `Review analysis AI Gateway temporarily unavailable (status ${response.status})${providerErrorBody ? `: ${providerErrorBody}` : ''}`
              : `Review analysis AI Gateway request failed with status ${response.status}${providerErrorBody ? `: ${providerErrorBody}` : ''}`
          );

          if (transientStatus && attempt < REVIEW_PROVIDER_MAX_ATTEMPTS) {
            await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
            continue;
          }

          throw statusError;
        }

        let parsedResponse: unknown = null;
        try {
          parsedResponse = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          parsedResponse = null;
        }

        const content = openAiResponsesApi
          ? parseOpenAiResponsesContent(parsedResponse)
          : parseOpenRouterContent(parsedResponse);
        if (!content) {
          throw new Error('Review analysis provider returned empty model content');
        }

        const action = this.validateAction(parseReviewAgentActionPayload(content));
        if (forceComplete && action.type !== 'complete') {
          throw new Error('Review analysis finalization step must return type="complete"');
        }
        return action;
      } catch (error) {
        if (input.abortSignal?.aborted) {
          throw buildProviderAbortError();
        }
        const timeoutLike = isTimeoutLikeError(error);
        const transientNetworkError = error instanceof Error && /fetch failed|network|connection reset|econnreset|socket hang up/i.test(error.message);
        if ((timeoutLike || transientNetworkError) && attempt < REVIEW_PROVIDER_MAX_ATTEMPTS) {
          await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
          continue;
        }
        if (timeoutLike) {
          throw new Error(
            `Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds (attempt ${attempt}/${REVIEW_PROVIDER_MAX_ATTEMPTS})`
          );
        }
        throw error;
      } finally {
        input.abortSignal?.removeEventListener('abort', handleExternalAbort);
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    }

    throw new Error('Review analysis provider exhausted retry attempts without a valid response');
  }
}

export class CloudflareAgentSdkReviewProvider implements ReviewAgentProvider {
  constructor(
    private readonly endpoint: string,
    private readonly authToken: string | null,
    private readonly serviceBinding: Fetcher | null,
    private readonly providerApiKey: string | null,
    private readonly openrouterApiKey: string | null,
    private readonly aiGatewayAuthToken: string | null,
    private readonly validateAction: (action: unknown) => ReviewAgentAction
  ) {}

  async next(input: {
    prompt: string;
    model: string;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
    forceComplete?: boolean;
    abortSignal?: AbortSignal;
  }): Promise<ReviewAgentAction> {
    const requestFetch = this.serviceBinding ? this.serviceBinding.fetch.bind(this.serviceBinding) : fetch;

    for (let attempt = 1; attempt <= REVIEW_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const handleExternalAbort = (): void => {
        controller.abort();
      };

      try {
        if (input.abortSignal?.aborted) {
          throw buildProviderAbortError();
        }
        input.abortSignal?.addEventListener('abort', handleExternalAbort, { once: true });
        const requestPromise = requestFetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
            ...(this.providerApiKey ? { 'X-Provider-Api-Key': this.providerApiKey } : {}),
            ...(this.openrouterApiKey ? { 'X-Openrouter-Api-Key': this.openrouterApiKey } : {}),
            ...(this.aiGatewayAuthToken ? { 'X-AI-Gateway-Auth-Token': this.aiGatewayAuthToken } : {}),
          },
          body: JSON.stringify({
            mode: 'review_analysis',
            prompt: input.prompt,
            model: input.model,
            ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
            maxSteps: input.maxSteps,
            step: input.step,
            history: input.history,
            ...(input.forceComplete === true ? { forceComplete: true } : {}),
          }),
          signal: controller.signal,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort('review_provider_timeout');
            reject(new Error(`Review analysis provider request timed out after ${Math.floor(REVIEW_AGENT_ENDPOINT_TIMEOUT_MS / 1000)} seconds`));
          }, REVIEW_AGENT_ENDPOINT_TIMEOUT_MS);
        });

        const response = await Promise.race([requestPromise, timeoutPromise]);
        if (!response.ok) {
          const providerErrorBody = sanitizeErrorMessage(await response.text(), { openrouterApiKey: this.openrouterApiKey });
          if (isMissingOpenRouterApiKeyError(providerErrorBody)) {
            throw new Error(
              'Review analysis provider is missing an OpenRouter API key. Configure OPENROUTER_API_KEY for nimbus-agent-endpoint or pass X-Openrouter-Api-Key from the caller.'
            );
          }
          if (isWorkerToWorkerFetchRestriction(response.status, providerErrorBody)) {
            throw new Error(
              `Review analysis provider request blocked by Cloudflare Worker-to-Worker fetch restriction (error code 1042). Enable the 'global_fetch_strictly_public' compatibility flag on this worker or switch to a service binding.${providerErrorBody ? ` Provider response: ${providerErrorBody}` : ''}`
            );
          }

          const transientStatus = response.status >= 500 || response.status === 429;
          const statusError = new Error(
            transientStatus
              ? `Review analysis provider temporarily unavailable (status ${response.status})${providerErrorBody ? `: ${providerErrorBody}` : ''}`
              : `Review analysis provider request failed with status ${response.status}${providerErrorBody ? `: ${providerErrorBody}` : ''}`
          );

          if (transientStatus && attempt < REVIEW_PROVIDER_MAX_ATTEMPTS) {
            await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
            continue;
          }

          throw statusError;
        }

        const parsed = (await response.json()) as unknown;
        const action = asRecord(parsed).action;
        const validatedAction = this.validateAction(action);
        if (input.forceComplete === true && validatedAction.type !== 'complete') {
          throw new Error('Review analysis finalization step must return type="complete"');
        }
        return validatedAction;
      } catch (error) {
        if (input.abortSignal?.aborted) {
          throw buildProviderAbortError();
        }
        const timeoutLike = isTimeoutLikeError(error);
        const transientNetworkError = error instanceof Error && /fetch failed|network|connection reset|econnreset|socket hang up/i.test(error.message);
        if ((timeoutLike || transientNetworkError) && attempt < REVIEW_AGENT_ENDPOINT_MAX_ATTEMPTS) {
          await sleep(REVIEW_PROVIDER_RETRY_DELAY_MS * attempt);
          continue;
        }
        if (timeoutLike) {
          throw new Error(
            `Review analysis provider request timed out after ${Math.floor(REVIEW_AGENT_ENDPOINT_TIMEOUT_MS / 1000)} seconds (attempt ${attempt}/${REVIEW_AGENT_ENDPOINT_MAX_ATTEMPTS})`
          );
        }
        throw error;
      } finally {
        input.abortSignal?.removeEventListener('abort', handleExternalAbort);
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    }

    throw new Error('Review analysis provider exhausted retry attempts without a valid response');
  }
}
