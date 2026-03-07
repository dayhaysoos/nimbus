-- Migration: 0004_workspace_foundation.sql
-- Description: add workspace lifecycle and event tables for sandbox-first flow

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'creating',

    source_type TEXT NOT NULL DEFAULT 'checkpoint',
    checkpoint_id TEXT,
    commit_sha TEXT NOT NULL,
    source_ref TEXT,
    source_project_root TEXT,

    source_bundle_key TEXT NOT NULL,
    source_bundle_sha256 TEXT NOT NULL,
    source_bundle_bytes INTEGER NOT NULL,

    sandbox_id TEXT NOT NULL,
    baseline_ready INTEGER NOT NULL DEFAULT 0,

    error_code TEXT,
    error_message TEXT,

    last_event_seq INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT,

    CHECK (status IN ('creating', 'ready', 'failed', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_workspaces_status_created_at ON workspaces(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_checkpoint_id_created_at ON workspaces(checkpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_commit_sha_created_at ON workspaces(commit_sha, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    UNIQUE (workspace_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_workspace_events_workspace_seq ON workspace_events(workspace_id, seq);
