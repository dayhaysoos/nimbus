-- Migration: 0011_review_findings_v2.sql
-- Description: migrate review findings to phase 2 canonical structured schema

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS review_findings_v2 (
    id TEXT PRIMARY KEY,
    review_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    category TEXT,
    pass_type TEXT NOT NULL DEFAULT 'single',
    locations_json TEXT,
    description TEXT NOT NULL,
    suggested_fix TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (review_id) REFERENCES review_runs(id) ON DELETE CASCADE,
    CHECK (severity IN ('info', 'critical', 'high', 'medium', 'low')),
    CHECK (category IS NULL OR category IN ('security', 'logic', 'style', 'breaking-change')),
    CHECK (pass_type IN ('single', 'security', 'logic', 'style', 'breaking-change'))
);

INSERT INTO review_findings_v2 (
    id,
    review_id,
    severity,
    category,
    pass_type,
    locations_json,
    description,
    suggested_fix,
    created_at
)
SELECT
    id,
    review_id,
    severity,
    NULL,
    'single',
    NULL,
    description,
    NULL,
    created_at
FROM review_findings;

-- Intentional Phase 2 backfill scope:
-- - preserve only pass_type='single' for legacy rows
-- - leave category/locations/suggested_fix null for legacy data
-- Legacy rows are excluded from strict V2 query/report surfaces.

DROP TABLE review_findings;
ALTER TABLE review_findings_v2 RENAME TO review_findings;

CREATE INDEX IF NOT EXISTS idx_review_findings_review_created
    ON review_findings(review_id, created_at ASC);

PRAGMA foreign_keys = ON;
