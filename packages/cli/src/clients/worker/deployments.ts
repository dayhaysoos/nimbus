import type {
  WorkspaceDeploymentCreateResponse,
  WorkspaceDeploymentGetResponse,
  WorkspaceDeploymentPreflightResponse,
} from '../../lib/types.js';
import { throwWorkerError, workerFetch } from './shared.js';

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
  const response = await workerFetch(workerUrl, `${workerUrl}/api/workspaces/${workspaceId}/deploy/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwWorkerError(response);
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
      repo: string;
      sessionIds?: string[];
      transcriptUrl?: string | null;
      intentSessionContext?: string[];
      rawSessionPrompts?: string | null;
      contextResolution?: 'direct' | 'branch_fallback';
      contextResolutionOriginalCheckpointId?: string;
      contextResolutionResolvedCheckpointId?: string;
      contextResolutionResolvedCommitSha?: string;
      contextResolutionResolvedCommitMessage?: string;
    };
  }
): Promise<WorkspaceDeploymentCreateResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/workspaces/${workspaceId}/deploy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<WorkspaceDeploymentCreateResponse>;
}

export async function getWorkspaceDeployment(
  workerUrl: string,
  workspaceId: string,
  deploymentId: string
): Promise<WorkspaceDeploymentGetResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/workspaces/${workspaceId}/deployments/${deploymentId}`);
  if (!response.ok) {
    await throwWorkerError(response);
  }
  return response.json() as Promise<WorkspaceDeploymentGetResponse>;
}
