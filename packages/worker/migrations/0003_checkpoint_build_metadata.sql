-- Migration: 0003_checkpoint_build_metadata.sql
-- Description: persist checkpoint project-root and build flag metadata

ALTER TABLE jobs ADD COLUMN source_project_root TEXT;
ALTER TABLE jobs ADD COLUMN build_run_tests_if_present INTEGER;
ALTER TABLE jobs ADD COLUMN build_run_lint_if_present INTEGER;

CREATE INDEX IF NOT EXISTS idx_jobs_source_project_root_created_at ON jobs(source_project_root, created_at DESC);
