import type { Env, ReviewApprovedPolicy, ReviewSessionIntentSummary } from '../../types.js';
import { redactReviewText } from '../review-redaction.js';
import { extractJsonObject, stripCodeFences } from '../review-analysis.js';
import {
  isCloudflareAiGatewayModel,
  normalizeOpenAiGatewayModel,
  parseOpenAiResponsesContent,
  readResponseTextWithIdleTimeout,
  resolveCloudflareAiGatewayConfig,
  resolveOpenAiGatewayBaseUrl,
  usesOpenAiResponsesApi,
} from '../review-analysis/provider.js';

const INTENT_SUMMARY_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const INTENT_SUMMARY_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';
const INTENT_SUMMARY_MAX_TOKENS = 512;
const INTENT_SUMMARY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goal: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    prohibitions: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
  },
  required: ['goal', 'prohibitions', 'constraints'],
} as const;
const INTENT_SUMMARY_NON_POLICY_LINE_PATTERN =
  /\b(step\s*\d+|start with step|next step|exact order|one step at a time|showing me each file change|before moving to the next|before committing|commit and push|run migrations|deploy to worker|test locally|summarize the task tool output|go ahead with step)\b/i;
const INTENT_SUMMARY_NON_POLICY_PREFIX_PATTERN = /^(f-\d{3}\b|fix:)/i;
const INTENT_SUMMARY_SYSTEM_PROMPT = `You are a staff engineer reviewing a colleague's session notes
before conducting a code review. Your job is to extract the
key intent signals from their notes so the reviewer understands
what the developer was trying to do, what they were worried
about, and what constraints they were working within.
Prefer explicit statements over inference; do not over-generalize risk from implementation details.

Return only a JSON object with no surrounding prose:
{
  "goal": string or null,
  "prohibitions": string[],
  "constraints": string[]
}

Field guidance:
- goal: the developer's primary objective in one sentence.
  If unclear, return null.
- prohibitions: things the developer explicitly said must
  not happen. Max 5 items.
- constraints: preferences, requirements, or boundaries
  the developer stated they were working within. Max 5 items.

Rules:
- Skip any line phrased as a question.
- Skip any line that is directing an AI tool to do something.
- Skip implementation details and step-by-step instructions.
- Never include sequencing/process directives (examples: "Step 1",
  "start with", "before committing", "run migrations", "deploy",
  "test locally", "commit and push").
- Never include finding IDs or fix bullets (examples: "F-002", "Fix:").
- Keep each extracted item to one concise sentence.
- If a category has nothing clear to extract, return an
  empty array or null.
- If uncertain whether a signal is explicit, omit it.
- Do not duplicate the same item across multiple categories.
- When more than 5 candidates exist for a category,
  prioritize the most explicitly stated items over
  inferred ones.
- Do not invent intent that is not present or implied
  in the notes.
- This summary is prioritization context for code review,
  not direct evidence of defects.`;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseOpenRouterMessageContent(payload: unknown): string {
  const record = asRecord(payload);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  const choiceRecord = asRecord(first);
  const messageRecord = asRecord(choiceRecord.message);
  const content = messageRecord.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const partRecord = asRecord(part);
        return typeof partRecord.text === 'string' ? partRecord.text : '';
      })
      .join('')
      .trim();
  }
  return '';
}

function parseCloudflareAiContent(payload: unknown): unknown {
  const record = asRecord(payload);
  const response = record.response;
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return response;
  }
  if (typeof response !== 'string' || !response.trim()) {
    throw new Error('workers ai response content was empty');
  }

  try {
    return JSON.parse(stripCodeFences(response));
  } catch (firstError) {
    try {
      return JSON.parse(extractJsonObject(response));
    } catch (secondError) {
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`json parse failed: stripCodeFences=${firstMessage}; extractJsonObject=${secondMessage}`);
    }
  }
}

