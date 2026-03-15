-- Migration: 0012_account_ownership.sql
-- Description: add hosted API key table and account ownership columns

CREATE TABLE IF NOT EXISTS nimbus_api_keys (
  key_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE review_runs ADD COLUMN IF NOT EXISTS account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_account
  ON workspaces(account_id);
CREATE INDEX IF NOT EXISTS idx_review_runs_account
  ON review_runs(account_id);
