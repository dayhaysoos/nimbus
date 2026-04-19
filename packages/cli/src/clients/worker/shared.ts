const DEFAULT_WORKER_URL = 'https://nimbus-worker.ndejesus1227.workers.dev';
const DEFAULT_WORKER_ORIGIN = new URL(DEFAULT_WORKER_URL).origin;
const MISSING_API_KEY_WARNING =
  'NIMBUS_API_KEY is required to use the hosted Nimbus worker. Set it in your env or .env file.';

let hasWarnedMissingHostedApiKey = false;

export function __resetApiClientStateForTests(): void {
  hasWarnedMissingHostedApiKey = false;
}

function readNimbusApiKey(): string | null {
  const value = process.env.NIMBUS_API_KEY;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readOpenrouterApiKey(): string | null {
  const value = process.env.OPENROUTER_API_KEY;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readReviewModelHint(): string | null {
  const value = process.env.REVIEW_MODEL ?? process.env.NIMBUS_REVIEW_MODEL;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readEnvKey(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerEnvVarForModel(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('openai/')) {
    return 'OPENAI_API_KEY';
  }
  if (normalized.startsWith('anthropic/')) {
    return 'ANTHROPIC_API_KEY';
  }
  if (normalized.startsWith('google/') || normalized.startsWith('gemini/') || normalized.startsWith('vertex/')) {
    return 'GOOGLE_API_KEY';
  }
  if (normalized.startsWith('groq/')) {
    return 'GROQ_API_KEY';
  }
  if (normalized.startsWith('grok/') || normalized.startsWith('xai/')) {
    return 'XAI_API_KEY';
  }
  if (normalized.startsWith('mistral/')) {
    return 'MISTRAL_API_KEY';
  }
  if (normalized.startsWith('cohere/')) {
    return 'COHERE_API_KEY';
  }
  if (normalized.startsWith('deepseek/')) {
    return 'DEEPSEEK_API_KEY';
  }
  if (normalized.startsWith('perplexity/')) {
    return 'PERPLEXITY_API_KEY';
  }
  return null;
}

export function readProviderApiKey(): string | null {
  const explicit = readEnvKey('REVIEW_PROVIDER_API_KEY');
  if (explicit) {
    return explicit;
  }

  const modelHint = readReviewModelHint();
  if (modelHint) {
    const hintedEnvVar = providerEnvVarForModel(modelHint);
    if (hintedEnvVar) {
      const hintedValue = readEnvKey(hintedEnvVar);
      if (hintedValue) {
        return hintedValue;
      }
    }
  }

  const candidates = [
    readEnvKey('OPENAI_API_KEY'),
    readEnvKey('ANTHROPIC_API_KEY'),
    readEnvKey('GOOGLE_API_KEY'),
    readEnvKey('GROQ_API_KEY'),
    readEnvKey('XAI_API_KEY'),
    readEnvKey('MISTRAL_API_KEY'),
    readEnvKey('COHERE_API_KEY'),
    readEnvKey('DEEPSEEK_API_KEY'),
    readEnvKey('PERPLEXITY_API_KEY'),
  ].filter((value): value is string => Boolean(value));

  return candidates.length === 1 ? candidates[0] : null;
}

function readReviewGithubToken(): string | null {
  return typeof process.env.REVIEW_CONTEXT_GITHUB_TOKEN === 'string' && process.env.REVIEW_CONTEXT_GITHUB_TOKEN.trim()
    ? process.env.REVIEW_CONTEXT_GITHUB_TOKEN.trim()
    : null;
}

function usesHostedWorker(workerUrl: string): boolean {
  try {
    return new URL(workerUrl).origin === DEFAULT_WORKER_ORIGIN;
  } catch {
    return false;
  }
}

function maybeWarnMissingApiKey(workerUrl: string, apiKey: string | null): void {
  if (apiKey || hasWarnedMissingHostedApiKey || !usesHostedWorker(workerUrl)) {
    return;
  }
  hasWarnedMissingHostedApiKey = true;
  process.stderr.write(`${MISSING_API_KEY_WARNING}\n`);
}

function toHeaderRecord(headers?: RequestInit['headers']): Record<string, string> {
  const requestHeaders: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      requestHeaders[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      requestHeaders[key] = value;
    }
  } else if (headers) {
    Object.assign(requestHeaders, headers as Record<string, string>);
  }
  return requestHeaders;
}

function withAuthHeaders(workerUrl: string, headers?: RequestInit['headers']): Record<string, string> {
  const requestHeaders = toHeaderRecord(headers);
  const apiKey = readNimbusApiKey();
  if (apiKey) {
    requestHeaders['X-Nimbus-Api-Key'] = apiKey;
  }
  maybeWarnMissingApiKey(workerUrl, apiKey);
  return requestHeaders;
}

export function withReviewHeaders(baseHeaders?: RequestInit['headers']): Record<string, string> {
  const headers = toHeaderRecord(baseHeaders);

  const providerApiKey = readProviderApiKey();
  if (providerApiKey) {
    headers['X-Provider-Api-Key'] = providerApiKey;
  }

  const openrouterApiKey = readOpenrouterApiKey();
  if (openrouterApiKey) {
    headers['X-Openrouter-Api-Key'] = openrouterApiKey;
  }

  const reviewGithubToken = readReviewGithubToken();
  if (reviewGithubToken) {
    headers['X-Review-Github-Token'] = reviewGithubToken;
  }

  return headers;
}

export function getWorkerUrl(): string {
  return process.env.NIMBUS_WORKER_URL || DEFAULT_WORKER_URL;
}

export async function workerFetch(workerUrl: string, url: string, init?: RequestInit): Promise<Response> {
  const headers = withAuthHeaders(workerUrl, init?.headers);
  return fetch(url, {
    ...init,
    headers,
  });
}

export async function workerFetchWithoutAuth(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

export async function throwWorkerError(response: Response, notFoundMessage?: string): Promise<never> {
  if (response.status === 404 && notFoundMessage) {
    throw new Error(notFoundMessage);
  }
  const errorText = await response.text();
  throw new Error(`Worker error (${response.status}): ${errorText}`);
}
