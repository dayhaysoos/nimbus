-- Migration: 0008_workspace_toolchain_parity.sql
-- Description: add toolchain parity metadata and dependency cache table for workspace deploys

ALTER TABLE workspace_deployments ADD COLUMN toolchain_json TEXT;
ALTER TABLE workspace_deployments ADD COLUMN dependency_cache_key TEXT;
ALTER TABLE workspace_deployments ADD COLUMN dependency_cache_hit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspace_deployments ADD COLUMN remediations_json TEXT;

CREATE TABLE IF NOT EXISTS workspace_dependency_caches (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    manager TEXT NOT NULL,
    manager_version TEXT,
    project_root TEXT NOT NULL,
    lockfile_name TEXT,
    lockfile_sha256 TEXT,
    artifact_key TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    artifact_bytes INTEGER NOT NULL,
    last_used_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    UNIQUE(workspace_id, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_dependency_caches_workspace_last_used
    ON workspace_dependency_caches(workspace_id, last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_dependency_caches_lockfile
    ON workspace_dependency_caches(workspace_id, lockfile_sha256);
