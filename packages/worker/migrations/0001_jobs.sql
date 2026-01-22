-- Migration: 0001_jobs.sql
-- Description: Create jobs table for tracking build jobs

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,                    -- e.g., "job_abc123"
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,                    -- e.g., "anthropic/claude-sonnet-4"
    status TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|failed
    
    -- Timestamps (ISO 8601 format)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    
    -- Output URLs
    preview_url TEXT,                       -- Sandbox preview (temporary)
    deployed_url TEXT,                      -- Pages URL (permanent)
    
    -- Error info
    error_message TEXT,
    
    -- Basic metrics
    file_count INTEGER,
    
    -- Constraint to ensure valid status values
    CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

-- Index for filtering by status (e.g., "show me all running jobs")
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Index for sorting by creation date (most recent first)
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
