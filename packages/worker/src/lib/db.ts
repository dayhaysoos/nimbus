import type {
  JobRecord,
  JobResponse,
  JobListItem,
  JobStatus,
  JobPhase,
  WorkspaceRecord,
  WorkspaceResponse,
  WorkspaceStatus,
  WorkspaceOperationRecord,
  WorkspaceOperationResponse,
  WorkspaceOperationType,
  WorkspaceOperationStatus,
  WorkspaceArtifactRecord,
  WorkspaceArtifactResponse,
  WorkspaceArtifactType,
  WorkspaceArtifactStatus,
  WorkspaceTaskRecord,
  WorkspaceTaskResponse,
  WorkspaceTaskStatus,
  WorkspaceDeploymentRecord,
  WorkspaceDeploymentRemediation,
  WorkspaceDeploymentResponse,
  WorkspaceDeploymentStatus,
  WorkspacePackageManager,
  WorkspaceToolchainProfile,
} from '../types.js';

export interface CreateCheckpointJobInput {
  id: string;
  prompt: string;
  checkpointId: string | null;
  commitSha: string;
  sourceRef?: string;
  sourceProjectRoot?: string;
  buildRunTestsIfPresent: boolean;
  buildRunLintIfPresent: boolean;
  sourceBundleKey: string;
  sourceBundleSha256: string;
  sourceBundleBytes: number;
}

export interface JobEventRecord {
  id: number;
  job_id: string;
  attempt_no: number;
  seq: number;
  event_type: string;
  phase: JobPhase;
  payload_json: string;
  created_at: string;
}

export interface JobEventItem {
  seq: number;
  eventType: string;
  phase: JobPhase;
  payload: unknown;
  createdAt: string;
}

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

export interface CreateWorkspaceInput {
  id: string;
  sourceType: 'checkpoint';
  checkpointId: string | null;
  commitSha: string;
  sourceRef?: string;
  sourceProjectRoot?: string;
  sourceBundleKey: string;
  sourceBundleSha256: string;
  sourceBundleBytes: number;
  sandboxId: string;
}

export interface CreateWorkspaceOperationInput {
  id: string;
  workspaceId: string;
  type: WorkspaceOperationType;
  idempotencyKey: string;
  requestPayload: unknown;
  requestPayloadSha256: string;
  actorId?: string | null;
  authPrincipal?: Record<string, unknown>;
}

