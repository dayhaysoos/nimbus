-- Migration: 0003_job_logs.sql
-- Description: Add log metadata, worker name, and expiry tracking

ALTER TABLE jobs ADD COLUMN build_log_key TEXT;
ALTER TABLE jobs ADD COLUMN deploy_log_key TEXT;
ALTER TABLE jobs ADD COLUMN worker_name TEXT;
ALTER TABLE jobs ADD COLUMN expires_at TEXT;
