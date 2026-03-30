import type {
  WorkspaceDeploymentRecord,
  WorkspaceDeploymentRemediation,
  WorkspaceDeploymentResponse,
  WorkspaceDeploymentStatus,
  WorkspaceToolchainProfile,
} from '../../../types.js';

export interface WorkspaceDeploymentEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface WorkspaceDeploymentEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export function parseJsonOrFallback<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}_${id}`;
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint failed/i.test(error.message);
}

export class WorkspaceDeploymentIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Deployment idempotency key conflict: ${key}`);
    this.name = 'WorkspaceDeploymentIdempotencyConflictError';
  }
}

export function toWorkspaceDeploymentResponse(record: WorkspaceDeploymentRecord): WorkspaceDeploymentResponse {
  const provenance = parseJsonOrFallback<Record<string, unknown>>(record.provenance_json, {});
  const result = parseJsonOrFallback<unknown>(record.result_json, undefined);
  const toolchain = parseJsonOrFallback<WorkspaceToolchainProfile | null>(record.toolchain_json, null);
  const remediations = parseJsonOrFallback<WorkspaceDeploymentRemediation[]>(record.remediations_json, []);

  const response: WorkspaceDeploymentResponse = {
    id: record.id,
    workspaceId: record.workspace_id,
    status: record.status,
    provider: record.provider,
    idempotencyKey: record.idempotency_key,
    maxRetries: record.max_retries,
    attemptCount: record.attempt_count,
    sourceSnapshotSha256: record.source_snapshot_sha256,
    sourceBundleKey: record.source_bundle_key,
    deployedUrl: record.deployed_url,
    providerDeploymentId: record.provider_deployment_id,
    cancelRequestedAt: record.cancel_requested_at,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    provenance,
    toolchain,
    dependencyCacheKey: record.dependency_cache_key,
    dependencyCacheHit: Boolean(record.dependency_cache_hit),
    remediations,
  };

  if (result !== undefined) response.result = result;
  if (record.error_code && record.error_message) {
    response.error = { code: record.error_code, message: record.error_message };
  }
  return response;
}
