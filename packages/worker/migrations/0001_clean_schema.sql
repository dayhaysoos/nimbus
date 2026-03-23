-- Migration: 0001_clean_schema.sql
-- Description: consolidated clean schema for Nimbus worker (0001-0015)

PRAGMA foreign_keys = ON;

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
    source_type TEXT,
    checkpoint_id TEXT,
    commit_sha TEXT,
    source_ref TEXT,
    source_bundle_key TEXT,
    source_bundle_sha256 TEXT,
    source_bundle_bytes INTEGER,
    source_project_root TEXT,
    build_run_tests_if_present INTEGER,
    build_run_lint_if_present INTEGER,
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    CHECK (phase IN ('queued', 'planning', 'generating', 'building', 'repairing', 'validating', 'deploying', 'completed', 'failed', 'cancelled'))
);

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

CREATE TABLE IF NOT EXISTS runtime_flags (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS nimbus_api_keys (
    key_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    label TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS nimbus_repo_registrations (
    repo_slug TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    registered_by_key_hash TEXT NOT NULL
);

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
    last_deployment_id TEXT,
    last_deployment_status TEXT,
    last_deployed_url TEXT,
    last_deployed_at TEXT,
    last_deployment_error_code TEXT,
    last_deployment_error_message TEXT,
    account_id TEXT,
    CHECK (status IN ('creating', 'ready', 'failed', 'deleted'))
);

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

CREATE TABLE IF NOT EXISTS workspace_tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_payload_json TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    max_steps INTEGER NOT NULL,
    max_retries INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT,
    tool_policy_json TEXT NOT NULL DEFAULT '{}',
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    cancel_requested_at TEXT,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS workspace_task_idempotency (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES workspace_tasks(id) ON DELETE CASCADE,
    UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS workspace_task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES workspace_tasks(id) ON DELETE CASCADE,
    UNIQUE (task_id, seq)
);

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
    toolchain_json TEXT,
    dependency_cache_key TEXT,
    dependency_cache_hit INTEGER NOT NULL DEFAULT 0,
    remediations_json TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

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
    UNIQUE (workspace_id, cache_key)
);

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
    derived_policy_json TEXT,
    approved_policy_json TEXT,
    approved_policy_sha256 TEXT,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    report_json TEXT,
    markdown_summary TEXT,
    error_code TEXT,
    error_message TEXT,
    account_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (deployment_id) REFERENCES workspace_deployments(id) ON DELETE CASCADE,
    CHECK (target_type IN ('workspace_deployment')),
    CHECK (mode IN ('report_only')),
    CHECK (status IN ('policy_pending', 'policy_ready', 'policy_approved', 'queued', 'running', 'succeeded', 'failed', 'cancelled'))
);

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

CREATE TABLE IF NOT EXISTS review_findings (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    category TEXT,
    pass_type TEXT NOT NULL DEFAULT 'single',
    locations_json TEXT,
    description TEXT NOT NULL,
    suggested_fix TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (review_id) REFERENCES review_runs(id) ON DELETE CASCADE,
    CHECK (severity IN ('info', 'critical', 'high', 'medium', 'low')),
    CHECK (category IS NULL OR category IN ('security', 'logic', 'style', 'breaking-change')),
    CHECK (pass_type IN ('single', 'security', 'logic', 'style', 'breaking-change'))
);

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

CREATE TABLE IF NOT EXISTS review_cochange_cache (
    file_path TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    cochange_json TEXT NOT NULL,
    lookback_sessions INTEGER NOT NULL,
    last_updated TEXT NOT NULL,
    PRIMARY KEY (file_path, repo)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_phase_created_at ON jobs(phase, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_workflow_instance ON jobs(workflow_instance_id);
CREATE INDEX IF NOT EXISTS idx_jobs_source_type_created_at ON jobs(source_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_checkpoint_id_created_at ON jobs(checkpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_commit_sha_created_at ON jobs(commit_sha, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_source_project_root_created_at ON jobs(source_project_root, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_attempts_job_attempt ON job_attempts(job_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_job_attempts_job_status ON job_attempts(job_id, status);
CREATE INDEX IF NOT EXISTS idx_job_events_job_seq ON job_events(job_id, seq);
CREATE INDEX IF NOT EXISTS idx_job_events_job_created ON job_events(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_attempt ON job_artifacts(job_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_type ON job_artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS idx_job_revisions_job_attempt ON job_revisions(job_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_job_idempotency_expiry ON job_idempotency(expires_at);
CREATE INDEX IF NOT EXISTS idx_job_idempotency_key ON job_idempotency(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_nimbus_repo_registrations_account_id
    ON nimbus_repo_registrations(account_id);

CREATE INDEX IF NOT EXISTS idx_workspaces_status_created_at ON workspaces(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_checkpoint_id_created_at ON workspaces(checkpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_commit_sha_created_at ON workspaces(commit_sha, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_account ON workspaces(account_id);
CREATE INDEX IF NOT EXISTS idx_workspace_events_workspace_seq ON workspace_events(workspace_id, seq);

CREATE INDEX IF NOT EXISTS idx_workspace_operations_workspace_created
    ON workspace_operations(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_operations_workspace_status_created
    ON workspace_operations(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_operations_type_created
    ON workspace_operations(type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_operation_idempotency_expires
    ON workspace_operation_idempotency(expires_at);

CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_workspace_created
    ON workspace_artifacts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_workspace_status_expiry
    ON workspace_artifacts(workspace_id, status, retention_expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_operation
    ON workspace_artifacts(operation_id);

CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace_created
    ON workspace_tasks(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace_status
    ON workspace_tasks(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_task_idempotency_expires
    ON workspace_task_idempotency(expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_task_events_task_seq
    ON workspace_task_events(task_id, seq ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_deployments_workspace_created
    ON workspace_deployments(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_deployments_workspace_status_created
    ON workspace_deployments(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_deployment_idempotency_expires
    ON workspace_deployment_idempotency(expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_deployment_events_deployment_seq
    ON workspace_deployment_events(deployment_id, seq ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_dependency_caches_workspace_last_used
    ON workspace_dependency_caches(workspace_id, last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_dependency_caches_lockfile
    ON workspace_dependency_caches(workspace_id, lockfile_sha256);

CREATE INDEX IF NOT EXISTS idx_review_runs_workspace_created
    ON review_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_runs_deployment_created
    ON review_runs(deployment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_runs_status_created
    ON review_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_runs_account
    ON review_runs(account_id);
CREATE INDEX IF NOT EXISTS idx_review_run_idempotency_expires
    ON review_run_idempotency(expires_at);
CREATE INDEX IF NOT EXISTS idx_review_findings_review_created
    ON review_findings(review_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_review_events_review_seq
    ON review_events(review_id, seq ASC);
CREATE INDEX IF NOT EXISTS idx_review_context_blobs_review
    ON review_context_blobs(review_id);
CREATE INDEX IF NOT EXISTS idx_review_cochange_cache_updated
    ON review_cochange_cache(last_updated);

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
