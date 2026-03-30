import type {
  WorkspaceDeploymentRecord,
  WorkspaceDeploymentRemediation,
  WorkspaceDeploymentResponse,
  WorkspaceDeploymentStatus,
  WorkspaceToolchainProfile,
} from '../../types.js';

interface WorkspaceDeploymentEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface WorkspaceDeploymentEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

function parseJsonOrFallback<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique constraint failed/i.test(error.message);
}

export class WorkspaceDeploymentIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Deployment idempotency key conflict: ${key}`);
    this.name = 'WorkspaceDeploymentIdempotencyConflictError';
  }
}

function toWorkspaceDeploymentResponse(record: WorkspaceDeploymentRecord): WorkspaceDeploymentResponse {
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

  if (result !== undefined) {
    response.result = result;
  }

  if (record.error_code && record.error_message) {
    response.error = {
      code: record.error_code,
      message: record.error_message,
    };
  }

  return response;
}

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
): Promise<{ deployment: WorkspaceDeploymentResponse; reused: boolean }> {
  const now = new Date().toISOString();
  const acceptedHashes = new Set([input.requestPayloadSha256, ...(input.requestPayloadSha256Aliases ?? [])]);
  const existingIdempotency = await db
    .prepare(
      `SELECT deployment_id, request_payload_sha256, expires_at
       FROM workspace_deployment_idempotency
       WHERE workspace_id = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.idempotencyKey)
    .first<{ deployment_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (!acceptedHashes.has(existingIdempotency.request_payload_sha256)) {
      throw new WorkspaceDeploymentIdempotencyConflictError(input.idempotencyKey);
    }

    const existingDeployment = await getWorkspaceDeployment(db, input.workspaceId, existingIdempotency.deployment_id);
    if (!existingDeployment) {
      throw new Error(`Idempotency record references missing deployment ${existingIdempotency.deployment_id}`);
    }

    return { deployment: existingDeployment, reused: true };
  }

  if (existingIdempotency && existingIdempotency.expires_at <= now) {
    await db
      .prepare('DELETE FROM workspace_deployment_idempotency WHERE workspace_id = ? AND idempotency_key = ?')
      .bind(input.workspaceId, input.idempotencyKey)
      .run();
  }

  const idempotencyWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const existingDeploymentByKey = await db
    .prepare(
      `SELECT *
       FROM workspace_deployments
       WHERE workspace_id = ?
         AND idempotency_key = ?
         AND julianday(created_at) >= julianday(?)
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(input.workspaceId, input.idempotencyKey, idempotencyWindowStart)
    .first<WorkspaceDeploymentRecord>();

  if (existingDeploymentByKey) {
    if (!acceptedHashes.has(existingDeploymentByKey.request_payload_sha256)) {
      throw new WorkspaceDeploymentIdempotencyConflictError(input.idempotencyKey);
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    try {
      await db
        .prepare(
          `INSERT INTO workspace_deployment_idempotency (
             id,
             workspace_id,
             idempotency_key,
             deployment_id,
             request_payload_sha256,
             expires_at
           )
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          generatePrefixedId('wdep'),
          input.workspaceId,
          input.idempotencyKey,
          existingDeploymentByKey.id,
          input.requestPayloadSha256,
          expiresAt
        )
        .run();
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
    }

    return { deployment: toWorkspaceDeploymentResponse(existingDeploymentByKey), reused: true };
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const deploymentRecord = await db
    .prepare(
      `INSERT INTO workspace_deployments (
         id,
         workspace_id,
         status,
         provider,
         idempotency_key,
         request_payload_json,
         request_payload_sha256,
         max_retries,
         provenance_json,
         created_at,
         updated_at
       )
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.provider,
      input.idempotencyKey,
      JSON.stringify(input.requestPayload ?? {}),
      input.requestPayloadSha256,
      input.maxRetries,
      JSON.stringify(input.provenance ?? {}),
      now,
      now
    )
    .first<WorkspaceDeploymentRecord>();

  if (!deploymentRecord) {
    throw new Error('Failed to create workspace deployment');
  }

  try {
    await db
      .prepare(
        `INSERT INTO workspace_deployment_idempotency (
           id,
           workspace_id,
           idempotency_key,
           deployment_id,
           request_payload_sha256,
           expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        generatePrefixedId('wdep'),
        input.workspaceId,
        input.idempotencyKey,
        input.id,
        input.requestPayloadSha256,
        expiresAt
      )
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      await db.prepare('DELETE FROM workspace_deployments WHERE id = ?').bind(input.id).run();
      throw error;
    }

    const concurrent = await db
      .prepare(
        `SELECT deployment_id, request_payload_sha256, expires_at
         FROM workspace_deployment_idempotency
         WHERE workspace_id = ? AND idempotency_key = ?
         LIMIT 1`
      )
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

    const existingDeployment = await getWorkspaceDeployment(db, input.workspaceId, concurrent.deployment_id);
    if (!existingDeployment) {
      await db.prepare('DELETE FROM workspace_deployments WHERE id = ?').bind(input.id).run();
      throw new Error(`Idempotency record references missing deployment ${concurrent.deployment_id}`);
    }

    await db.prepare('DELETE FROM workspace_deployments WHERE id = ?').bind(input.id).run();
    return { deployment: existingDeployment, reused: true };
  }

  return { deployment: toWorkspaceDeploymentResponse(deploymentRecord), reused: false };
}

