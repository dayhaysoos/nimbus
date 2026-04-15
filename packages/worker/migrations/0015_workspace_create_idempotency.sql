CREATE TABLE IF NOT EXISTS workspace_create_idempotency (
    id TEXT PRIMARY KEY,
    account_scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    request_payload_sha256 TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    UNIQUE (account_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_create_idempotency_workspace
    ON workspace_create_idempotency(workspace_id);
