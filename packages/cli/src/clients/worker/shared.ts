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

function readOpenrouterApiKey(): string | null {
  const value = process.env.OPENROUTER_API_KEY;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
