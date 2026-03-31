import type { WorkspaceArtifactRecord, WorkspaceArtifactResponse, WorkspaceArtifactStatus } from '../../types.js';

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

function toWorkspaceArtifactResponse(record: WorkspaceArtifactRecord): WorkspaceArtifactResponse {
  const warnings = parseJsonOrFallback<unknown[]>(record.warnings_json, []);
  const metadata = parseJsonOrFallback<Record<string, unknown>>(record.metadata_json, {});

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

export interface WorkspaceArtifactLookup {
  artifact: WorkspaceArtifactResponse;
  objectKey: string;
  contentType: string;
  status: WorkspaceArtifactStatus;
  retentionExpiresAt: string;
}

export async function createWorkspaceArtifact(
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    operationId?: string | null;
    type: WorkspaceArtifactResponse['type'];
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
