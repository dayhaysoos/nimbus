import type { SSEEvent, JobResponse, JobsListResponse } from './types.js';

/**
 * Get the worker URL from environment
 */
export function getWorkerUrl(): string | undefined {
  return process.env.NIMBUS_WORKER_URL;
}

/**
 * Get auth token for log retrieval
 */
export function getAuthToken(): string | undefined {
  return process.env.NIMBUS_AUTH_TOKEN || process.env.AUTH_TOKEN;
}

/**
 * Parse SSE stream from worker
 */
export async function* parseSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE messages
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || ''; // Keep incomplete message in buffer

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6)) as SSEEvent;
          yield data;
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }
}

/**
 * Create a new job
 */
export async function createJob(
  workerUrl: string,
  prompt: string,
  model: string
): Promise<Response> {
  const response = await fetch(`${workerUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response;
}

/**
 * Get job by ID
 */
export async function getJob(workerUrl: string, jobId: string): Promise<JobResponse> {
  const response = await fetch(`${workerUrl}/api/jobs/${jobId}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Job not found: ${jobId}`);
    }
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<JobResponse>;
}

/**
 * List all jobs
 */
export async function listJobs(workerUrl: string): Promise<JobsListResponse> {
  const response = await fetch(`${workerUrl}/api/jobs`);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<JobsListResponse>;
}

/**
 * Get build/deploy logs for a job
 */
export async function getJobLogs(
  workerUrl: string,
  jobId: string,
  type: 'build' | 'deploy',
  authToken: string
): Promise<string> {
  const response = await fetch(`${workerUrl}/api/jobs/${jobId}/logs?type=${type}`, {
    headers: { Auth: authToken },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.text();
}

/**
 * Validate a model against OpenRouter API
 */
export async function validateModel(model: string): Promise<boolean> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      return false;
    }
    const data = (await response.json()) as { data: { id: string }[] };
    return data.data.some((m) => m.id === model);
  } catch {
    return false;
  }
}
