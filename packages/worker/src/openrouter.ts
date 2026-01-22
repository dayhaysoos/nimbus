import type { GeneratedCode, OpenRouterRequest, OpenRouterResponse } from './types.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM_PROMPT = `You are an expert web developer. Generate a complete, working website based on the user's request.

OUTPUT FORMAT:
Return ONLY valid JSON with this exact structure:
{
  "files": [
    { "path": "index.html", "content": "..." },
    { "path": "styles.css", "content": "..." }
  ]
}

Include all files needed for the project to work.
Do not include markdown explanations, just the JSON.`;

export async function generateCode(
  apiKey: string,
  model: string,
  prompt: string
): Promise<GeneratedCode> {
  const request: OpenRouterRequest = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    max_tokens: 8192,
    temperature: 0.7,
  };

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
    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as OpenRouterResponse;

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

    return parsed;
  } catch (parseError) {
    throw new Error(
      `Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}\n\nRaw content:\n${content.slice(0, 500)}...`
    );
  }
}