export async function getWorkspaceDeployment(
  db: D1Database,
  workspaceId: string,
  deploymentId: string
): Promise<WorkspaceDeploymentResponse | null> {
  const record = await db
    .prepare('SELECT * FROM workspace_deployments WHERE id = ? AND workspace_id = ?')
    .bind(deploymentId, workspaceId)
    .first<WorkspaceDeploymentRecord>();

  if (!record) {
    return null;
  }

  return toWorkspaceDeploymentResponse(record);
}

export async function getWorkspaceDeploymentRequestPayload(
  db: D1Database,
  deploymentId: string
): Promise<Record<string, unknown> | null> {
  const record = await db
    .prepare('SELECT request_payload_json FROM workspace_deployments WHERE id = ?')
    .bind(deploymentId)
    .first<{ request_payload_json: string }>();

  if (!record) {
    return null;
  }

  const parsed = parseJsonOrFallback<unknown>(record.request_payload_json, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export async function claimWorkspaceDeploymentForExecution(
  db: D1Database,
  workspaceId: string,
  deploymentId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE workspace_deployments
       SET status = 'running',
           started_at = COALESCE(started_at, ?),
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued' AND cancel_requested_at IS NULL`
    )
    .bind(now, now, deploymentId, workspaceId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function updateWorkspaceDeploymentStatus(
  db: D1Database,
  deploymentId: string,
  status: WorkspaceDeploymentStatus,
  options?: {
    workspaceId?: string;
    result?: unknown;
    toolchain?: WorkspaceToolchainProfile | null;
    dependencyCacheKey?: string | null;
    dependencyCacheHit?: boolean;
    remediations?: WorkspaceDeploymentRemediation[];
    errorCode?: string | null;
    errorMessage?: string | null;
    sourceSnapshotSha256?: string | null;
    sourceBundleKey?: string | null;
    deployedUrl?: string | null;
    providerDeploymentId?: string | null;
    cancelRequestedAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }
): Promise<void> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: Array<string | number | null> = [status, new Date().toISOString()];
  let explicitFinishedAt: string | null | undefined;

  if (options?.startedAt !== undefined) {
    updates.push('started_at = ?');
    values.push(options.startedAt);
  }
  if (options?.finishedAt !== undefined) {
    updates.push('finished_at = ?');
    values.push(options.finishedAt);
    explicitFinishedAt = options.finishedAt;
  }
  if (options?.result !== undefined) {
    updates.push('result_json = ?');
    values.push(JSON.stringify(options.result));
  }
  if (options?.toolchain !== undefined) {
    updates.push('toolchain_json = ?');
    values.push(options.toolchain ? JSON.stringify(options.toolchain) : null);
  }
  if (options?.dependencyCacheKey !== undefined) {
    updates.push('dependency_cache_key = ?');
    values.push(options.dependencyCacheKey);
  }
  if (options?.dependencyCacheHit !== undefined) {
    updates.push('dependency_cache_hit = ?');
    values.push(options.dependencyCacheHit ? 1 : 0);
  }
  if (options?.remediations !== undefined) {
    updates.push('remediations_json = ?');
    values.push(JSON.stringify(options.remediations));
  }
  if (options?.errorCode !== undefined) {
    updates.push('error_code = ?');
    values.push(options.errorCode);
  }
  if (options?.errorMessage !== undefined) {
    updates.push('error_message = ?');
    values.push(options.errorMessage);
  }
  if (options?.sourceSnapshotSha256 !== undefined) {
    updates.push('source_snapshot_sha256 = ?');
    values.push(options.sourceSnapshotSha256);
  }
  if (options?.sourceBundleKey !== undefined) {
    updates.push('source_bundle_key = ?');
    values.push(options.sourceBundleKey);
  }
  if (options?.deployedUrl !== undefined) {
    updates.push('deployed_url = ?');
    values.push(options.deployedUrl);
  }
  if (options?.providerDeploymentId !== undefined) {
    updates.push('provider_deployment_id = ?');
    values.push(options.providerDeploymentId);
  }
  if (options?.cancelRequestedAt !== undefined) {
    updates.push('cancel_requested_at = ?');
    values.push(options.cancelRequestedAt);
  }

  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    const finishedAtForDuration =
      explicitFinishedAt && typeof explicitFinishedAt === 'string' ? explicitFinishedAt : new Date().toISOString();
    if (explicitFinishedAt === undefined) {
      updates.push('finished_at = COALESCE(finished_at, ?)');
      values.push(finishedAtForDuration);
    }
    updates.push('duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) END');
    values.push(finishedAtForDuration);
  }

  values.push(deploymentId);
  let whereClause = 'id = ?';
  if (options?.workspaceId) {
    whereClause += ' AND workspace_id = ?';
    values.push(options.workspaceId);
  }
  if (status === 'running') {
    whereClause += " AND status IN ('queued', 'running')";
  }

  await db
    .prepare(`UPDATE workspace_deployments SET ${updates.join(', ')} WHERE ${whereClause}`)
    .bind(...values)
    .run();
}

export async function markWorkspaceDeploymentSucceededIfNotCancelled(
  db: D1Database,
  input: {
    workspaceId: string;
    deploymentId: string;
    sourceSnapshotSha256: string;
    sourceBundleKey: string;
    deployedUrl: string | null;
    providerDeploymentId: string;
    result: unknown;
    finishedAt: string;
  }
): Promise<boolean> {
  const updatedAt = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE workspace_deployments
       SET status = 'succeeded',
           source_snapshot_sha256 = ?,
           source_bundle_key = ?,
           deployed_url = ?,
           provider_deployment_id = ?,
           result_json = ?,
           error_code = NULL,
           error_message = NULL,
           finished_at = ?,
           duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER) END,
           updated_at = ?
       WHERE id = ?
         AND workspace_id = ?
         AND status = 'running'
         AND cancel_requested_at IS NULL`
    )
    .bind(
      input.sourceSnapshotSha256,
      input.sourceBundleKey,
      input.deployedUrl,
      input.providerDeploymentId,
      JSON.stringify(input.result),
      input.finishedAt,
      input.finishedAt,
      updatedAt,
      input.deploymentId,
      input.workspaceId
    )
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function requestWorkspaceDeploymentCancel(
  db: D1Database,
  workspaceId: string,
  deploymentId: string
): Promise<{ deployment: WorkspaceDeploymentResponse | null; updated: boolean }> {
  const now = new Date().toISOString();
  const queuedResult = await db
    .prepare(
      `UPDATE workspace_deployments
       SET status = 'cancelled',
           cancel_requested_at = COALESCE(cancel_requested_at, ?),
           finished_at = COALESCE(finished_at, ?),
           error_code = NULL,
           error_message = NULL,
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued'`
    )
    .bind(now, now, now, deploymentId, workspaceId)
    .run();

  const runningResult = await db
    .prepare(
      `UPDATE workspace_deployments
       SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'running' AND cancel_requested_at IS NULL`
    )
    .bind(now, now, deploymentId, workspaceId)
    .run();

  const deployment = await getWorkspaceDeployment(db, workspaceId, deploymentId);

  return {
    deployment,
    updated: (queuedResult.meta?.changes ?? 0) > 0 || (runningResult.meta?.changes ?? 0) > 0,
  };
}

