-- Migration: 0009_review_runs.sql
-- Description: add review-first report runs, findings, events, and idempotency tracking

CREATE TABLE IF NOT EXISTS review_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_payload_json TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    provenance_json TEXT NOT NULL DEFAULT '{}',
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    report_json TEXT,
    markdown_summary TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (deployment_id) REFERENCES workspace_deployments(id) ON DELETE CASCADE,
    CHECK (target_type IN ('workspace_deployment')),
    CHECK (mode IN ('report_only')),
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_review_runs_workspace_created
    ON review_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_runs_deployment_created
    ON review_runs(deployment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_runs_status_created
    ON review_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS review_run_idempotency (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    review_id TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (review_id) REFERENCES review_runs(id) ON DELETE CASCADE,
    UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_review_run_idempotency_expires
    ON review_run_idempotency(expires_at);

CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    confidence TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    conditions TEXT,
    locations_json TEXT NOT NULL DEFAULT '[]',
    suggested_fix_json TEXT,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (review_id) REFERENCES review_runs(id) ON DELETE CASCADE,
    CHECK (severity IN ('critical', 'high', 'medium', 'low')),
    CHECK (confidence IN ('high', 'medium', 'low'))
);

CREATE INDEX IF NOT EXISTS idx_review_findings_review_created
    ON review_findings(review_id, created_at ASC);

CREATE TABLE IF NOT EXISTS review_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (review_id) REFERENCES review_runs(id) ON DELETE CASCADE,
    UNIQUE (review_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_review_events_review_seq
    ON review_events(review_id, seq ASC);
