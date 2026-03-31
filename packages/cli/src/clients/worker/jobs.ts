import type { CheckpointJobCreateResponse, JobResponse, JobsListResponse } from '../../lib/types.js';
import { throwWorkerError, workerFetch } from './shared.js';

export async function createCheckpointJob(workerUrl: string, formData: FormData): Promise<CheckpointJobCreateResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/checkpoint/jobs`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<CheckpointJobCreateResponse>;
}

export async function getJob(workerUrl: string, jobId: string): Promise<JobResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/jobs/${jobId}`);

  if (!response.ok) {
    await throwWorkerError(response, `Job not found: ${jobId}`);
  }

  return response.json() as Promise<JobResponse>;
}

export async function listJobs(workerUrl: string): Promise<JobsListResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/jobs`);

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<JobsListResponse>;
}
