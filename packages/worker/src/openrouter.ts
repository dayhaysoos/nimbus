import type {
  GeneratedCode,
  GeneratedFile,
  OpenRouterRequest,
  OpenRouterResponse,
  OpenRouterGenerationResponse,
} from './types.js';
import { buildFrameworkPrompt } from './frameworks/index.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_GENERATION_URL = 'https://openrouter.ai/api/v1/generation';

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'nimbus_generated_code',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
} as const;

/**
 * Fetch cost information from OpenRouter's Generation API
 * This is the most reliable way to get accurate cost in USD
 */
async function fetchGenerationCost(apiKey: string, generationId: string): Promise<number> {
  // Small delay to ensure the generation is recorded
  await new Promise((resolve) => setTimeout(resolve, 500));

  const response = await fetch(`${OPENROUTER_GENERATION_URL}?id=${generationId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch generation: ${response.status}`);
  }

  const data = (await response.json()) as OpenRouterGenerationResponse;
  return data.data.total_cost ?? 0;
}

async function fetchOpenRouterResponse(
  apiKey: string,
  request: OpenRouterRequest
): Promise<OpenRouterResponse> {
  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/dayhaysoos/nimbus',
      'X-Title': 'Nimbus LLM Benchmarking',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText) as { error?: { message?: string } };
      if (parsed?.error?.message) {
        message = parsed.error.message;
      }
    } catch {
      // Ignore parse errors
    }
    throw new Error(`OpenRouter API error (${response.status}): ${message}`);
  }

  return (await response.json()) as OpenRouterResponse;
}

function isResponseFormatUnsupported(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('response_format') ||
    normalized.includes('structured output') ||
    normalized.includes('json_schema') ||
    normalized.includes('schema')
  );
}

const BASE_SYSTEM_PROMPT = `You are an expert web developer. Generate a complete, working website based on the user's request.

OUTPUT FORMAT:
Return ONLY valid JSON with this exact structure:
{
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "styles.css", "content": "..." }
  ]
}

Include all files needed for the project to work.
Do not include markdown explanations, just the JSON.
`;

function buildSystemPrompt(prompt: string): string {
  const frameworkRules = buildFrameworkPrompt(prompt);
  return `${BASE_SYSTEM_PROMPT}\n\nFRAMEWORK RULES:\n${frameworkRules}`;
}

// Result from generateCode including usage metrics
export interface GenerateCodeResult {
  files: GeneratedFile[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
  };
  llmLatencyMs: number;
}

export async function generateCode(
  apiKey: string,
  model: string,
  prompt: string
): Promise<GenerateCodeResult> {
  const startTime = Date.now();
  const baseRequest: OpenRouterRequest = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(prompt) },
      { role: 'user', content: prompt },
    ],
    max_tokens: 8192,
    temperature: 0.7,
  };

  let data: OpenRouterResponse;
  try {
    data = await fetchOpenRouterResponse(apiKey, { ...baseRequest, response_format: RESPONSE_FORMAT });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isResponseFormatUnsupported(message)) {
      throw error;
    }
    data = await fetchOpenRouterResponse(apiKey, baseRequest);
  }

  if (!data.choices || data.choices.length === 0) {
    throw new Error('OpenRouter returned no choices');
  }

  const content = data.choices[0].message.content;

  // Parse the JSON response from Claude
  // Handle potential markdown code blocks
  let jsonContent = content.trim();
  
  // Remove markdown code fences if present
  if (jsonContent.startsWith('```json')) {
    jsonContent = jsonContent.slice(7);
  } else if (jsonContent.startsWith('```')) {
    jsonContent = jsonContent.slice(3);
  }
  if (jsonContent.endsWith('```')) {
    jsonContent = jsonContent.slice(0, -3);
  }
  jsonContent = jsonContent.trim();

  try {
    const parsed = JSON.parse(jsonContent) as GeneratedCode;

    if (!parsed.files || !Array.isArray(parsed.files)) {
      throw new Error('Invalid response structure: missing files array');
    }

    // Validate each file has path and content
    for (const file of parsed.files) {
      if (typeof file.path !== 'string' || typeof file.content !== 'string') {
        throw new Error('Invalid file structure: each file must have path and content strings');
      }
    }

    const llmLatencyMs = Date.now() - startTime;

    // Get cost - try from direct response first, then query Generation API
    let cost = data.usage.cost ?? 0;

    // If cost is 0 or not provided, try to get it from the Generation API
    if (cost === 0 && data.id) {
      try {
        cost = await fetchGenerationCost(apiKey, data.id);
      } catch {
        // Silently fall back to 0 if we can't get the cost
        console.warn('Could not fetch generation cost from OpenRouter API');
      }
    }

    return {
      files: parsed.files,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
        cost,
      },
      llmLatencyMs,
    };
  } catch (parseError) {
    throw new Error(
      `Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}\n\nRaw content:\n${content.slice(0, 500)}...`
    );
  }
}