export async function appendWorkspaceDeploymentEvent(
  db: D1Database,
  input: {
    workspaceId: string;
    deploymentId: string;
    eventType: string;
    payload: unknown;
  }
): Promise<number> {
  const seqResult = await db
    .prepare(
      'UPDATE workspace_deployments SET last_event_seq = last_event_seq + 1 WHERE id = ? AND workspace_id = ? RETURNING last_event_seq'
    )
    .bind(input.deploymentId, input.workspaceId)
    .first<{ last_event_seq: number }>();

  if (!seqResult) {
    throw new Error(`Failed to allocate event sequence for workspace deployment ${input.deploymentId}`);
  }

  const seq = Number(seqResult.last_event_seq);
  await db
    .prepare(
      `INSERT INTO workspace_deployment_events (workspace_id, deployment_id, seq, event_type, payload_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(input.workspaceId, input.deploymentId, seq, input.eventType, JSON.stringify(input.payload))
    .run();

  return seq;
}

export async function listWorkspaceDeploymentEvents(
  db: D1Database,
  workspaceId: string,
  deploymentId: string,
  fromExclusive = 0,
  limit = 500
): Promise<WorkspaceDeploymentEventItem[]> {
  const result = await db
    .prepare(
      `SELECT seq, event_type, payload_json, created_at
       FROM workspace_deployment_events
       WHERE workspace_id = ? AND deployment_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .bind(workspaceId, deploymentId, fromExclusive, limit)
    .all<WorkspaceDeploymentEventRecord>();

  return result.results.map((row) => ({
    seq: row.seq,
    eventType: row.event_type,
    payload: parseJsonOrFallback(row.payload_json, { raw: row.payload_json }),
    createdAt: row.created_at,
  }));
}

export async function hasWorkspaceDeploymentEvent(
  db: D1Database,
  workspaceId: string,
  deploymentId: string,
  eventType: string
): Promise<boolean> {
  const record = await db
    .prepare(
      `SELECT 1
       FROM workspace_deployment_events
       WHERE workspace_id = ? AND deployment_id = ? AND event_type = ?
       LIMIT 1`
    )
    .bind(workspaceId, deploymentId, eventType)
    .first<{ '1': number }>();

  return Boolean(record);
}
