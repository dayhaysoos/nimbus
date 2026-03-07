import type {
  JobRecord,
  JobResponse,
  JobListItem,
  JobStatus,
  JobPhase,
  WorkspaceRecord,
  WorkspaceResponse,
  WorkspaceStatus,
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
export function generateJobId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `job_${id}`;
}

/**
 * Generate a unique workspace ID
 */
export function generateWorkspaceId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `ws_${id}`;
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
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    deletedAt: record.deleted_at,
    eventsUrl: `/api/workspaces/${record.id}/events`,
  };
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
export async function markWorkspaceReady(db: D1Database, id: string): Promise<boolean> {
  return updateWorkspaceStatus(
    db,
    id,
    'ready',
    {
      baseline_ready: 1,
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