function isCloudflareAiModel(model: string): boolean {
  return /^@(cf|hf)\//.test(model.trim());
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function validateIntentSummaryPayload(value: unknown): ReviewSessionIntentSummary | null {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return null;
  }

  const isPolicyLine = (line: string): boolean => {
    if (!line) {
      return false;
    }
    if (INTENT_SUMMARY_NON_POLICY_PREFIX_PATTERN.test(line)) {
      return false;
    }
    return !INTENT_SUMMARY_NON_POLICY_LINE_PATTERN.test(line);
  };

  const normalizeList = (input: unknown): string[] =>
    Array.isArray(input)
      ? Array.from(
          new Set(
            input
              .filter((item): item is string => typeof item === 'string')
              .map((item) => item.trim())
              .filter(isPolicyLine)
          )
        ).slice(0, 5)
      : [];

  const goalRaw = typeof record.goal === 'string' ? record.goal.trim() : null;
  const goal = goalRaw && isPolicyLine(goalRaw) ? goalRaw : null;

  const summary: ReviewSessionIntentSummary = {
    goal,
    prohibitions: normalizeList(record.prohibitions),
    constraints: normalizeList(record.constraints),
  };

  if (!summary.goal && summary.prohibitions.length === 0 && summary.constraints.length === 0) {
    return null;
  }

  return summary;
}

function deriveIntentSummaryFallback(
  rawSessionPrompts: string,
  intentSessionContext: string[]
): ReviewSessionIntentSummary | null {
  const lines = [...rawSessionPrompts.split(/\r?\n/), ...intentSessionContext]
    .map((line) => line.trim())
    .filter(Boolean);

  let goal: string | null = null;
  const prohibitions: string[] = [];
  const constraints: string[] = [];

  for (const line of lines) {
    const goalMatch = line.match(/^goal\s*:\s*(.+)$/i);
    if (!goal && goalMatch?.[1]?.trim()) {
      goal = goalMatch[1].trim();
      continue;
    }

    const prohibitionMatch = line.match(/^prohibition\s*:\s*(.+)$/i);
    if (prohibitionMatch?.[1]?.trim()) {
      prohibitions.push(prohibitionMatch[1].trim());
      continue;
    }

    const constraintMatch = line.match(/^constraint\s*:\s*(.+)$/i);
    if (constraintMatch?.[1]?.trim()) {
      constraints.push(constraintMatch[1].trim());
    }
  }

  const summary: ReviewSessionIntentSummary = {
    goal,
    prohibitions: uniqueStrings(prohibitions),
    constraints: uniqueStrings(constraints),
  };

  if (!summary.goal && summary.prohibitions.length === 0 && summary.constraints.length === 0) {
    return null;
  }

  return summary;
}

/**
 * Converts an approved review policy into the normalized intent-summary shape used by report provenance.
 */
export function intentSummaryFromApprovedPolicy(policy: ReviewApprovedPolicy): ReviewSessionIntentSummary {
  return {
    goal: policy.goal,
    prohibitions: policy.prohibitions,
    constraints: policy.constraints,
  };
}

/**
 * Runs the model-backed pre-pass that extracts concise review intent from raw session prompts.
 * Prefers AI Gateway for provider-scoped models, Workers AI for @cf models, and falls back to OpenRouter when necessary.
 */
