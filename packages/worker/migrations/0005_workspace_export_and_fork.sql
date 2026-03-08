-- Migration: 0005_workspace_export_and_fork.sql
-- Description: add workspace export/fork operations, idempotency, and artifact metadata

CREATE TABLE IF NOT EXISTS workspace_operations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    actor_id TEXT,
    auth_principal_json TEXT NOT NULL,
    request_payload_json TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    result_json TEXT,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    error_code TEXT,
    error_class TEXT,
    error_message TEXT,
    error_details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CHECK (type IN ('export_zip', 'export_patch', 'fork_github')),
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_operations_workspace_created
    ON workspace_operations(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_operations_workspace_status_created
    ON workspace_operations(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_operations_type_created
    ON workspace_operations(type, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_operation_idempotency (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (operation_id) REFERENCES workspace_operations(id) ON DELETE CASCADE,
    UNIQUE (workspace_id, operation_type, idempotency_key),
    CHECK (operation_type IN ('export_zip', 'export_patch', 'fork_github'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_operation_idempotency_expires
    ON workspace_operation_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS workspace_artifacts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    operation_id TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    object_key TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    source_baseline_sha TEXT NOT NULL,
    creator_id TEXT,
    retention_expires_at TEXT NOT NULL,
    expired_at TEXT,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (operation_id) REFERENCES workspace_operations(id) ON DELETE SET NULL,
    CHECK (type IN ('zip', 'patch')),
    CHECK (status IN ('available', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_workspace_created
    ON workspace_artifacts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_workspace_status_expiry
    ON workspace_artifacts(workspace_id, status, retention_expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_operation
    ON workspace_artifacts(operation_id);
