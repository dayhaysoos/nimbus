import type {
  JobResponse,
  JobsListResponse,
  CheckpointJobCreateResponse,
  WorkspaceCreateResponse,
  WorkspaceResponse,
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

/**
 * Create a workspace from checkpoint source bundle
 */
export async function createWorkspace(
  workerUrl: string,
  formData: FormData
): Promise<WorkspaceCreateResponse> {
  const response = await fetch(`${workerUrl}/api/workspaces`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<WorkspaceCreateResponse>;
}

/**
 * Get workspace by ID
 */
export async function getWorkspace(workerUrl: string, workspaceId: string): Promise<WorkspaceResponse> {
  const response = await fetch(`${workerUrl}/api/workspaces/${workspaceId}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<WorkspaceResponse>;
}

/**
 * Delete workspace by ID
 */
export async function deleteWorkspace(workerUrl: string, workspaceId: string): Promise<{ status: string }> {
  const response = await fetch(`${workerUrl}/api/workspaces/${workspaceId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<{ status: string }>;
}
