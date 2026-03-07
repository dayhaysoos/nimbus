import type {
  JobResponse,
  JobsListResponse,
  CheckpointJobCreateResponse,
} from './types.js';

/**
 * Get the worker URL from environment
 */
export function getWorkerUrl(): string | undefined {
  return process.env.NIMBUS_WORKER_URL;
}

/**
 * Create a checkpoint-based deployment job
 */
export async function createCheckpointJob(
  workerUrl: string,
  formData: FormData
): Promise<CheckpointJobCreateResponse> {
  const response = await fetch(`${workerUrl}/api/checkpoint/jobs`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<CheckpointJobCreateResponse>;
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
