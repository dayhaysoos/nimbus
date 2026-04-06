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
const REVIEW_PROVIDER_MAX_ATTEMPTS = 2;
const REVIEW_PROVIDER_RETRY_DELAY_MS = 750;
const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REVIEW_HISTORY_MAX_BYTES = 120_000;

export type ReviewAgentHistoryEntry =
  | { role: 'assistant'; content: string }
  | { role: 'tool'; tool: string; output: unknown };

export interface ReviewAgentProvider {
  next(input: {
    prompt: string;
    model: string;
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
    forceComplete?: boolean;
  }): Promise<ReviewAgentAction>;
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
          { type: 'string', enum: ['list_files', 'read_file', 'diff_summary', 'search_code'] },
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
              maxBytes: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              query: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              maxResults: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              maxBytesPerFile: { anyOf: [{ type: 'number' }, { type: 'null' }] },
              caseSensitive: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
            },
            required: ['path', 'maxBytes', 'query', 'maxResults', 'maxBytesPerFile', 'caseSensitive'],
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

function buildHistoryForPrompt(history: ReviewAgentHistoryEntry[]): string {
  const serialized = JSON.stringify(history);
  return clampText(serialized, REVIEW_HISTORY_MAX_BYTES).text;
}

function buildOpenRouterStepPrompt(input: {
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
    '- Tools available: list_files, read_file, diff_summary, search_code.',
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
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
    forceComplete?: boolean;
  }): Promise<ReviewAgentAction> {
    const forceComplete = input.forceComplete === true;

    for (let attempt = 1; attempt <= REVIEW_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      try {
        const requestPromise = fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'HTTP-Referer': this.httpReferer,
            'X-Title': this.xTitle,
          },
          body: JSON.stringify({
            model: input.model,
            response_format: { type: 'json_schema', json_schema: reviewAgentActionJsonSchema },
            plugins: [{ id: 'response-healing' }],
            messages: [
              {
                role: 'user',
                content: buildOpenRouterStepPrompt({
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

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort('review_provider_timeout');
            reject(new Error(`Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds`));
          }, REVIEW_PROVIDER_TIMEOUT_MS);
        });

        const response = await Promise.race([requestPromise, timeoutPromise]);
        const bodyText = await response.text();
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
    private readonly openrouterApiKey: string | null,
    private readonly validateAction: (action: unknown) => ReviewAgentAction
  ) {}

  async next(input: {
    prompt: string;
    model: string;
    maxSteps: number;
    step: number;
    history: ReviewAgentHistoryEntry[];
    forceComplete?: boolean;
  }): Promise<ReviewAgentAction> {
    const requestFetch = this.serviceBinding ? this.serviceBinding.fetch.bind(this.serviceBinding) : fetch;

    for (let attempt = 1; attempt <= REVIEW_PROVIDER_MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      try {
        const requestPromise = requestFetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
            ...(this.openrouterApiKey ? { 'X-Openrouter-Api-Key': this.openrouterApiKey } : {}),
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
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort('review_provider_timeout');
            reject(new Error(`Review analysis provider request timed out after ${Math.floor(REVIEW_PROVIDER_TIMEOUT_MS / 1000)} seconds`));
          }, REVIEW_PROVIDER_TIMEOUT_MS);
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
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    }

    throw new Error('Review analysis provider exhausted retry attempts without a valid response');
  }
}
