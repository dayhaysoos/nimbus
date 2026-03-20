CREATE TABLE IF NOT EXISTS nimbus_repo_registrations (
  repo_slug TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  registered_by_key_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nimbus_repo_registrations_account_id
  ON nimbus_repo_registrations(account_id);
