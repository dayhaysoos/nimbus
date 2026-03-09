import type {
  JobResponse,
  JobsListResponse,
  CheckpointJobCreateResponse,
  WorkspaceCreateResponse,
  WorkspaceDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileResponse,
  WorkspaceResponse,
  WorkspaceDeploymentCreateResponse,
  WorkspaceDeploymentGetResponse,
  WorkspaceDeploymentPreflightResponse,
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

/**
 * List files for a workspace path.
 */
export async function listWorkspaceFiles(
  workerUrl: string,
  workspaceId: string,
  path?: string
): Promise<WorkspaceFileListResponse> {
  const url = new URL(`${workerUrl}/api/workspaces/${workspaceId}/files`);
  if (path) {
    url.searchParams.set('path', path);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<WorkspaceFileListResponse>;
}

/**
 * Read file content from workspace.
 */
export async function getWorkspaceFile(
  workerUrl: string,
  workspaceId: string,
  path: string,
  maxBytes?: number
): Promise<WorkspaceFileResponse> {
  const url = new URL(`${workerUrl}/api/workspaces/${workspaceId}/file`);
  url.searchParams.set('path', path);
  if (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0) {
    url.searchParams.set('max_bytes', String(Math.floor(maxBytes)));
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<WorkspaceFileResponse>;
}

/**
 * Get workspace diff summary and optional patch.
 */
export async function getWorkspaceDiff(
  workerUrl: string,
  workspaceId: string,
  options?: {
    includePatch?: boolean;
    maxBytes?: number;
  }
): Promise<WorkspaceDiffResponse> {
  const url = new URL(`${workerUrl}/api/workspaces/${workspaceId}/diff`);
  if (options?.includePatch) {
    url.searchParams.set('include_patch', 'true');
  }
  if (typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0) {
    url.searchParams.set('max_bytes', String(Math.floor(options.maxBytes)));
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<WorkspaceDiffResponse>;
}

export async function preflightWorkspaceDeployment(
  workerUrl: string,
  workspaceId: string,
  payload: {
    validation: {
      runBuildIfPresent: boolean;
      runTestsIfPresent: boolean;
    };
  }
): Promise<WorkspaceDeploymentPreflightResponse> {
  const response = await fetch(`${workerUrl}/api/workspaces/${workspaceId}/deploy/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<WorkspaceDeploymentPreflightResponse>;
}

export async function createWorkspaceDeployment(
  workerUrl: string,
  workspaceId: string,
  idempotencyKey: string,
  payload: {
    provider: 'simulated';
    validation: {
      runBuildIfPresent: boolean;
      runTestsIfPresent: boolean;
    };
    retry: {
      maxRetries: number;
    };
    rollbackOnFailure: boolean;
    provenance: {
      trigger: string;
      taskId: string | null;
      operationId: string | null;
      note: string | null;
    };
  }
): Promise<WorkspaceDeploymentCreateResponse> {
  const response = await fetch(`${workerUrl}/api/workspaces/${workspaceId}/deploy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<WorkspaceDeploymentCreateResponse>;
}

export async function getWorkspaceDeployment(
  workerUrl: string,
  workspaceId: string,
  deploymentId: string
): Promise<WorkspaceDeploymentGetResponse> {
  const response = await fetch(`${workerUrl}/api/workspaces/${workspaceId}/deployments/${deploymentId}`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }
  return response.json() as Promise<WorkspaceDeploymentGetResponse>;
}
