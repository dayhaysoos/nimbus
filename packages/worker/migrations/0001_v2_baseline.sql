-- Migration: 0001_v2_baseline.sql
-- Description: Baseline schema for Nimbus V2 (fresh-start migration)

-- Fresh-start reset for pre-V2 schemas.
DROP TABLE IF EXISTS job_attempts;
DROP TABLE IF EXISTS job_events;
DROP TABLE IF EXISTS job_artifacts;
DROP TABLE IF EXISTS job_revisions;
DROP TABLE IF EXISTS job_idempotency;
DROP TABLE IF EXISTS runtime_flags;
DROP TABLE IF EXISTS jobs;

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'queued',
    phase TEXT NOT NULL DEFAULT 'queued',

    current_attempt INTEGER NOT NULL DEFAULT 0,
    current_revision_no INTEGER NOT NULL DEFAULT 0,

    max_attempts INTEGER NOT NULL DEFAULT 3,
    attempt_timeout_ms INTEGER NOT NULL DEFAULT 600000,
    total_timeout_ms INTEGER NOT NULL DEFAULT 1800000,

    workflow_instance_id TEXT,
    idempotency_key TEXT,
    request_hash TEXT,
    last_event_seq INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    cancel_requested_at TEXT,
    cancelled_at TEXT,

    preview_url TEXT,
    deployed_url TEXT,
    code_url TEXT,
    code_zip_url TEXT,

    error_code TEXT,
    error_message TEXT,

    file_count INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,

    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    cost REAL,
    llm_latency_ms INTEGER,
    install_duration_ms INTEGER,
    build_duration_ms INTEGER,
    lint_duration_ms INTEGER,
    test_duration_ms INTEGER,
    deploy_duration_ms INTEGER,
    smoke_duration_ms INTEGER,
    total_duration_ms INTEGER,
    lines_of_code INTEGER,
    artifact_bytes_total INTEGER NOT NULL DEFAULT 0,

    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    CHECK (phase IN ('queued', 'planning', 'generating', 'building', 'repairing', 'validating', 'deploying', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_phase_created_at ON jobs(phase, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_workflow_instance ON jobs(workflow_instance_id);

CREATE TABLE IF NOT EXISTS job_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    model TEXT NOT NULL,

    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    timeout_ms INTEGER NOT NULL,

    repair_count INTEGER NOT NULL DEFAULT 0,
    used_safe_install INTEGER NOT NULL DEFAULT 1,
    used_script_install_fallback INTEGER NOT NULL DEFAULT 0,

    error_code TEXT,
    error_message TEXT,

    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    cost REAL,
    llm_latency_ms INTEGER,
    install_duration_ms INTEGER,
    build_duration_ms INTEGER,
    lint_duration_ms INTEGER,
    test_duration_ms INTEGER,
    deploy_duration_ms INTEGER,
    smoke_duration_ms INTEGER,
    total_duration_ms INTEGER,

    files_generated INTEGER,
    lines_of_code INTEGER,
    artifact_bytes_total INTEGER NOT NULL DEFAULT 0,

    deployed_url TEXT,
    smoke_status_code INTEGER,

    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE (job_id, attempt_no),
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'timed_out')),
    CHECK (phase IN ('planning', 'generating', 'building', 'repairing', 'validating', 'deploying', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job_attempt ON job_attempts(job_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_job_attempts_job_status ON job_attempts(job_id, status);

CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    phase TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE (job_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_seq ON job_events(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_job_events_job_created ON job_events(job_id, created_at);

CREATE TABLE IF NOT EXISTS job_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    revision_no INTEGER,
    artifact_type TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE (job_id, r2_key)
);

CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_attempt ON job_artifacts(job_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_type ON job_artifacts(artifact_type);

CREATE TABLE IF NOT EXISTS job_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    revision_no INTEGER NOT NULL,
    attempt_no INTEGER NOT NULL,
    parent_revision_no INTEGER,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    manifest_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE (job_id, revision_no),
    CHECK (actor IN ('system', 'ai', 'human'))
);

CREATE INDEX IF NOT EXISTS idx_job_revisions_job_attempt ON job_revisions(job_id, attempt_no);

CREATE TABLE IF NOT EXISTS job_idempotency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    key_source TEXT NOT NULL,
    job_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,

    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE (idempotency_key, request_hash),
    CHECK (key_source IN ('header', 'body', 'both'))
);

CREATE INDEX IF NOT EXISTS idx_job_idempotency_expiry ON job_idempotency(expires_at);
CREATE INDEX IF NOT EXISTS idx_job_idempotency_key ON job_idempotency(idempotency_key);

CREATE TABLE IF NOT EXISTS runtime_flags (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT NOT NULL DEFAULT 'system'
);

INSERT OR REPLACE INTO runtime_flags (key, value, updated_by) VALUES
  ('v2_enabled', 'false', 'migration'),
  ('v2_code_browser_enabled', 'false', 'migration'),
  ('max_attempts', '3', 'migration'),
  ('attempt_timeout_ms', '600000', 'migration'),
  ('total_timeout_ms', '1800000', 'migration'),
  ('idempotency_ttl_hours', '24', 'migration'),
  ('max_repair_cycles', '2', 'migration'),
  ('lint_blocking', 'false', 'migration'),
  ('test_blocking', 'true', 'migration'),
  ('safe_install_ignore_scripts', 'true', 'migration'),
  ('auto_install_scripts_fallback', 'true', 'migration'),
  ('raw_retention_days', '30', 'migration'),
  ('summary_retention_days', '180', 'migration');
