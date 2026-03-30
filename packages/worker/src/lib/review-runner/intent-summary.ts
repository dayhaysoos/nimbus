import type { Env, ReviewApprovedPolicy, ReviewSessionIntentSummary } from '../../types.js';
import { redactReviewText } from '../review-redaction.js';
import { extractJsonObject, stripCodeFences } from '../review-analysis.js';

const INTENT_SUMMARY_MODEL = 'anthropic/claude-sonnet-4.5';
const INTENT_SUMMARY_MAX_TOKENS = 512;
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
 * Runs the OpenRouter pre-pass that extracts concise review intent from raw session prompts.
 * Falls back to `null` on timeouts, schema failures, or upstream model errors.
 */
export async function runIntentSummarizationPrePass(
  env: Env,
  rawSessionPrompts: string,
  options?: { openrouterApiKey?: string | null; intentSummaryModel?: string | null }
): Promise<ReviewSessionIntentSummary | null> {
  const INTENT_SUMMARY_TIMEOUT_MS = 15_000;
  const envApiKey = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY.trim() : '';
  const requestApiKey = typeof options?.openrouterApiKey === 'string' ? options.openrouterApiKey.trim() : '';
  const requestModel = typeof options?.intentSummaryModel === 'string' ? options.intentSummaryModel.trim() : '';
  const envModel = typeof env.REVIEW_INTENT_SUMMARY_MODEL === 'string' ? env.REVIEW_INTENT_SUMMARY_MODEL.trim() : '';
  const summaryModel = requestModel || envModel || INTENT_SUMMARY_MODEL;
  const apiKey = envApiKey || requestApiKey;
  if (!apiKey) {
    console.warn('[intent-summary] pre-pass failed: OPENROUTER_API_KEY not configured');
    return null;
  }

  try {
    const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTENT_SUMMARY_TIMEOUT_MS);
    const response = await (async () => {
      try {
        return await fetch(openRouterUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: summaryModel,
            max_tokens: INTENT_SUMMARY_MAX_TOKENS,
            messages: [
              { role: 'system', content: INTENT_SUMMARY_SYSTEM_PROMPT },
              { role: 'user', content: rawSessionPrompts },
            ],
          }),
        });
      } finally {
        clearTimeout(timeout);
      }
    })();

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`openrouter request failed (${response.status}): ${redactReviewText(body) ?? ''}`);
    }

    const payload = (await response.json()) as unknown;
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
    openrouterApiKey: input.openrouterApiKey,
    intentSummaryModel: input.intentSummaryModel,
  });
  return modelSummary ?? deriveIntentSummaryFallback(rawSessionPrompts, intentSessionContext);
}
