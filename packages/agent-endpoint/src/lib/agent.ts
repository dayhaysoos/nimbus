type AgentHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; output: unknown };

export type AgentAction =
  | { type: 'tool'; tool: 'list_files'; args: { path?: string } }
  | { type: 'tool'; tool: 'read_file'; args: { path: string; maxBytes?: number } }
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
        response_format: { type: 'json_object' },
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
    throw new AgentEndpointError('openrouter_request_failed', 502, {
      status: response.status,
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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AgentEndpointError('invalid_model_output', 422, {
      errors: [{ path: '$', message: 'output must be an object' }],
    });
  }
  const record = payload as Record<string, unknown>;
  const errors: Array<{ path: string; message: string }> = [];

  if (!Array.isArray(record.findings)) {
    errors.push({ path: '$.findings', message: 'findings must be an array' });
  }

  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    errors.push({ path: '$.summary', message: 'summary must be a non-empty string' });
  }

  if (typeof record.furtherPassesLowYield !== 'boolean') {
    errors.push({ path: '$.furtherPassesLowYield', message: 'furtherPassesLowYield must be a boolean' });
  }

  if (errors.length > 0) {
    throw new AgentEndpointError('invalid_model_output', 422, { errors });
  }

  return {
    findings: record.findings as unknown[],
    summary: (record.summary as string).trim(),
    furtherPassesLowYield: record.furtherPassesLowYield as boolean,
  };
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

  if (!isReviewPrompt(prompt)) {
    return nextWorkspaceTaskAction(history);
  }

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
  const content = await callOpenRouter({
    apiKey,
    model,
    prompt,
    ...(httpReferer ? { httpReferer } : {}),
    ...(xTitle ? { xTitle } : {}),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(content));
  } catch {
    const candidate = extractJsonObjectCandidate(content);
    if (!candidate) {
      throw new AgentEndpointError('invalid_model_output', 422, {
        errors: [{ path: '$', message: 'model response was not valid JSON' }],
        preview: content.slice(0, 500),
      });
    }
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw new AgentEndpointError('invalid_model_output', 422, {
        errors: [{ path: '$', message: 'model response was not valid JSON' }],
        preview: content.slice(0, 500),
      });
    }
  }

  const validated = validateReviewOutputV2(parsed);
  return {
    type: 'final',
    summary: JSON.stringify(validated),
  };
}