export async function runIntentSummarizationPrePass(
  env: Env,
  rawSessionPrompts: string,
  options?: { providerApiKey?: string | null; openrouterApiKey?: string | null; intentSummaryModel?: string | null }
): Promise<ReviewSessionIntentSummary | null> {
  const INTENT_SUMMARY_TIMEOUT_MS = 15_000;
  const envApiKey = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY.trim() : '';
  const requestProviderApiKey = typeof options?.providerApiKey === 'string' ? options.providerApiKey.trim() : '';
  const requestApiKey = typeof options?.openrouterApiKey === 'string' ? options.openrouterApiKey.trim() : '';
  const requestModel = typeof options?.intentSummaryModel === 'string' ? options.intentSummaryModel.trim() : '';
  const envModel = typeof env.REVIEW_INTENT_SUMMARY_MODEL === 'string' ? env.REVIEW_INTENT_SUMMARY_MODEL.trim() : '';
  const reviewModel = typeof env.REVIEW_MODEL === 'string' ? env.REVIEW_MODEL.trim() : '';
  const configuredModel = requestModel || envModel || reviewModel;
  const cloudflareSummaryModel =
    configuredModel && isCloudflareAiModel(configuredModel) ? configuredModel : INTENT_SUMMARY_AI_MODEL;
  const openRouterSummaryModel =
    configuredModel && !isCloudflareAiModel(configuredModel) ? configuredModel : INTENT_SUMMARY_OPENROUTER_MODEL;
  const aiGatewaySummaryModel =
    configuredModel && isCloudflareAiGatewayModel(configuredModel) ? configuredModel : openRouterSummaryModel;
  const apiKey = envApiKey || requestApiKey;
  const aiBinding = typeof env.AI?.run === 'function' ? env.AI : null;
  const aiGatewayConfig = resolveCloudflareAiGatewayConfig(env);

  try {
    if (aiGatewayConfig && isCloudflareAiGatewayModel(aiGatewaySummaryModel)) {
      if (!requestProviderApiKey && !aiGatewayConfig.byokAlias) {
        throw new Error('provider API key required for AI Gateway intent summarization');
      }
      const openAiResponsesApi = usesOpenAiResponsesApi(aiGatewaySummaryModel);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), INTENT_SUMMARY_TIMEOUT_MS);
      const { response, bodyText } = await (async (): Promise<{ response: Response; bodyText: string }> => {
        try {
          const response = await fetch(
            openAiResponsesApi
              ? `${resolveOpenAiGatewayBaseUrl(aiGatewayConfig.baseUrl)}/responses`
              : `${aiGatewayConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
              method: 'POST',
              signal: controller.signal,
              headers: {
                'Content-Type': 'application/json',
                'cf-aig-authorization': `Bearer ${aiGatewayConfig.authToken}`,
                'cf-aig-collect-log-payload': aiGatewayConfig.collectLogPayload ? 'true' : 'false',
                ...(aiGatewayConfig.byokAlias ? { 'cf-aig-byok-alias': aiGatewayConfig.byokAlias } : {}),
                ...(requestProviderApiKey ? { Authorization: `Bearer ${requestProviderApiKey}` } : {}),
              },
              body: JSON.stringify(
                openAiResponsesApi
                  ? {
                      model: normalizeOpenAiGatewayModel(aiGatewaySummaryModel),
                      max_output_tokens: INTENT_SUMMARY_MAX_TOKENS,
                      text: {
                        format: {
                          type: 'json_schema',
                          name: 'ReviewIntentSummary',
                          strict: true,
                          schema: INTENT_SUMMARY_JSON_SCHEMA,
                        },
                      },
                      input: `${INTENT_SUMMARY_SYSTEM_PROMPT}\n\nDeveloper notes:\n${rawSessionPrompts}`,
                    }
                  : {
                      model: aiGatewaySummaryModel,
                      temperature: 0,
                      max_tokens: INTENT_SUMMARY_MAX_TOKENS,
                      response_format: {
                        type: 'json_schema',
                        json_schema: {
                          name: 'ReviewIntentSummary',
                          strict: true,
                          schema: INTENT_SUMMARY_JSON_SCHEMA,
                        },
                      },
                      messages: [
                        { role: 'system', content: INTENT_SUMMARY_SYSTEM_PROMPT },
                        { role: 'user', content: rawSessionPrompts },
                      ],
                    }
              ),
            }
          );
          const bodyText = await readResponseTextWithIdleTimeout(response, { idleTimeoutMs: 10_000, maxBytes: 64_000 });
          return { response, bodyText };
        } finally {
          clearTimeout(timeout);
        }
      })();

      if (!response.ok) {
        throw new Error(`ai gateway request failed (${response.status}): ${redactReviewText(bodyText) ?? ''}`);
      }

      const payload = bodyText ? (JSON.parse(bodyText) as unknown) : null;
      const content = openAiResponsesApi ? parseOpenAiResponsesContent(payload) : parseOpenRouterMessageContent(payload);
      if (!content) {
        throw new Error('ai gateway response content was empty');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFences(content));
      } catch (firstError) {
        try {
          parsed = JSON.parse(extractJsonObject(content));
        } catch (secondError) {
          const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
          const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
          throw new Error(`json parse failed: stripCodeFences=${firstMessage}; extractJsonObject=${secondMessage}`);
        }
      }

      const summary = validateIntentSummaryPayload(parsed);
      if (!summary) {
        throw new Error('schema validation failed');
      }

      return summary;
    }

    if (aiBinding && (configuredModel ? isCloudflareAiModel(configuredModel) : true)) {
      const result = await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let abortController: AbortController | null = null;

        const settle = (callback: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          callback();
        };

        timeoutId = setTimeout(() => {
          abortController?.abort();
          settle(() => reject(new Error(`request timed out after ${INTENT_SUMMARY_TIMEOUT_MS}ms`)));
        }, INTENT_SUMMARY_TIMEOUT_MS);

        abortController = new AbortController();
        aiBinding
          .run(cloudflareSummaryModel, {
            messages: [
              { role: 'system', content: INTENT_SUMMARY_SYSTEM_PROMPT },
              { role: 'user', content: rawSessionPrompts },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: INTENT_SUMMARY_JSON_SCHEMA,
            },
            max_tokens: INTENT_SUMMARY_MAX_TOKENS,
            temperature: 0,
          })
          .then((value) => settle(() => resolve(value)))
          .catch((error) => settle(() => reject(error)));
      });

      const summary = validateIntentSummaryPayload(parseCloudflareAiContent(result));
      if (!summary) {
        throw new Error('schema validation failed');
      }

      return summary;
    }

    if (!apiKey) {
      console.warn('[intent-summary] pre-pass failed: no AI binding or OPENROUTER_API_KEY configured');
      return null;
    }

    const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTENT_SUMMARY_TIMEOUT_MS);
    const { response, bodyText } = await (async (): Promise<{ response: Response; bodyText: string }> => {
      try {
        const response = await fetch(openRouterUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: openRouterSummaryModel,
            max_tokens: INTENT_SUMMARY_MAX_TOKENS,
            messages: [
              { role: 'system', content: INTENT_SUMMARY_SYSTEM_PROMPT },
              { role: 'user', content: rawSessionPrompts },
            ],
          }),
        });
        const bodyText = await readResponseTextWithIdleTimeout(response, { idleTimeoutMs: 10_000, maxBytes: 64_000 });
        return { response, bodyText };
      } finally {
        clearTimeout(timeout);
      }
    })();

    if (!response.ok) {
      throw new Error(`openrouter request failed (${response.status}): ${redactReviewText(bodyText) ?? ''}`);
    }

    const payload = bodyText ? (JSON.parse(bodyText) as unknown) : null;
    const content = parseOpenRouterMessageContent(payload);
    if (!content) {
      throw new Error('openrouter response content was empty');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFences(content));
    } catch (firstError) {
      try {
        parsed = JSON.parse(extractJsonObject(content));
      } catch (secondError) {
        const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
        const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
        throw new Error(`json parse failed: stripCodeFences=${firstMessage}; extractJsonObject=${secondMessage}`);
      }
    }

    const summary = validateIntentSummaryPayload(parsed);
    if (!summary) {
      throw new Error('schema validation failed');
    }

    return summary;
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `request timed out after ${INTENT_SUMMARY_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    console.warn(`[intent-summary] pre-pass failed: ${message}`);
    return null;
  }
}

/**
 * Produces review intent from raw session prompts, preferring the model-backed pre-pass and
 * falling back to heuristic extraction when no reliable structured summary is available.
 */
export async function summarizeReviewIntentPolicy(
  env: Env,
  input: {
    rawSessionPrompts: string;
    intentSessionContext?: string[];
    providerApiKey?: string | null;
    openrouterApiKey?: string | null;
    intentSummaryModel?: string | null;
  }
): Promise<ReviewSessionIntentSummary | null> {
  const rawSessionPrompts = input.rawSessionPrompts.trim();
  const intentSessionContext = uniqueStrings(
    Array.isArray(input.intentSessionContext)
      ? input.intentSessionContext.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
      : []
  );
  if (!rawSessionPrompts) {
    return null;
  }
  const modelSummary = await runIntentSummarizationPrePass(env, rawSessionPrompts, {
    providerApiKey: input.providerApiKey,
    openrouterApiKey: input.openrouterApiKey,
    intentSummaryModel: input.intentSummaryModel,
  });
  return modelSummary ?? deriveIntentSummaryFallback(rawSessionPrompts, intentSessionContext);
}
