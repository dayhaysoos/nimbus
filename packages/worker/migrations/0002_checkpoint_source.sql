-- Migration: 0002_checkpoint_source.sql
-- Description: add source provenance fields for checkpoint deployments

ALTER TABLE jobs ADD COLUMN source_type TEXT;
ALTER TABLE jobs ADD COLUMN checkpoint_id TEXT;
ALTER TABLE jobs ADD COLUMN commit_sha TEXT;
ALTER TABLE jobs ADD COLUMN source_ref TEXT;
ALTER TABLE jobs ADD COLUMN source_bundle_key TEXT;
ALTER TABLE jobs ADD COLUMN source_bundle_sha256 TEXT;
ALTER TABLE jobs ADD COLUMN source_bundle_bytes INTEGER;

CREATE INDEX IF NOT EXISTS idx_jobs_source_type_created_at ON jobs(source_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_checkpoint_id_created_at ON jobs(checkpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_commit_sha_created_at ON jobs(commit_sha, created_at DESC);
