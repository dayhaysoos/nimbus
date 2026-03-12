import type {
  JobResponse,
  JobsListResponse,
  CheckpointJobCreateResponse,
  ReviewCreateResponse,
  ReviewEventEnvelope,
  ReviewGetResponse,
  WorkspaceCreateResponse,
  WorkspaceDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileResponse,
  WorkspaceResponse,
  WorkspaceDeploymentCreateResponse,
  WorkspaceDeploymentGetResponse,
  WorkspaceDeploymentPreflightResponse,
  DeployReadinessResponse,
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
    provider?: 'simulated' | 'cloudflare_workers_assets';
    validation: {
      runBuildIfPresent: boolean;
      runTestsIfPresent: boolean;
    };
    autoFix?: {
      rehydrateBaseline?: boolean;
      bootstrapToolchain?: boolean;
    };
    deploy?: {
      outputDir?: string | null;
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
    provider?: 'simulated' | 'cloudflare_workers_assets';
    validation: {
      runBuildIfPresent: boolean;
      runTestsIfPresent: boolean;
    };
    autoFix?: {
      rehydrateBaseline?: boolean;
      bootstrapToolchain?: boolean;
    };
    toolchain?: {
      manager?: string | null;
      version?: string | null;
    };
    cache?: {
      dependencyCache?: boolean;
    };
    deploy?: {
      outputDir?: string | null;
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

export async function getDeployReadiness(workerUrl: string): Promise<DeployReadinessResponse> {
  const response = await fetch(`${workerUrl}/api/system/deploy-readiness`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }
  return response.json() as Promise<DeployReadinessResponse>;
}

export async function createReview(
  workerUrl: string,
  idempotencyKey: string,
  payload: {
    target: {
      type: 'workspace_deployment';
      workspaceId: string;
      deploymentId: string;
    };
    mode: 'report_only';
    policy?: {
      severityThreshold?: 'low' | 'medium' | 'high' | 'critical';
      maxFindings?: number;
      includeProvenance?: boolean;
      includeValidationEvidence?: boolean;
    };
  }
): Promise<ReviewCreateResponse> {
  const response = await fetch(`${workerUrl}/api/reviews`, {
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

  return response.json() as Promise<ReviewCreateResponse>;
}

export async function getReview(workerUrl: string, reviewId: string): Promise<ReviewGetResponse> {
  const response = await fetch(`${workerUrl}/api/reviews/${reviewId}`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<ReviewGetResponse>;
}

function parseSseChunk(chunk: string): ReviewEventEnvelope[] {
  const messages = chunk.split('\n\n');
  const events: ReviewEventEnvelope[] = [];

  for (const message of messages) {
    const trimmed = message.trim();
    if (!trimmed) {
      continue;
    }

    let id: string | null = null;
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('id:')) {
        id = line.slice(3).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) {
      continue;
    }

    const payload = dataLines.join('\n');
    try {
      events.push({
        id,
        data: JSON.parse(payload) as Record<string, unknown>,
      });
    } catch {
      for (const dataLine of dataLines) {
        events.push({
          id,
          data: JSON.parse(dataLine) as Record<string, unknown>,
        });
      }
    }
  }

  return events;
}

export async function streamReviewEvents(
  workerUrl: string,
  reviewId: string,
  onEvent: (event: ReviewEventEnvelope) => void | Promise<void>
): Promise<void> {
  const response = await fetch(`${workerUrl}/api/reviews/${reviewId}/events`, {
    headers: {
      Accept: 'text/event-stream',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Worker error (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    const bodyText = await response.text();
    for (const event of parseSseChunk(bodyText)) {
      await onEvent(event);
    }
    return;
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const event of parseSseChunk(part)) {
        await onEvent(event);
      }
    }
  }

  buffer += decoder.decode();
  for (const event of parseSseChunk(buffer)) {
    await onEvent(event);
  }
}
