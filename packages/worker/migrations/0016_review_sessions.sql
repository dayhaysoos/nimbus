CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  anchor_deployment_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  initial_review_basis TEXT NOT NULL,
  anchor_commit_sha TEXT,
  anchor_checkpoint_id TEXT,
  source_project_root TEXT,
  active_review_id TEXT,
  latest_review_id TEXT,
  pass_count INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  account_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (anchor_deployment_id) REFERENCES workspace_deployments(id) ON DELETE CASCADE,
  CHECK (initial_review_basis IN ('checkpoint', 'environment')),
  CHECK (stop_reason IS NULL OR stop_reason IN ('initial_pass_completed', 'initial_pass_failed', 'cancelled'))
);

ALTER TABLE review_runs ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_review_runs_session_created
  ON review_runs(session_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_review_sessions_repo_branch_created
  ON review_sessions(repo, branch, created_at DESC);
