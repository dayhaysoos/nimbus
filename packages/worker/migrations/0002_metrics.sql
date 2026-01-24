-- Migration: 0002_metrics.sql
-- Description: Add metrics columns to jobs table for tracking build performance

-- Token usage from LLM
ALTER TABLE jobs ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE jobs ADD COLUMN completion_tokens INTEGER;
ALTER TABLE jobs ADD COLUMN total_tokens INTEGER;
ALTER TABLE jobs ADD COLUMN cost REAL;

-- Timing metrics
ALTER TABLE jobs ADD COLUMN llm_latency_ms INTEGER;
ALTER TABLE jobs ADD COLUMN install_duration_ms INTEGER;
ALTER TABLE jobs ADD COLUMN build_duration_ms INTEGER;
ALTER TABLE jobs ADD COLUMN deploy_duration_ms INTEGER;
ALTER TABLE jobs ADD COLUMN total_duration_ms INTEGER;

-- Code metrics
ALTER TABLE jobs ADD COLUMN lines_of_code INTEGER;
