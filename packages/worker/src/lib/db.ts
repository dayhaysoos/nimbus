import type { JobRecord, JobResponse, JobListItem, JobStatus } from '../types';

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
 * Convert snake_case DB record to camelCase API response
 */
function toJobResponse(record: JobRecord): JobResponse {
  return {
    id: record.id,
    prompt: record.prompt,
    model: record.model,
    status: record.status,
    createdAt: record.created_at,
    startedAt: record.started_at,
    completedAt: record.completed_at,
    previewUrl: record.preview_url,
    deployedUrl: record.deployed_url,
    errorMessage: record.error_message,
    fileCount: record.file_count,
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
    createdAt: record.created_at,
    deployedUrl: record.deployed_url,
  };
}

/**
 * Create a new job in the database
 */
export async function createJob(
  db: D1Database,
  id: string,
  prompt: string,
  model: string
): Promise<JobResponse> {
  const result = await db
    .prepare(
      `INSERT INTO jobs (id, prompt, model, status)
       VALUES (?, ?, ?, 'pending')
       RETURNING *`
    )
    .bind(id, prompt, model)
    .first<JobRecord>();

  if (!result) {
    throw new Error('Failed to create job');
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
 * Update job status
 */
export async function updateJobStatus(
  db: D1Database,
  id: string,
  status: JobStatus,
  additionalFields?: {
    started_at?: string;
    completed_at?: string;
    preview_url?: string;
    deployed_url?: string;
    error_message?: string;
    file_count?: number;
  }
): Promise<void> {
  const updates: string[] = ['status = ?'];
  const values: (string | number)[] = [status];

  if (additionalFields) {
    if (additionalFields.started_at !== undefined) {
      updates.push('started_at = ?');
      values.push(additionalFields.started_at);
    }
    if (additionalFields.completed_at !== undefined) {
      updates.push('completed_at = ?');
      values.push(additionalFields.completed_at);
    }
    if (additionalFields.preview_url !== undefined) {
      updates.push('preview_url = ?');
      values.push(additionalFields.preview_url);
    }
    if (additionalFields.deployed_url !== undefined) {
      updates.push('deployed_url = ?');
      values.push(additionalFields.deployed_url);
    }
    if (additionalFields.error_message !== undefined) {
      updates.push('error_message = ?');
      values.push(additionalFields.error_message);
    }
    if (additionalFields.file_count !== undefined) {
      updates.push('file_count = ?');
      values.push(additionalFields.file_count);
    }
  }

  values.push(id);

  await db
    .prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

/**
 * Mark job as running
 */
export async function markJobRunning(db: D1Database, id: string): Promise<void> {
  await updateJobStatus(db, id, 'running', {
    started_at: new Date().toISOString(),
  });
}

/**
 * Mark job as completed with URLs
 */
export async function markJobCompleted(
  db: D1Database,
  id: string,
  previewUrl: string,
  deployedUrl: string,
  fileCount: number
): Promise<void> {
  await updateJobStatus(db, id, 'completed', {
    completed_at: new Date().toISOString(),
    preview_url: previewUrl,
    deployed_url: deployedUrl,
    file_count: fileCount,
  });
}

/**
 * Mark job as failed with error message
 */
export async function markJobFailed(
  db: D1Database,
  id: string,
  errorMessage: string,
  previewUrl?: string
): Promise<void> {
  await updateJobStatus(db, id, 'failed', {
    completed_at: new Date().toISOString(),
    error_message: errorMessage,
    preview_url: previewUrl,
  });
}
