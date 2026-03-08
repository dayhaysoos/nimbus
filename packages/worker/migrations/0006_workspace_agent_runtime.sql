-- Migration: 0006_workspace_agent_runtime.sql
-- Description: add workspace agent tasks, events, and idempotency tracking

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

CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace_created
    ON workspace_tasks(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_tasks_workspace_status
    ON workspace_tasks(workspace_id, status, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_workspace_task_idempotency_expires
    ON workspace_task_idempotency(expires_at);

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

CREATE INDEX IF NOT EXISTS idx_workspace_task_events_task_seq
    ON workspace_task_events(task_id, seq ASC);
