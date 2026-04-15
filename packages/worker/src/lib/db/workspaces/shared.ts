import type { WorkspaceDeploymentStatus, WorkspaceRecord, WorkspaceResponse } from '../../../types.js';

export interface WorkspaceEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface WorkspaceEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export class WorkspaceCreateIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Idempotency key conflict for workspace create: ${key}`);
    this.name = 'WorkspaceCreateIdempotencyConflictError';
  }
}

export class WorkspaceCreateInProgressError extends Error {
  constructor(public readonly key: string, public readonly workspaceId: string) {
    super(`Workspace create is still in progress for idempotency key: ${key}`);
    this.name = 'WorkspaceCreateInProgressError';
  }
}

export function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

export function generateWorkspaceId(): string {
  return generatePrefixedId('ws');
}

export function toWorkspaceResponse(record: WorkspaceRecord): WorkspaceResponse {
  return {
    id: record.id,
    status: record.status,
    sourceType: record.source_type,
    checkpointId: record.checkpoint_id,
    commitSha: record.commit_sha,
    sourceRef: record.source_ref,
    sourceProjectRoot: record.source_project_root,
    sourceBundleKey: record.source_bundle_key,
    sourceBundleSha256: record.source_bundle_sha256,
    sourceBundleBytes: record.source_bundle_bytes,
    sandboxId: record.sandbox_id,
    baselineReady: Boolean(record.baseline_ready),
    errorCode: record.error_code,
    errorMessage: record.error_message,
    lastDeploymentId: record.last_deployment_id ?? null,
    lastDeploymentStatus: (record.last_deployment_status as WorkspaceDeploymentStatus | null) ?? null,
    lastDeployedUrl: record.last_deployed_url ?? null,
    lastDeployedAt: record.last_deployed_at ?? null,
    lastDeploymentErrorCode: record.last_deployment_error_code ?? null,
    lastDeploymentErrorMessage: record.last_deployment_error_message ?? null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    deletedAt: record.deleted_at,
    eventsUrl: `/api/workspaces/${record.id}/events`,
  };
}
