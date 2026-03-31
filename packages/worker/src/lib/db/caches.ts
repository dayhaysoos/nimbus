import type {
  ReviewContextRef,
  WorkspaceDeploymentRecord,
  WorkspaceDeploymentRemediation,
  WorkspaceDeploymentResponse,
  WorkspaceDeploymentStatus,
  WorkspacePackageManager,
  WorkspaceToolchainProfile,
} from '../../types.js';

interface ReviewCochangeCacheRecord {
  file_path: string;
  repo: string;
  branch: string;
  cochange_json: string;
  lookback_sessions: number;
  last_updated: string;
}

interface WorkspaceDependencyCacheRecord {
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

interface WorkspaceDependencyCacheResponse {
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

function generatePrefixedId(prefix: string, length = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}_${id}`;
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
    provenance,
    toolchain,
    dependencyCacheKey: record.dependency_cache_key,
    dependencyCacheHit: Boolean(record.dependency_cache_hit),
    remediations,
    startedAt: record.started_at,
    finishedAt: record.finished_at,
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

/**
 * Allocates a stable identifier for persisted review context stored outside D1.
 */
export function generateReviewContextId(): string {
  return generatePrefixedId('rctx', 10);
}

export async function createReviewContextBlobReference(
  db: D1Database,
  input: {
    id: string;
    reviewId: string;
    workspaceId: string;
    deploymentId: string;
    r2Key: string;
    byteSize: number;
    estimatedTokens: number;
  }
): Promise<ReviewContextRef> {
  const record = await db
    .prepare(
      `INSERT INTO review_context_blobs (
         id,
         review_id,
         workspace_id,
         deployment_id,
         r2_key,
         byte_size,
         estimated_tokens,
         created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, r2_key`
    )
    .bind(
      input.id,
      input.reviewId,
      input.workspaceId,
      input.deploymentId,
      input.r2Key,
      input.byteSize,
      input.estimatedTokens,
      new Date().toISOString()
    )
    .first<{ id: string; r2_key: string }>();

  if (!record) {
    throw new Error('Failed to create review context blob reference');
  }

  return {
    id: record.id,
    r2Key: record.r2_key,
  };
}

export async function getReviewContextBlobReference(db: D1Database, reviewId: string): Promise<ReviewContextRef | null> {
  const record = await db
    .prepare(
      `SELECT id, r2_key
       FROM review_context_blobs
       WHERE review_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(reviewId)
    .first<{ id: string; r2_key: string }>();

  if (!record) {
    return null;
  }

  return {
    id: record.id,
    r2Key: record.r2_key,
  };
}

export async function getReviewCochangeCache(
  db: D1Database,
  input: {
    filePath: string;
    repo: string;
  }
): Promise<{ cochange: Array<{ path: string; frequency: number; sessionIds: string[] }>; lastUpdated: string; lookbackSessions: number } | null> {
  const record = await db
    .prepare(
      `SELECT cochange_json, last_updated, lookback_sessions
       FROM review_cochange_cache
       WHERE file_path = ? AND repo = ?
       LIMIT 1`
    )
    .bind(input.filePath, input.repo)
    .first<{ cochange_json: string; last_updated: string; lookback_sessions: number }>();

  if (!record) {
    return null;
  }

  let cochange: Array<{ path: string; frequency: number; sessionIds: string[] }> = [];
  try {
    const parsed = JSON.parse(record.cochange_json) as unknown;
    if (Array.isArray(parsed)) {
      cochange = parsed.filter((item): item is { path: string; frequency: number; sessionIds: string[] } => {
        const entry = item as Record<string, unknown>;
        return typeof entry.path === 'string' && typeof entry.frequency === 'number' && Array.isArray(entry.sessionIds);
      });
    }
  } catch {
    cochange = [];
  }

  return {
    cochange,
    lastUpdated: record.last_updated,
    lookbackSessions: Number(record.lookback_sessions),
  };
}

/**
 * Reads cached co-change rows in chunks so large path sets do not exceed SQLite bind limits.
 */
export async function getReviewCochangeCacheBatch(
  db: D1Database,
  input: {
    repo: string;
    filePaths: string[];
  }
): Promise<Array<{ filePath: string; cochange: Array<{ path: string; frequency: number; sessionIds: string[] }>; lastUpdated: string; lookbackSessions: number }>> {
  const READ_CHUNK_SIZE = 20;
  const isBindLimitError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return /too many sql variables|sqlite_error/i.test(message);
  };
  const uniquePaths = Array.from(new Set(input.filePaths.map((value) => value.trim()).filter(Boolean)));
  if (uniquePaths.length === 0) {
    return [];
  }

  const output: Array<{ filePath: string; cochange: Array<{ path: string; frequency: number; sessionIds: string[] }>; lastUpdated: string; lookbackSessions: number }> = [];

