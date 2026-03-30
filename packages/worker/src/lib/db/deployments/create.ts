import { getWorkspaceDeployment } from './query.js';
import { generatePrefixedId, isUniqueConstraintError, toWorkspaceDeploymentResponse, WorkspaceDeploymentIdempotencyConflictError } from './shared.js';

export async function createWorkspaceDeployment(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    provider: string;
    idempotencyKey: string;
    requestPayload: unknown;
    requestPayloadSha256: string;
    requestPayloadSha256Aliases?: string[];
    maxRetries: number;
    provenance?: Record<string, unknown>;
  }
): Promise<{ deployment: import('../../../types.js').WorkspaceDeploymentResponse; reused: boolean }> {
  const now = new Date().toISOString();
  const acceptedHashes = new Set([input.requestPayloadSha256, ...(input.requestPayloadSha256Aliases ?? [])]);
  const existingIdempotency = await db
    .prepare(`SELECT deployment_id, request_payload_sha256, expires_at FROM workspace_deployment_idempotency WHERE workspace_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(input.workspaceId, input.idempotencyKey)
    .first<{ deployment_id: string; request_payload_sha256: string; expires_at: string }>();
  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (!acceptedHashes.has(existingIdempotency.request_payload_sha256)) throw new WorkspaceDeploymentIdempotencyConflictError(input.idempotencyKey);
    const existing = await getWorkspaceDeployment(db, input.workspaceId, existingIdempotency.deployment_id);
    if (!existing) throw new Error(`Idempotency record references missing deployment ${existingIdempotency.deployment_id}`);
    return { deployment: existing, reused: true };
  }
  if (existingIdempotency && existingIdempotency.expires_at <= now) {
    await db.prepare('DELETE FROM workspace_deployment_idempotency WHERE workspace_id = ? AND idempotency_key = ?').bind(input.workspaceId, input.idempotencyKey).run();
  }

  const idempotencyWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingByKey = await db
    .prepare(`SELECT * FROM workspace_deployments WHERE workspace_id = ? AND idempotency_key = ? AND julianday(created_at) >= julianday(?) ORDER BY created_at DESC LIMIT 1`)
    .bind(input.workspaceId, input.idempotencyKey, idempotencyWindowStart)
    .first();
  if (existingByKey) {
    if (!acceptedHashes.has((existingByKey as any).request_payload_sha256)) throw new WorkspaceDeploymentIdempotencyConflictError(input.idempotencyKey);
    return { deployment: toWorkspaceDeploymentResponse(existingByKey as never), reused: true };
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const deploymentRecord = await db
    .prepare(
      `INSERT INTO workspace_deployments (
         id, workspace_id, status, provider, idempotency_key, request_payload_json, request_payload_sha256, max_retries, provenance_json, created_at, updated_at
       ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .bind(input.id, input.workspaceId, input.provider, input.idempotencyKey, JSON.stringify(input.requestPayload ?? {}), input.requestPayloadSha256, input.maxRetries, JSON.stringify(input.provenance ?? {}), now, now)
    .first();
  if (!deploymentRecord) throw new Error('Failed to create workspace deployment');

  try {
    await db
      .prepare(`INSERT INTO workspace_deployment_idempotency (id, workspace_id, idempotency_key, deployment_id, request_payload_sha256, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(generatePrefixedId('wdep'), input.workspaceId, input.idempotencyKey, input.id, input.requestPayloadSha256, expiresAt)
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      await db.prepare('DELETE FROM workspace_deployments WHERE id = ?').bind(input.id).run();
      throw error;
    }

    const concurrent = await db
      .prepare(`SELECT deployment_id, request_payload_sha256, expires_at FROM workspace_deployment_idempotency WHERE workspace_id = ? AND idempotency_key = ? LIMIT 1`)
      .bind(input.workspaceId, input.idempotencyKey)
      .first<{ deployment_id: string; request_payload_sha256: string; expires_at: string }>();
    if (!concurrent || concurrent.expires_at <= now) {
      await db.prepare('DELETE FROM workspace_deployments WHERE id = ?').bind(input.id).run();
      throw new Error('Deployment idempotency race detected but winner record is unavailable');
    }
    if (!acceptedHashes.has(concurrent.request_payload_sha256)) {
      await db.prepare('DELETE FROM workspace_deployments WHERE id = ?').bind(input.id).run();
      throw new WorkspaceDeploymentIdempotencyConflictError(input.idempotencyKey);
    }
    const existing = await getWorkspaceDeployment(db, input.workspaceId, concurrent.deployment_id);
    if (!existing) {
      await db.prepare('DELETE FROM workspace_deployments WHERE id = ?').bind(input.id).run();
      throw new Error(`Idempotency record references missing deployment ${concurrent.deployment_id}`);
    }
    await db.prepare('DELETE FROM workspace_deployments WHERE id = ?').bind(input.id).run();
    return { deployment: existing, reused: true };
  }

  return { deployment: toWorkspaceDeploymentResponse(deploymentRecord as never), reused: false };
}
