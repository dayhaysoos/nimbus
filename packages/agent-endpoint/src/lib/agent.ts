import { z } from 'zod';

type AgentHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; output: unknown };

export type AgentAction =
  | { type: 'tool'; tool: 'list_files'; args: { path?: string } }
  | { type: 'tool'; tool: 'read_file'; args: { path: string; maxBytes?: number } }
  | { type: 'tool'; tool: 'write_file'; args: { path: string; content: string } }
  | { type: 'tool'; tool: 'run_command'; args: { command: string; timeoutMs?: number } }
  | { type: 'tool'; tool: 'diff_summary'; args: { maxBytes?: number } }
  | { type: 'final'; summary: string };

export interface AgentRequest {
  mode?: string;
  prompt?: string;
  model?: string;
  maxSteps?: number;
  step?: number;
  history?: AgentHistoryEntry[];
}

export interface AgentEnv {
  OPENROUTER_API_KEY?: string;
  DEFAULT_MODEL?: string;
  AGENT_SDK_AUTH_TOKEN?: string;
  OPENROUTER_HTTP_REFERER?: string;
  OPENROUTER_X_TITLE?: string;
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

const WORKSPACE_TASK_TOOL_NAMES = ['list_files', 'read_file', 'write_file', 'run_command', 'diff_summary'] as const;

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
    `Prior loop history JSON: ${JSON.stringify(input.history)}`,
  ].join('\n');
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

export async function callOpenRouter(input: {
  apiKey: string;
  model: string;
  prompt: string;
  httpReferer?: string;
  xTitle?: string;
  responseSchema?: typeof reviewOutputV2JsonSchema | typeof workspaceTaskActionJsonSchema;
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

  const bodyText = await response.text();
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
  options?: { openrouterApiKey?: string | null }
): Promise<AgentAction> {
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';
  const history = Array.isArray(request.history) ? request.history : [];

  const requestApiKey = typeof options?.openrouterApiKey === 'string' ? options.openrouterApiKey.trim() : '';
  const envApiKey = (env.OPENROUTER_API_KEY ?? '').trim();
  const apiKey = requestApiKey || envApiKey;
  if (!apiKey) {
    throw new AgentEndpointError('missing_openrouter_api_key', 500, {
      message: 'OPENROUTER_API_KEY is required',
    });
  }

  const model = resolveOpenRouterModel(request.model, env.DEFAULT_MODEL);
  const httpReferer = typeof env.OPENROUTER_HTTP_REFERER === 'string' ? env.OPENROUTER_HTTP_REFERER.trim() : '';
  const xTitle = typeof env.OPENROUTER_X_TITLE === 'string' ? env.OPENROUTER_X_TITLE.trim() : '';
  if (!isReviewPrompt(prompt)) {
    const step = typeof request.step === 'number' && Number.isFinite(request.step) ? Math.max(1, Math.floor(request.step)) : 1;
    const maxSteps =
      typeof request.maxSteps === 'number' && Number.isFinite(request.maxSteps) ? Math.max(step, Math.floor(request.maxSteps)) : step;
    const content = await callOpenRouter({
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

  const content = await callOpenRouter({
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