export interface CreateWorkspaceArtifactInput {
  id: string;
  workspaceId: string;
  operationId?: string | null;
  type: WorkspaceArtifactType;
  objectKey: string;
  bytes: number;
  contentType: string;
  sha256: string;
  sourceBaselineSha: string;
  creatorId?: string | null;
  retentionExpiresAt: string;
  warnings?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface CreateWorkspaceTaskInput {
  id: string;
  workspaceId: string;
  prompt: string;
  provider: string;
  model: string;
  idempotencyKey: string;
  requestPayload: unknown;
  requestPayloadSha256: string;
  maxSteps: number;
  maxRetries: number;
  actorId?: string | null;
  toolPolicy?: Record<string, unknown>;
}

export interface CreateWorkspaceDeploymentInput {
  id: string;
  workspaceId: string;
  provider: string;
  idempotencyKey: string;
  requestPayload: unknown;
  requestPayloadSha256: string;
  maxRetries: number;
  provenance?: Record<string, unknown>;
}

export interface WorkspaceTaskEventRecord {
  seq: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface WorkspaceTaskEventItem {
  seq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

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

export interface WorkspaceDependencyCacheRecord {
  id: string;
  workspace_id: string;
  cache_key: string;
  manager: WorkspacePackageManager;
  manager_version: string | null;
  project_root: string;
  lockfile_name: string | null;
  lockfile_sha256: string | null;
  artifact_key: string;
  artifact_sha256: string;
  artifact_bytes: number;
  last_used_at: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceDependencyCacheResponse {
  id: string;
  workspaceId: string;
  cacheKey: string;
  manager: WorkspacePackageManager;
  managerVersion: string | null;
  projectRoot: string;
  lockfileName: string | null;
  lockfileSha256: string | null;
  artifactKey: string;
  artifactSha256: string;
  artifactBytes: number;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

function toWorkspaceDependencyCacheResponse(record: WorkspaceDependencyCacheRecord): WorkspaceDependencyCacheResponse {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    cacheKey: record.cache_key,
    manager: record.manager,
    managerVersion: record.manager_version,
    projectRoot: record.project_root,
    lockfileName: record.lockfile_name,
    lockfileSha256: record.lockfile_sha256,
    artifactKey: record.artifact_key,
    artifactSha256: record.artifact_sha256,
    artifactBytes: record.artifact_bytes,
    lastUsedAt: record.last_used_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export class WorkspaceIdempotencyConflictError extends Error {
  constructor(
    public readonly key: string,
    public readonly type: WorkspaceOperationType
  ) {
    super(`Idempotency key conflict for ${type}: ${key}`);
    this.name = 'WorkspaceIdempotencyConflictError';
  }
}

export class WorkspaceTaskIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Task idempotency key conflict: ${key}`);
    this.name = 'WorkspaceTaskIdempotencyConflictError';
  }
}

export class WorkspaceDeploymentIdempotencyConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Deployment idempotency key conflict: ${key}`);
    this.name = 'WorkspaceDeploymentIdempotencyConflictError';
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unique constraint failed/i.test(error.message);
}

function phaseFromStatus(status: JobStatus): JobPhase {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'building';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

/**
 * Generate a unique job ID
 */
function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
}

/**
 * Generate a unique job ID
 */
export function generateJobId(): string {
  return generatePrefixedId('job');
}

/**
 * Generate a unique workspace ID
 */
export function generateWorkspaceId(): string {
  return generatePrefixedId('ws');
}

export function generateWorkspaceOperationId(): string {
  return generatePrefixedId('op');
}

export function generateWorkspaceArtifactId(): string {
  return generatePrefixedId('art');
}

export function generateWorkspaceTaskId(): string {
  return generatePrefixedId('task');
}

export function generateWorkspaceDeploymentId(): string {
  return generatePrefixedId('dep');
}

/**
 * Convert snake_case DB record to camelCase API response
 */
function toJobResponse(record: JobRecord): JobResponse {
  const phase = record.phase ?? phaseFromStatus(record.status);

  return {
    id: record.id,
    prompt: record.prompt,
    model: record.model,
    status: record.status,
    phase,
    createdAt: record.created_at,
    startedAt: record.started_at,
    completedAt: record.completed_at,
    cancelRequestedAt: record.cancel_requested_at,
    cancelledAt: record.cancelled_at,
    previewUrl: record.preview_url,
    deployedUrl: record.deployed_url,
    codeUrl: record.code_url,
    codeZipUrl: record.code_zip_url,
    errorMessage: record.error_message,
    errorCode: record.error_code,
    fileCount: record.file_count,
    currentAttempt: record.current_attempt,
    retryCount: record.retry_count,
    sourceType: record.source_type ?? null,
    checkpointId: record.checkpoint_id ?? null,
    commitSha: record.commit_sha ?? null,
    sourceRef: record.source_ref ?? null,
    sourceProjectRoot: record.source_project_root ?? null,
    buildRunTestsIfPresent:
      record.build_run_tests_if_present === null || record.build_run_tests_if_present === undefined
        ? null
        : Boolean(record.build_run_tests_if_present),
    buildRunLintIfPresent:
      record.build_run_lint_if_present === null || record.build_run_lint_if_present === undefined
        ? null
        : Boolean(record.build_run_lint_if_present),
    sourceBundleKey: record.source_bundle_key ?? null,
    sourceBundleSha256: record.source_bundle_sha256 ?? null,
    sourceBundleBytes: record.source_bundle_bytes ?? null,
  };
}

/**
 * Convert record to lightweight list item
 */
function toJobListItem(record: JobRecord): JobListItem {
  return {
    id: record.id,
    prompt: record.prompt.length > 100 ? record.prompt.slice(0, 100) + '...' : record.prompt,
    model: record.model,
    status: record.status,
    phase: record.phase,
    createdAt: record.created_at,
    deployedUrl: record.deployed_url,
  };
}

function toWorkspaceResponse(record: WorkspaceRecord): WorkspaceResponse {
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

function parseJsonOrFallback(value: string | null, fallback: unknown): unknown {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toWorkspaceOperationResponse(record: WorkspaceOperationRecord): WorkspaceOperationResponse {
  const warnings = parseJsonOrFallback(record.warnings_json, []);
  const result = parseJsonOrFallback(record.result_json, undefined);
  const errorDetails = parseJsonOrFallback(record.error_details_json, undefined);

  const response: WorkspaceOperationResponse = {
    id: record.id,
    type: record.type,
    status: record.status,
    workspaceId: record.workspace_id,
    idempotencyKey: record.idempotency_key,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };

  if (result !== undefined) {
    response.result = result;
  }
  if (Array.isArray(warnings) && warnings.length > 0) {
    response.warnings = warnings;
  }
  if (record.error_code && record.error_message) {
    response.error = {
      code: record.error_code,
      message: record.error_message,
      details: errorDetails,
    };
  }

  return response;
}

function toWorkspaceArtifactResponse(record: WorkspaceArtifactRecord): WorkspaceArtifactResponse {
  const warnings = parseJsonOrFallback(record.warnings_json, []);
  const metadata = parseJsonOrFallback(record.metadata_json, {});

  return {
    id: record.id,
    type: record.type,
    status: record.status,
    bytes: record.bytes,
    contentType: record.content_type,
    sha256: record.sha256,
    workspaceId: record.workspace_id,
    sourceBaselineSha: record.source_baseline_sha,
    creatorId: record.creator_id,
    createdAt: record.created_at,
    expiresAt: record.retention_expires_at,
    warnings: Array.isArray(warnings) ? warnings : [],
    metadata,
  };
}

function toWorkspaceTaskResponse(record: WorkspaceTaskRecord): WorkspaceTaskResponse {
  const result = parseJsonOrFallback(record.result_json, undefined);

  const response: WorkspaceTaskResponse = {
    id: record.id,
    workspaceId: record.workspace_id,
    status: record.status,
    prompt: record.prompt,
    provider: record.provider,
    model: record.model,
    idempotencyKey: record.idempotency_key,
    maxSteps: record.max_steps,
    maxRetries: record.max_retries,
    attemptCount: record.attempt_count,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
    cancelRequestedAt: record.cancel_requested_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
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

function toWorkspaceDeploymentResponse(record: WorkspaceDeploymentRecord): WorkspaceDeploymentResponse {
  const provenance = parseJsonOrFallback(record.provenance_json, {});
  const result = parseJsonOrFallback(record.result_json, undefined);
  const toolchain = parseJsonOrFallback(record.toolchain_json, null);
  const remediations = parseJsonOrFallback(record.remediations_json, []);

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
    provenance: (provenance as Record<string, unknown>) ?? {},
    toolchain: (toolchain as WorkspaceToolchainProfile | null) ?? null,
    dependencyCacheKey: record.dependency_cache_key,
    dependencyCacheHit: Boolean(record.dependency_cache_hit),
    remediations: Array.isArray(remediations) ? (remediations as WorkspaceDeploymentRemediation[]) : [],
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

/**
 * Create a new checkpoint job in the database
 */
export async function createCheckpointJob(
  db: D1Database,
  input: CreateCheckpointJobInput
): Promise<JobResponse> {
  const result = await db
    .prepare(
      `INSERT INTO jobs (
         id,
         prompt,
         model,
         status,
         phase,
         source_type,
         checkpoint_id,
         commit_sha,
         source_ref,
         source_project_root,
         build_run_tests_if_present,
         build_run_lint_if_present,
         source_bundle_key,
         source_bundle_sha256,
         source_bundle_bytes
       )
       VALUES (?, ?, 'checkpoint', 'queued', 'queued', 'checkpoint', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.prompt,
      input.checkpointId,
      input.commitSha,
      input.sourceRef ?? null,
      input.sourceProjectRoot ?? null,
      input.buildRunTestsIfPresent ? 1 : 0,
      input.buildRunLintIfPresent ? 1 : 0,
      input.sourceBundleKey,
      input.sourceBundleSha256,
      input.sourceBundleBytes
    )
    .first<JobRecord>();

  if (!result) {
    throw new Error('Failed to create checkpoint job');
  }

  return toJobResponse(result);
}

/**
 * Get a job by ID
 */
export async function getJob(db: D1Database, id: string): Promise<JobResponse | null> {
  const result = await db
    .prepare('SELECT * FROM jobs WHERE id = ?')
    .bind(id)
    .first<JobRecord>();

  if (!result) {
    return null;
  }

  return toJobResponse(result);
}

/**
 * List all jobs, most recent first
 */
export async function listJobs(db: D1Database, limit = 50): Promise<JobListItem[]> {
  const result = await db
    .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<JobRecord>();

  return result.results.map(toJobListItem);
}

/**
 * Delete a job by ID
 */
export async function deleteJob(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
}

/**
 * Atomically claim a queued checkpoint job for execution.
 * Returns true when claim succeeds, false when another worker already claimed.
 */
export async function claimQueuedCheckpointJob(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE jobs
       SET status = 'running',
           phase = 'building',
           started_at = ?,
           error_message = NULL,
           error_code = NULL
       WHERE id = ? AND status = 'queued'`
    )
    .bind(new Date().toISOString(), id)
    .run();

  const changes = Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
  return changes > 0;
}

/**
 * Append a sequenced job event and return its sequence number.
 */
export async function appendJobEvent(
  db: D1Database,
  input: {
    jobId: string;
    attemptNo?: number;
    eventType: string;
    phase: JobPhase;
    payload: unknown;
  }
): Promise<number> {
  const sequenceResult = await db
    .prepare('UPDATE jobs SET last_event_seq = last_event_seq + 1 WHERE id = ? RETURNING last_event_seq')
    .bind(input.jobId)
    .first<{ last_event_seq: number }>();

  if (!sequenceResult) {
    throw new Error(`Failed to allocate event sequence for job ${input.jobId}`);
  }

  const seq = Number(sequenceResult.last_event_seq);
  await db
    .prepare(
      `INSERT INTO job_events (job_id, attempt_no, seq, event_type, phase, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.jobId,
      input.attemptNo ?? 0,
      seq,
      input.eventType,
      input.phase,
      JSON.stringify(input.payload)
    )
    .run();

  return seq;
}

/**
 * List persisted job events from a given sequence.
 */
export async function listJobEvents(
  db: D1Database,
  jobId: string,
  fromExclusive = 0,
  limit = 500
): Promise<JobEventItem[]> {
  const result = await db
    .prepare(
      `SELECT id, job_id, attempt_no, seq, event_type, phase, payload_json, created_at
       FROM job_events
       WHERE job_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .bind(jobId, fromExclusive, limit)
    .all<JobEventRecord>();

  return result.results.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = { raw: row.payload_json };
    }

    return {
      seq: row.seq,
      eventType: row.event_type,
      phase: row.phase,
      payload,
      createdAt: row.created_at,
    };
  });
}

/**
 * Update job status
 */
export async function updateJobStatus(
  db: D1Database,
  id: string,
  status: JobStatus,
  additionalFields?: {
    phase?: JobPhase;
    started_at?: string | null;
    completed_at?: string | null;
    cancel_requested_at?: string | null;
    cancelled_at?: string | null;
    preview_url?: string;
    deployed_url?: string;
    code_url?: string;
    code_zip_url?: string;
    error_message?: string | null;
    error_code?: string | null;
    retry_count?: number;
    file_count?: number;
    // Metrics fields
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    llm_latency_ms?: number;
    install_duration_ms?: number;
    build_duration_ms?: number;
    deploy_duration_ms?: number;
    total_duration_ms?: number;
    lines_of_code?: number;
  }
): Promise<void> {
  const updates: string[] = ['status = ?'];
  const values: (string | number | null)[] = [status];

  if (additionalFields) {
    if (additionalFields.phase !== undefined) {
      updates.push('phase = ?');
      values.push(additionalFields.phase);
    }
    if (additionalFields.started_at !== undefined) {
      updates.push('started_at = ?');
      values.push(additionalFields.started_at);
    }
    if (additionalFields.completed_at !== undefined) {
      updates.push('completed_at = ?');
      values.push(additionalFields.completed_at);
    }
    if (additionalFields.cancel_requested_at !== undefined) {
      updates.push('cancel_requested_at = ?');
      values.push(additionalFields.cancel_requested_at);
    }
    if (additionalFields.cancelled_at !== undefined) {
      updates.push('cancelled_at = ?');
      values.push(additionalFields.cancelled_at);
    }
    if (additionalFields.preview_url !== undefined) {
      updates.push('preview_url = ?');
      values.push(additionalFields.preview_url);
    }
    if (additionalFields.deployed_url !== undefined) {
      updates.push('deployed_url = ?');
      values.push(additionalFields.deployed_url);
    }
    if (additionalFields.code_url !== undefined) {
      updates.push('code_url = ?');
      values.push(additionalFields.code_url);
    }
    if (additionalFields.code_zip_url !== undefined) {
      updates.push('code_zip_url = ?');
      values.push(additionalFields.code_zip_url);
    }
    if (additionalFields.error_message !== undefined) {
      updates.push('error_message = ?');
      values.push(additionalFields.error_message);
    }
    if (additionalFields.error_code !== undefined) {
      updates.push('error_code = ?');
      values.push(additionalFields.error_code);
    }
    if (additionalFields.retry_count !== undefined) {
      updates.push('retry_count = ?');
      values.push(additionalFields.retry_count);
    }
    if (additionalFields.file_count !== undefined) {
      updates.push('file_count = ?');
      values.push(additionalFields.file_count);
    }
    // Metrics fields
    if (additionalFields.prompt_tokens !== undefined) {
      updates.push('prompt_tokens = ?');
      values.push(additionalFields.prompt_tokens);
    }
    if (additionalFields.completion_tokens !== undefined) {
      updates.push('completion_tokens = ?');
      values.push(additionalFields.completion_tokens);
    }
    if (additionalFields.total_tokens !== undefined) {
      updates.push('total_tokens = ?');
      values.push(additionalFields.total_tokens);
    }
    if (additionalFields.cost !== undefined) {
      updates.push('cost = ?');
      values.push(additionalFields.cost);
    }
    if (additionalFields.llm_latency_ms !== undefined) {
      updates.push('llm_latency_ms = ?');
      values.push(additionalFields.llm_latency_ms);
    }
    if (additionalFields.install_duration_ms !== undefined) {
      updates.push('install_duration_ms = ?');
      values.push(additionalFields.install_duration_ms);
    }
    if (additionalFields.build_duration_ms !== undefined) {
      updates.push('build_duration_ms = ?');
      values.push(additionalFields.build_duration_ms);
    }
    if (additionalFields.deploy_duration_ms !== undefined) {
      updates.push('deploy_duration_ms = ?');
      values.push(additionalFields.deploy_duration_ms);
    }
    if (additionalFields.total_duration_ms !== undefined) {
      updates.push('total_duration_ms = ?');
      values.push(additionalFields.total_duration_ms);
    }
    if (additionalFields.lines_of_code !== undefined) {
      updates.push('lines_of_code = ?');
      values.push(additionalFields.lines_of_code);
    }
  }

  values.push(id);

  await db
    .prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

/**
 * Mark job as cancelled
 */
export async function markJobCancelled(db: D1Database, id: string): Promise<void> {
  const now = new Date().toISOString();
  await updateJobStatus(db, id, 'cancelled', {
    phase: 'cancelled',
    cancel_requested_at: now,
    cancelled_at: now,
    completed_at: now,
  });
}

/**
 * Create a new workspace in creating state.
 */
export async function createWorkspace(
  db: D1Database,
  input: CreateWorkspaceInput
): Promise<WorkspaceResponse> {
  const result = await db
    .prepare(
      `INSERT INTO workspaces (
         id,
         status,
         source_type,
         checkpoint_id,
         commit_sha,
         source_ref,
         source_project_root,
         source_bundle_key,
         source_bundle_sha256,
         source_bundle_bytes,
         sandbox_id,
         baseline_ready
       )
       VALUES (?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       RETURNING *`
    )
    .bind(
      input.id,
      input.sourceType,
      input.checkpointId,
      input.commitSha,
      input.sourceRef ?? null,
      input.sourceProjectRoot ?? null,
      input.sourceBundleKey,
      input.sourceBundleSha256,
      input.sourceBundleBytes,
      input.sandboxId
    )
    .first<WorkspaceRecord>();

  if (!result) {
    throw new Error('Failed to create workspace');
  }

  return toWorkspaceResponse(result);
}

/**
 * Get workspace by ID.
 */
export async function getWorkspace(db: D1Database, id: string): Promise<WorkspaceResponse | null> {
  const result = await db.prepare('SELECT * FROM workspaces WHERE id = ?').bind(id).first<WorkspaceRecord>();

  if (!result) {
    return null;
  }

  return toWorkspaceResponse(result);
}

/**
 * Update workspace status and selected metadata.
 */
export async function updateWorkspaceStatus(
  db: D1Database,
  id: string,
  status: WorkspaceStatus,
  additionalFields?: {
    baseline_ready?: number;
    deleted_at?: string | null;
    error_code?: string | null;
    error_message?: string | null;
  },
  options?: {
    ifNotDeleted?: boolean;
  }
): Promise<boolean> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: (string | number | null)[] = [status, new Date().toISOString()];

  if (additionalFields) {
    if (additionalFields.baseline_ready !== undefined) {
      updates.push('baseline_ready = ?');
      values.push(additionalFields.baseline_ready);
    }
    if (additionalFields.deleted_at !== undefined) {
      updates.push('deleted_at = ?');
      values.push(additionalFields.deleted_at);
    }
    if (additionalFields.error_code !== undefined) {
      updates.push('error_code = ?');
      values.push(additionalFields.error_code);
    }
    if (additionalFields.error_message !== undefined) {
      updates.push('error_message = ?');
      values.push(additionalFields.error_message);
    }
  }

  values.push(id);

  let whereClause = 'id = ?';
  if (options?.ifNotDeleted) {
    whereClause += " AND status != 'deleted'";
  }

  const result = await db
    .prepare(`UPDATE workspaces SET ${updates.join(', ')} WHERE ${whereClause}`)
    .bind(...values)
    .run();

  return Number(result.meta.changes ?? 0) > 0;
}

/**
 * Mark workspace as ready.
 */
export async function markWorkspaceReady(db: D1Database, id: string, baselineReady = true): Promise<boolean> {
  return updateWorkspaceStatus(
    db,
    id,
    'ready',
    {
      baseline_ready: baselineReady ? 1 : 0,
      error_code: null,
      error_message: null,
    },
    { ifNotDeleted: true }
  );
}

/**
 * Mark workspace as failed.
 */
export async function markWorkspaceFailed(
  db: D1Database,
  id: string,
  message: string,
  errorCode: string | null = null
): Promise<boolean> {
  return updateWorkspaceStatus(
    db,
    id,
    'failed',
    {
      error_code: errorCode,
      error_message: message,
    },
    { ifNotDeleted: true }
  );
}

/**
 * Mark workspace as deleted.
 */
export async function markWorkspaceDeleted(db: D1Database, id: string): Promise<boolean> {
  return updateWorkspaceStatus(db, id, 'deleted', {
    deleted_at: new Date().toISOString(),
  });
}

/**
 * Append a sequenced workspace event and return sequence number.
 */
export async function appendWorkspaceEvent(
  db: D1Database,
  input: {
    workspaceId: string;
    eventType: string;
    payload: unknown;
  }
): Promise<number> {
  const sequenceResult = await db
    .prepare('UPDATE workspaces SET last_event_seq = last_event_seq + 1 WHERE id = ? RETURNING last_event_seq')
    .bind(input.workspaceId)
    .first<{ last_event_seq: number }>();

  if (!sequenceResult) {
    throw new Error(`Failed to allocate event sequence for workspace ${input.workspaceId}`);
  }

  const seq = Number(sequenceResult.last_event_seq);
  await db
    .prepare(
      `INSERT INTO workspace_events (workspace_id, seq, event_type, payload_json)
       VALUES (?, ?, ?, ?)`
    )
    .bind(input.workspaceId, seq, input.eventType, JSON.stringify(input.payload))
    .run();

  return seq;
}

/**
 * List persisted workspace events from a given sequence.
 */
export async function listWorkspaceEvents(
  db: D1Database,
  workspaceId: string,
  fromExclusive = 0,
  limit = 500
): Promise<WorkspaceEventItem[]> {
  const result = await db
    .prepare(
      `SELECT seq, event_type, payload_json, created_at
       FROM workspace_events
       WHERE workspace_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .bind(workspaceId, fromExclusive, limit)
    .all<WorkspaceEventRecord>();

  return result.results.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = { raw: row.payload_json };
    }

    return {
      seq: row.seq,
      eventType: row.event_type,
      payload,
      createdAt: row.created_at,
    };
  });
}

export async function createWorkspaceOperation(
  db: D1Database,
  input: CreateWorkspaceOperationInput
): Promise<{ operation: WorkspaceOperationResponse; reused: boolean }> {
  const now = new Date().toISOString();
  const existingIdempotency = await db
    .prepare(
      `SELECT operation_id, request_payload_sha256, expires_at
       FROM workspace_operation_idempotency
       WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.type, input.idempotencyKey)
    .first<{ operation_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (existingIdempotency.request_payload_sha256 !== input.requestPayloadSha256) {
      throw new WorkspaceIdempotencyConflictError(input.idempotencyKey, input.type);
    }

    const existingOperation = await getWorkspaceOperation(db, input.workspaceId, existingIdempotency.operation_id);
    if (!existingOperation) {
      throw new Error(`Idempotency record references missing operation ${existingIdempotency.operation_id}`);
    }
    return { operation: existingOperation, reused: true };
  }

  if (existingIdempotency && existingIdempotency.expires_at <= now) {
    await db
      .prepare(
        `DELETE FROM workspace_operation_idempotency
         WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?`
      )
      .bind(input.workspaceId, input.type, input.idempotencyKey)
      .run();
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const operationId = input.id;

  const operationRecord = await db
    .prepare(
      `INSERT INTO workspace_operations (
         id,
         workspace_id,
         type,
         status,
         actor_id,
         auth_principal_json,
         request_payload_json,
         request_payload_sha256,
         idempotency_key,
         warnings_json
       )
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, '[]')
       RETURNING *`
    )
    .bind(
      operationId,
      input.workspaceId,
      input.type,
      input.actorId ?? null,
      JSON.stringify(input.authPrincipal ?? {}),
      JSON.stringify(input.requestPayload ?? {}),
      input.requestPayloadSha256,
      input.idempotencyKey
    )
    .first<WorkspaceOperationRecord>();

  if (!operationRecord) {
    throw new Error('Failed to create workspace operation');
  }

  try {
    await db
      .prepare(
        `INSERT INTO workspace_operation_idempotency (
           id,
           workspace_id,
           operation_type,
           idempotency_key,
           operation_id,
           request_payload_sha256,
           expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        generatePrefixedId('wopk'),
        input.workspaceId,
        input.type,
        input.idempotencyKey,
        operationId,
        input.requestPayloadSha256,
        expiresAt
      )
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
      throw error;
    }

    const concurrentIdempotency = await db
      .prepare(
        `SELECT operation_id, request_payload_sha256, expires_at
         FROM workspace_operation_idempotency
         WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?
         LIMIT 1`
      )
      .bind(input.workspaceId, input.type, input.idempotencyKey)
      .first<{ operation_id: string; request_payload_sha256: string; expires_at: string }>();

    if (!concurrentIdempotency || concurrentIdempotency.expires_at <= now) {
      await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
      throw new Error('Idempotency race detected but winner record is unavailable');
    }
    if (concurrentIdempotency.request_payload_sha256 !== input.requestPayloadSha256) {
      await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
      throw new WorkspaceIdempotencyConflictError(input.idempotencyKey, input.type);
    }

    const existingOperation = await getWorkspaceOperation(db, input.workspaceId, concurrentIdempotency.operation_id);
    if (!existingOperation) {
      await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
      throw new Error(`Idempotency record references missing operation ${concurrentIdempotency.operation_id}`);
    }
    await db.prepare('DELETE FROM workspace_operations WHERE id = ?').bind(operationId).run();
    return { operation: existingOperation, reused: true };
  }

  return { operation: toWorkspaceOperationResponse(operationRecord), reused: false };
}

export async function getWorkspaceOperation(
  db: D1Database,
  workspaceId: string,
  operationId: string
): Promise<WorkspaceOperationResponse | null> {
  const result = await db
    .prepare('SELECT * FROM workspace_operations WHERE id = ? AND workspace_id = ?')
    .bind(operationId, workspaceId)
    .first<WorkspaceOperationRecord>();

  if (!result) {
    return null;
  }

  return toWorkspaceOperationResponse(result);
}

export async function claimWorkspaceOperationForExecution(
  db: D1Database,
  workspaceId: string,
  operationId: string
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE workspace_operations
       SET status = 'running',
           started_at = COALESCE(started_at, ?),
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued'`
    )
    .bind(startedAt, startedAt, operationId, workspaceId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function updateWorkspaceOperationStatus(
  db: D1Database,
  operationId: string,
  status: WorkspaceOperationStatus,
  options?: {
    result?: unknown;
    warnings?: unknown[];
    errorCode?: string | null;
    errorClass?: string | null;
    errorMessage?: string | null;
    errorDetails?: unknown;
    startedAt?: string | null;
    finishedAt?: string | null;
  }
): Promise<void> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: Array<string | number | null> = [status, new Date().toISOString()];

  if (options?.startedAt !== undefined) {
    updates.push('started_at = ?');
    values.push(options.startedAt);
  }
  if (options?.finishedAt !== undefined) {
    updates.push('finished_at = ?');
    values.push(options.finishedAt);
  }
  if (options?.result !== undefined) {
    updates.push('result_json = ?');
    values.push(JSON.stringify(options.result));
  }
  if (options?.warnings !== undefined) {
    updates.push('warnings_json = ?');
    values.push(JSON.stringify(options.warnings));
  }
  if (options?.errorCode !== undefined) {
    updates.push('error_code = ?');
    values.push(options.errorCode);
  }
  if (options?.errorClass !== undefined) {
    updates.push('error_class = ?');
    values.push(options.errorClass);
  }
  if (options?.errorMessage !== undefined) {
    updates.push('error_message = ?');
    values.push(options.errorMessage);
  }
  if (options?.errorDetails !== undefined) {
    updates.push('error_details_json = ?');
    values.push(JSON.stringify(options.errorDetails));
  }
  if (status === 'running') {
    updates.push('started_at = COALESCE(started_at, ?)');
    values.push(new Date().toISOString());
  }
  if (status === 'succeeded' || status === 'failed') {
    updates.push('finished_at = COALESCE(finished_at, ?)');
    values.push(new Date().toISOString());
    updates.push('duration_ms = CASE WHEN started_at IS NULL OR COALESCE(finished_at, ?) IS NULL THEN NULL ELSE CAST((julianday(COALESCE(finished_at, ?)) - julianday(started_at)) * 86400000 AS INTEGER) END');
    const finishedAtForDuration = new Date().toISOString();
    values.push(finishedAtForDuration, finishedAtForDuration);
  }

  values.push(operationId);

  await db
    .prepare(`UPDATE workspace_operations SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function createWorkspaceArtifact(
  db: D1Database,
  input: CreateWorkspaceArtifactInput
): Promise<WorkspaceArtifactResponse> {
  const result = await db
    .prepare(
      `INSERT INTO workspace_artifacts (
         id,
         workspace_id,
         operation_id,
         type,
         status,
         object_key,
         bytes,
         content_type,
         sha256,
         source_baseline_sha,
         creator_id,
         retention_expires_at,
         warnings_json,
         metadata_json
       )
       VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.operationId ?? null,
      input.type,
      input.objectKey,
      input.bytes,
      input.contentType,
      input.sha256,
      input.sourceBaselineSha,
      input.creatorId ?? null,
      input.retentionExpiresAt,
      JSON.stringify(input.warnings ?? []),
      JSON.stringify(input.metadata ?? {})
    )
    .first<WorkspaceArtifactRecord>();

  if (!result) {
    throw new Error('Failed to create workspace artifact');
  }

  return toWorkspaceArtifactResponse(result);
}

export async function listWorkspaceArtifacts(
  db: D1Database,
  workspaceId: string,
  limit = 50
): Promise<WorkspaceArtifactResponse[]> {
  const result = await db
    .prepare('SELECT * FROM workspace_artifacts WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
    .bind(workspaceId, limit)
    .all<WorkspaceArtifactRecord>();

  return result.results.map((record) => toWorkspaceArtifactResponse(record));
}

export interface WorkspaceArtifactLookup {
  artifact: WorkspaceArtifactResponse;
  objectKey: string;
  contentType: string;
  status: WorkspaceArtifactStatus;
  retentionExpiresAt: string;
}

export async function getWorkspaceArtifactById(
  db: D1Database,
  workspaceId: string,
  artifactId: string
): Promise<WorkspaceArtifactLookup | null> {
  const record = await db
    .prepare('SELECT * FROM workspace_artifacts WHERE id = ? AND workspace_id = ?')
    .bind(artifactId, workspaceId)
    .first<WorkspaceArtifactRecord>();

  if (!record) {
    return null;
  }

  return {
    artifact: toWorkspaceArtifactResponse(record),
    objectKey: record.object_key,
    contentType: record.content_type,
    status: record.status,
    retentionExpiresAt: record.retention_expires_at,
  };
}

export async function createWorkspaceTask(
  db: D1Database,
  input: CreateWorkspaceTaskInput
): Promise<{ task: WorkspaceTaskResponse; reused: boolean }> {
  const now = new Date().toISOString();
  const existingIdempotency = await db
    .prepare(
      `SELECT task_id, request_payload_sha256, expires_at
       FROM workspace_task_idempotency
       WHERE workspace_id = ? AND idempotency_key = ?
       LIMIT 1`
    )
    .bind(input.workspaceId, input.idempotencyKey)
    .first<{ task_id: string; request_payload_sha256: string; expires_at: string }>();

  if (existingIdempotency && existingIdempotency.expires_at > now) {
    if (existingIdempotency.request_payload_sha256 !== input.requestPayloadSha256) {
      throw new WorkspaceTaskIdempotencyConflictError(input.idempotencyKey);
    }

    const existingTask = await getWorkspaceTask(db, input.workspaceId, existingIdempotency.task_id);
    if (!existingTask) {
      throw new Error(`Idempotency record references missing task ${existingIdempotency.task_id}`);
    }

    return { task: existingTask, reused: true };
  }

  if (existingIdempotency && existingIdempotency.expires_at <= now) {
    await db
      .prepare('DELETE FROM workspace_task_idempotency WHERE workspace_id = ? AND idempotency_key = ?')
      .bind(input.workspaceId, input.idempotencyKey)
      .run();
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const taskRecord = await db
    .prepare(
      `INSERT INTO workspace_tasks (
         id,
         workspace_id,
         status,
         prompt,
         provider,
         model,
         idempotency_key,
         request_payload_json,
         request_payload_sha256,
         max_steps,
         max_retries,
         actor_id,
         tool_policy_json
       )
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.prompt,
      input.provider,
      input.model,
      input.idempotencyKey,
      JSON.stringify(input.requestPayload ?? {}),
      input.requestPayloadSha256,
      input.maxSteps,
      input.maxRetries,
      input.actorId ?? null,
      JSON.stringify(input.toolPolicy ?? {})
    )
    .first<WorkspaceTaskRecord>();

  if (!taskRecord) {
    throw new Error('Failed to create workspace task');
  }

  try {
    await db
      .prepare(
        `INSERT INTO workspace_task_idempotency (
           id,
           workspace_id,
           idempotency_key,
           task_id,
           request_payload_sha256,
           expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        generatePrefixedId('wtsk'),
        input.workspaceId,
        input.idempotencyKey,
        input.id,
        input.requestPayloadSha256,
        expiresAt
      )
      .run();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
      throw error;
    }

    const concurrent = await db
      .prepare(
        `SELECT task_id, request_payload_sha256, expires_at
         FROM workspace_task_idempotency
         WHERE workspace_id = ? AND idempotency_key = ?
         LIMIT 1`
      )
      .bind(input.workspaceId, input.idempotencyKey)
      .first<{ task_id: string; request_payload_sha256: string; expires_at: string }>();

    if (!concurrent || concurrent.expires_at <= now) {
      await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
      throw new Error('Task idempotency race detected but winner record is unavailable');
    }

    if (concurrent.request_payload_sha256 !== input.requestPayloadSha256) {
      await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
      throw new WorkspaceTaskIdempotencyConflictError(input.idempotencyKey);
    }

    const existingTask = await getWorkspaceTask(db, input.workspaceId, concurrent.task_id);
    if (!existingTask) {
      await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
      throw new Error(`Idempotency record references missing task ${concurrent.task_id}`);
    }

    await db.prepare('DELETE FROM workspace_tasks WHERE id = ?').bind(input.id).run();
    return { task: existingTask, reused: true };
  }

  return { task: toWorkspaceTaskResponse(taskRecord), reused: false };
}

export async function getWorkspaceTask(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<WorkspaceTaskResponse | null> {
  const record = await db
    .prepare('SELECT * FROM workspace_tasks WHERE id = ? AND workspace_id = ?')
    .bind(taskId, workspaceId)
    .first<WorkspaceTaskRecord>();

  if (!record) {
    return null;
  }

  return toWorkspaceTaskResponse(record);
}

export async function getWorkspaceTaskRequestPayload(
  db: D1Database,
  taskId: string
): Promise<Record<string, unknown> | null> {
  const record = await db
    .prepare('SELECT request_payload_json FROM workspace_tasks WHERE id = ?')
    .bind(taskId)
    .first<{ request_payload_json: string }>();

  if (!record) {
    return null;
  }

  try {
    const parsed = JSON.parse(record.request_payload_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function getWorkspaceTaskToolPolicy(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<Record<string, unknown> | null> {
  const record = await db
    .prepare('SELECT tool_policy_json FROM workspace_tasks WHERE id = ? AND workspace_id = ?')
    .bind(taskId, workspaceId)
    .first<{ tool_policy_json: string }>();

  if (!record) {
    return null;
  }

  try {
    const parsed = JSON.parse(record.tool_policy_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function claimWorkspaceTaskForExecution(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE workspace_tasks
       SET status = 'running',
           started_at = COALESCE(started_at, ?),
           attempt_count = attempt_count + 1,
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued' AND cancel_requested_at IS NULL`
    )
    .bind(now, now, taskId, workspaceId)
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function updateWorkspaceTaskStatus(
  db: D1Database,
  taskId: string,
  status: WorkspaceTaskStatus,
  options?: {
    workspaceId?: string;
    result?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }
): Promise<void> {
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: Array<string | null> = [status, new Date().toISOString()];

  if (options?.startedAt !== undefined) {
    updates.push('started_at = ?');
    values.push(options.startedAt);
  }

  if (options?.finishedAt !== undefined) {
    updates.push('finished_at = ?');
    values.push(options.finishedAt);
  }

  if (options?.result !== undefined) {
    updates.push('result_json = ?');
    values.push(JSON.stringify(options.result));
  }

  if (options?.errorCode !== undefined) {
    updates.push('error_code = ?');
    values.push(options.errorCode);
  }

  if (options?.errorMessage !== undefined) {
    updates.push('error_message = ?');
    values.push(options.errorMessage);
  }

  if (status === 'succeeded' || status === 'failed' || status === 'cancelled') {
    updates.push('finished_at = COALESCE(finished_at, ?)');
    values.push(new Date().toISOString());
  }

  values.push(taskId);
  let whereClause = 'id = ?';
  if (options?.workspaceId) {
    whereClause += ' AND workspace_id = ?';
    values.push(options.workspaceId);
  }

  await db
    .prepare(`UPDATE workspace_tasks SET ${updates.join(', ')} WHERE ${whereClause}`)
    .bind(...values)
    .run();
}

export async function requestWorkspaceTaskCancel(
  db: D1Database,
  workspaceId: string,
  taskId: string
): Promise<{ task: WorkspaceTaskResponse | null; updated: boolean }> {
  const now = new Date().toISOString();
  const queuedResult = await db
    .prepare(
      `UPDATE workspace_tasks
       SET status = 'cancelled',
           cancel_requested_at = COALESCE(cancel_requested_at, ?),
           finished_at = COALESCE(finished_at, ?),
           error_code = NULL,
           error_message = NULL,
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'queued'`
    )
    .bind(now, now, now, taskId, workspaceId)
    .run();

  const runningResult = await db
    .prepare(
      `UPDATE workspace_tasks
       SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
           updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'running' AND cancel_requested_at IS NULL`
    )
    .bind(now, now, taskId, workspaceId)
    .run();

  const task = await getWorkspaceTask(db, workspaceId, taskId);
  return {
    task,
    updated: (queuedResult.meta?.changes ?? 0) > 0 || (runningResult.meta?.changes ?? 0) > 0,
  };
}

export async function appendWorkspaceTaskEvent(
  db: D1Database,
  input: {
    workspaceId: string;
    taskId: string;
    eventType: string;
    payload: unknown;
  }
): Promise<number> {
  const seqResult = await db
    .prepare(
      'UPDATE workspace_tasks SET last_event_seq = last_event_seq + 1 WHERE id = ? AND workspace_id = ? RETURNING last_event_seq'
    )
    .bind(input.taskId, input.workspaceId)
    .first<{ last_event_seq: number }>();

  if (!seqResult) {
    throw new Error(`Failed to allocate event sequence for workspace task ${input.taskId}`);
  }

  const seq = Number(seqResult.last_event_seq);

  await db
    .prepare(
      `INSERT INTO workspace_task_events (workspace_id, task_id, seq, event_type, payload_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(input.workspaceId, input.taskId, seq, input.eventType, JSON.stringify(input.payload))
    .run();

  return seq;
}

export async function listWorkspaceTaskEvents(
  db: D1Database,
  workspaceId: string,
  taskId: string,
  fromExclusive = 0,
  limit = 500
): Promise<WorkspaceTaskEventItem[]> {
  const result = await db
    .prepare(
      `SELECT seq, event_type, payload_json, created_at
       FROM workspace_task_events
       WHERE workspace_id = ? AND task_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .bind(workspaceId, taskId, fromExclusive, limit)
    .all<WorkspaceTaskEventRecord>();

  return result.results.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = { raw: row.payload_json };
    }

    return {
      seq: row.seq,
      eventType: row.event_type,
      payload,
      createdAt: row.created_at,
    };
  });
}

export async function hasWorkspaceTaskEvent(
  db: D1Database,
  workspaceId: string,
  taskId: string,
  eventType: string
): Promise<boolean> {
  const record = await db
    .prepare(
      `SELECT 1
       FROM workspace_task_events
       WHERE workspace_id = ? AND task_id = ? AND event_type = ?
       LIMIT 1`
    )
    .bind(workspaceId, taskId, eventType)
    .first<{ '1': number }>();

  return Boolean(record);
}

export async function createWorkspaceDeployment(
  db: D1Database,
  input: CreateWorkspaceDeploymentInput
): Promise<{ deployment: WorkspaceDeploymentResponse; reused: boolean }> {
  const now = new Date().toISOString();
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
    if (existingIdempotency.request_payload_sha256 !== input.requestPayloadSha256) {
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
    if (existingDeploymentByKey.request_payload_sha256 !== input.requestPayloadSha256) {
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

    if (concurrent.request_payload_sha256 !== input.requestPayloadSha256) {
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

  try {
    const parsed = JSON.parse(record.request_payload_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
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

  return result.results.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = { raw: row.payload_json };
    }

    return {
      seq: row.seq,
      eventType: row.event_type,
      payload,
      createdAt: row.created_at,
    };
  });
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

export async function getLatestSuccessfulWorkspaceDeployment(
  db: D1Database,
  workspaceId: string
): Promise<WorkspaceDeploymentResponse | null> {
  const record = await db
    .prepare(
      `SELECT *
       FROM workspace_deployments
       WHERE workspace_id = ? AND status = 'succeeded'
       ORDER BY julianday(created_at) DESC, rowid DESC
       LIMIT 1`
    )
    .bind(workspaceId)
    .first<WorkspaceDeploymentRecord>();

  if (!record) {
    return null;
  }

  return toWorkspaceDeploymentResponse(record);
}

export async function getWorkspaceDependencyCache(
  db: D1Database,
  workspaceId: string,
  cacheKey: string
): Promise<WorkspaceDependencyCacheResponse | null> {
  const record = await db
    .prepare(
      `SELECT *
       FROM workspace_dependency_caches
       WHERE workspace_id = ? AND cache_key = ?
       LIMIT 1`
    )
    .bind(workspaceId, cacheKey)
    .first<WorkspaceDependencyCacheRecord>();

  if (!record) {
    return null;
  }

  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE workspace_dependency_caches
       SET last_used_at = ?,
           updated_at = ?
       WHERE workspace_id = ? AND cache_key = ?`
    )
    .bind(now, now, workspaceId, cacheKey)
    .run();

  return toWorkspaceDependencyCacheResponse({
    ...record,
    last_used_at: now,
    updated_at: now,
  });
}

export async function upsertWorkspaceDependencyCache(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    cacheKey: string;
    manager: WorkspacePackageManager;
    managerVersion: string | null;
    projectRoot: string;
    lockfileName: string | null;
    lockfileSha256: string | null;
    artifactKey: string;
    artifactSha256: string;
    artifactBytes: number;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO workspace_dependency_caches (
         id,
         workspace_id,
         cache_key,
         manager,
         manager_version,
         project_root,
         lockfile_name,
         lockfile_sha256,
         artifact_key,
         artifact_sha256,
         artifact_bytes,
         last_used_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, cache_key)
       DO UPDATE SET
         manager = excluded.manager,
         manager_version = excluded.manager_version,
         project_root = excluded.project_root,
         lockfile_name = excluded.lockfile_name,
         lockfile_sha256 = excluded.lockfile_sha256,
         artifact_key = excluded.artifact_key,
         artifact_sha256 = excluded.artifact_sha256,
         artifact_bytes = excluded.artifact_bytes,
         last_used_at = excluded.last_used_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      input.id,
      input.workspaceId,
      input.cacheKey,
      input.manager,
      input.managerVersion,
      input.projectRoot,
      input.lockfileName,
      input.lockfileSha256,
      input.artifactKey,
      input.artifactSha256,
      input.artifactBytes,
      now,
      now,
      now
    )
    .run();
}

export async function updateWorkspaceDeploymentSummary(
  db: D1Database,
  workspaceId: string,
  input: {
    deploymentId: string;
    status: WorkspaceDeploymentStatus;
    deployedUrl?: string | null;
    deployedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }
): Promise<void> {
  const updates: string[] = [
    'last_deployment_id = ?',
    'last_deployment_status = ?',
    'last_deployment_error_code = ?',
    'last_deployment_error_message = ?',
    'updated_at = ?',
  ];
  const values: Array<string | null> = [
    input.deploymentId,
    input.status,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    new Date().toISOString(),
  ];

  if (input.deployedUrl !== undefined) {
    updates.push('last_deployed_url = ?');
    values.push(input.deployedUrl);
  }
  if (input.deployedAt !== undefined) {
    updates.push('last_deployed_at = ?');
    values.push(input.deployedAt);
  }

  values.push(workspaceId);
  values.push(input.deploymentId);
  await db
    .prepare(
      `UPDATE workspaces
       SET ${updates.join(', ')}
       WHERE id = ?
         AND EXISTS (
           SELECT 1
           FROM workspace_deployments candidate
           LEFT JOIN workspace_deployments current ON current.id = workspaces.last_deployment_id
           WHERE candidate.id = ?
             AND candidate.workspace_id = workspaces.id
             AND (
               workspaces.last_deployment_id IS NULL
               OR current.id IS NULL
               OR workspaces.last_deployment_id = candidate.id
               OR julianday(candidate.created_at) > julianday(current.created_at)
               OR (
                 julianday(candidate.created_at) = julianday(current.created_at)
                 AND (current.id IS NULL OR candidate.rowid >= current.rowid)
               )
             )
         )`
    )
    .bind(...values)
    .run();
}
