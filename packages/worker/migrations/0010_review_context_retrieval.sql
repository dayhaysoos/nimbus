-- Migration: 0010_review_context_retrieval.sql
-- Description: add review context blob references and co-change cache for phase 1 retrieval

CREATE TABLE IF NOT EXISTS review_context_blobs (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (review_id) REFERENCES review_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (deployment_id) REFERENCES workspace_deployments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_context_blobs_review
    ON review_context_blobs(review_id);

CREATE TABLE IF NOT EXISTS review_cochange_cache (
    file_path TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    cochange_json TEXT NOT NULL,
    lookback_sessions INTEGER NOT NULL,
    last_updated TEXT NOT NULL,
    PRIMARY KEY (file_path, repo)
);

CREATE INDEX IF NOT EXISTS idx_review_cochange_cache_updated
    ON review_cochange_cache(last_updated);
