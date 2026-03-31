import type {
  WorkspaceCreateResponse,
  WorkspaceDiffResponse,
  WorkspaceFileListResponse,
  WorkspaceFileResponse,
  WorkspaceResponse,
} from '../../lib/types.js';
import { throwWorkerError, workerFetch } from './shared.js';

export async function createWorkspace(workerUrl: string, formData: FormData): Promise<WorkspaceCreateResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/workspaces`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<WorkspaceCreateResponse>;
}

export async function getWorkspace(workerUrl: string, workspaceId: string): Promise<WorkspaceResponse> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/workspaces/${workspaceId}`);

  if (!response.ok) {
    await throwWorkerError(response, `Workspace not found: ${workspaceId}`);
  }

  return response.json() as Promise<WorkspaceResponse>;
}

export async function deleteWorkspace(workerUrl: string, workspaceId: string): Promise<{ status: string }> {
  const response = await workerFetch(workerUrl, `${workerUrl}/api/workspaces/${workspaceId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    await throwWorkerError(response, `Workspace not found: ${workspaceId}`);
  }

  return response.json() as Promise<{ status: string }>;
}

export async function listWorkspaceFiles(
  workerUrl: string,
  workspaceId: string,
  path?: string
): Promise<WorkspaceFileListResponse> {
  const url = new URL(`${workerUrl}/api/workspaces/${workspaceId}/files`);
  if (path) {
    url.searchParams.set('path', path);
  }

  const response = await workerFetch(workerUrl, url.toString());
  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<WorkspaceFileListResponse>;
}

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

  const response = await workerFetch(workerUrl, url.toString());
  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<WorkspaceFileResponse>;
}

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

  const response = await workerFetch(workerUrl, url.toString());
  if (!response.ok) {
    await throwWorkerError(response);
  }

  return response.json() as Promise<WorkspaceDiffResponse>;
}
