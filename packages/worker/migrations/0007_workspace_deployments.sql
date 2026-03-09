-- Migration: 0007_workspace_deployments.sql
-- Description: add workspace deployment lifecycle, events, and workspace deployment summary metadata

ALTER TABLE workspaces ADD COLUMN last_deployment_id TEXT;
ALTER TABLE workspaces ADD COLUMN last_deployment_status TEXT;
ALTER TABLE workspaces ADD COLUMN last_deployed_url TEXT;
ALTER TABLE workspaces ADD COLUMN last_deployed_at TEXT;
ALTER TABLE workspaces ADD COLUMN last_deployment_error_code TEXT;
ALTER TABLE workspaces ADD COLUMN last_deployment_error_message TEXT;

CREATE TABLE IF NOT EXISTS workspace_deployments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_payload_json TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    max_retries INTEGER NOT NULL DEFAULT 2,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    source_snapshot_sha256 TEXT,
    source_bundle_key TEXT,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    provider_deployment_id TEXT,
    deployed_url TEXT,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    cancel_requested_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_deployments_workspace_created
    ON workspace_deployments(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_deployments_workspace_status_created
    ON workspace_deployments(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_deployment_idempotency (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (deployment_id) REFERENCES workspace_deployments(id) ON DELETE CASCADE,
    UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_deployment_idempotency_expires
    ON workspace_deployment_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS workspace_deployment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (deployment_id) REFERENCES workspace_deployments(id) ON DELETE CASCADE,
    UNIQUE (deployment_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_workspace_deployment_events_deployment_seq
    ON workspace_deployment_events(deployment_id, seq ASC);