  const queryChunk = async (chunk: string[]): Promise<Array<{ file_path: string; cochange_json: string; last_updated: string; lookback_sessions: number }>> => {
    const placeholders = chunk.map(() => '?').join(', ');
    try {
      const records = await db
        .prepare(
          `SELECT file_path, cochange_json, last_updated, lookback_sessions
           FROM review_cochange_cache
           WHERE repo = ? AND file_path IN (${placeholders})`
        )
        .bind(input.repo, ...chunk)
        .all<{ file_path: string; cochange_json: string; last_updated: string; lookback_sessions: number }>();
      return Array.isArray(records.results) ? records.results : [];
    } catch (error) {
      if (chunk.length > 1 && isBindLimitError(error)) {
        const midpoint = Math.ceil(chunk.length / 2);
        const left = await queryChunk(chunk.slice(0, midpoint));
        const right = await queryChunk(chunk.slice(midpoint));
        return [...left, ...right];
      }
      throw error;
    }
  };

  for (let index = 0; index < uniquePaths.length; index += READ_CHUNK_SIZE) {
    const chunk = uniquePaths.slice(index, index + READ_CHUNK_SIZE);
    const rows = await queryChunk(chunk);
    output.push(
      ...rows.map((record) => {
        let cochange: Array<{ path: string; frequency: number; sessionIds: string[] }> = [];
        try {
          const parsed = JSON.parse(record.cochange_json) as unknown;
          if (Array.isArray(parsed)) {
            cochange = parsed.filter((item): item is { path: string; frequency: number; sessionIds: string[] } => {
              const entry = item as Record<string, unknown>;
              return typeof entry.path === 'string' && typeof entry.frequency === 'number' && Array.isArray(entry.sessionIds);
            });
          }
        } catch {
          cochange = [];
        }

        return {
          filePath: record.file_path,
          cochange,
          lastUpdated: record.last_updated,
          lookbackSessions: Number(record.lookback_sessions),
        };
      })
    );
  }

  return output;
}

export async function upsertReviewCochangeCache(
  db: D1Database,
  input: {
    filePath: string;
    repo: string;
    branch: string;
    cochange: Array<{ path: string; frequency: number; sessionIds: string[] }>;
    lookbackSessions: number;
    lastUpdated?: string;
  }
): Promise<void> {
  const lastUpdated = input.lastUpdated ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO review_cochange_cache (file_path, repo, branch, cochange_json, lookback_sessions, last_updated)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path, repo) DO UPDATE SET
         branch = excluded.branch,
         cochange_json = excluded.cochange_json,
         lookback_sessions = excluded.lookback_sessions,
         last_updated = excluded.last_updated`
    )
    .bind(
      input.filePath,
      input.repo,
      input.branch,
      JSON.stringify(input.cochange),
      input.lookbackSessions,
      lastUpdated
    )
    .run();
}

/**
 * Bulk upserts co-change rows while recursively splitting batches that exceed SQLite bind limits.
 */
export async function upsertReviewCochangeCacheBatch(
  db: D1Database,
  input: Array<{
    filePath: string;
    repo: string;
    branch: string;
    cochange: Array<{ path: string; frequency: number; sessionIds: string[] }>;
    lookbackSessions: number;
    lastUpdated?: string;
  }>
): Promise<void> {
  const WRITE_CHUNK_SIZE = 20;
  const isBindLimitError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return /too many sql variables|sqlite_error/i.test(message);
  };
  if (input.length === 0) {
    return;
  }

  const executeChunk = async (
    chunk: Array<{
      filePath: string;
      repo: string;
      branch: string;
      cochange: Array<{ path: string; frequency: number; sessionIds: string[] }>;
      lookbackSessions: number;
      lastUpdated?: string;
    }>
  ): Promise<void> => {
    const valuesSql = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const bindings: Array<string | number> = [];
    for (const entry of chunk) {
      bindings.push(
        entry.filePath,
        entry.repo,
        entry.branch,
        JSON.stringify(entry.cochange),
        entry.lookbackSessions,
        entry.lastUpdated ?? new Date().toISOString()
      );
    }

    try {
      await db
        .prepare(
          `INSERT INTO review_cochange_cache (file_path, repo, branch, cochange_json, lookback_sessions, last_updated)
           VALUES ${valuesSql}
           ON CONFLICT(file_path, repo) DO UPDATE SET
             branch = excluded.branch,
             cochange_json = excluded.cochange_json,
             lookback_sessions = excluded.lookback_sessions,
             last_updated = excluded.last_updated`
        )
        .bind(...bindings)
        .run();
    } catch (error) {
      if (chunk.length > 1 && isBindLimitError(error)) {
        const midpoint = Math.ceil(chunk.length / 2);
        await executeChunk(chunk.slice(0, midpoint));
        await executeChunk(chunk.slice(midpoint));
        return;
      }
      throw error;
    }
  };

  for (let index = 0; index < input.length; index += WRITE_CHUNK_SIZE) {
    const chunk = input.slice(index, index + WRITE_CHUNK_SIZE);
    await executeChunk(chunk);
  }
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
