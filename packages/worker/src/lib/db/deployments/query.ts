import type { WorkspaceDeploymentResponse } from '../../../types.js';
import { toWorkspaceDeploymentResponse, WorkspaceDeploymentIdempotencyConflictError } from './shared.js';

export async function getWorkspaceDeployment(
  db: D1Database,
  workspaceId: string,
  deploymentId: string
): Promise<WorkspaceDeploymentResponse | null> {
  const record = await db
    .prepare('SELECT * FROM workspace_deployments WHERE id = ? AND workspace_id = ?')
    .bind(deploymentId, workspaceId)
    .first();
  if (!record) return null;
  return toWorkspaceDeploymentResponse(record as never);
}

export async function getWorkspaceDeploymentRequestPayload(
  db: D1Database,
  deploymentId: string
): Promise<Record<string, unknown> | null> {
  const record = await db
    .prepare('SELECT request_payload_json FROM workspace_deployments WHERE id = ?')
    .bind(deploymentId)
    .first<{ request_payload_json: string }>();
  if (!record) return null;
  const parsed = JSON.parse(record.request_payload_json || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

export async function getWorkspaceDeploymentByIdempotency(
  db: D1Database,
  workspaceId: string,
  idempotencyKey: string,
  requestPayloadSha256: string,
  requestPayloadSha256Aliases?: string[]
): Promise<WorkspaceDeploymentResponse | null> {
  const now = new Date().toISOString();
  const acceptedHashes = new Set([requestPayloadSha256, ...(requestPayloadSha256Aliases ?? [])]);
  const existingIdempotency = await db
    .prepare(
      `SELECT deployment_id, request_payload_sha256, expires_at
       FROM workspace_deployment_idempotency
       WHERE workspace_id = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(workspaceId, idempotencyKey)
    .first<{ deployment_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (!acceptedHashes.has(existingIdempotency.request_payload_sha256)) {
      throw new WorkspaceDeploymentIdempotencyConflictError(idempotencyKey);
    }
    const deployment = await getWorkspaceDeployment(db, workspaceId, existingIdempotency.deployment_id);
    if (!deployment) throw new Error(`Idempotency record references missing deployment ${existingIdempotency.deployment_id}`);
    return deployment;
  }

  const idempotencyWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingDeployment = await db
    .prepare(
      `SELECT * FROM workspace_deployments
       WHERE workspace_id = ?
         AND idempotency_key = ?
         AND julianday(created_at) >= julianday(?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(workspaceId, idempotencyKey, idempotencyWindowStart)
    .first();
  if (!existingDeployment) return null;
  if (!acceptedHashes.has((existingDeployment as any).request_payload_sha256)) {
    throw new WorkspaceDeploymentIdempotencyConflictError(idempotencyKey);
  }
  return toWorkspaceDeploymentResponse(existingDeployment as never);
}
