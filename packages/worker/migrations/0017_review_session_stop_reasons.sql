PRAGMA foreign_keys=off;

CREATE TABLE review_sessions_new (
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
  CHECK (
    stop_reason IS NULL
    OR stop_reason IN (
      'initial_pass_completed',
      'initial_pass_failed',
      'followup_pass_completed',
      'followup_pass_failed',
      'diminishing_returns',
      'risky_fix_requires_approval',
      'no_safe_fixes',
      'no_progress',
      'max_repair_cycles_reached',
      'auto_remediation_failed',
      'cancelled'
    )
  )
);

INSERT INTO review_sessions_new (
  id,
  workspace_id,
  anchor_deployment_id,
  repo,
  branch,
  initial_review_basis,
  anchor_commit_sha,
  anchor_checkpoint_id,
  source_project_root,
  active_review_id,
  latest_review_id,
  pass_count,
  stop_reason,
  account_id,
  created_at,
  updated_at,
  finished_at
)
SELECT
  id,
  workspace_id,
  anchor_deployment_id,
  repo,
  branch,
  initial_review_basis,
  anchor_commit_sha,
  anchor_checkpoint_id,
  source_project_root,
  active_review_id,
  latest_review_id,
  pass_count,
  stop_reason,
  account_id,
  created_at,
  updated_at,
  finished_at
FROM review_sessions;

DROP TABLE review_sessions;
ALTER TABLE review_sessions_new RENAME TO review_sessions;

CREATE INDEX IF NOT EXISTS idx_review_sessions_repo_branch_created
  ON review_sessions(repo, branch, created_at DESC);

PRAGMA foreign_keys=on;
