ALTER TABLE review_runs ADD COLUMN repo TEXT;
ALTER TABLE review_runs ADD COLUMN branch TEXT;

CREATE INDEX IF NOT EXISTS idx_review_runs_repo_branch
  ON review_runs(repo, branch, id);
