# Phase 3: Export Zip and GitHub Branch Fork

## Objective
Let users take workspace changes out of Nimbus safely via downloadable artifacts or GitHub branch forks.

## Decision
- Git provider support in v1: GitHub only.

## In scope
- Export workspace snapshot as zip artifact.
- Optional patch export (`.patch`) from workspace diff.
- Fork workspace changes into a GitHub branch.
- Persist export/fork events and artifact metadata.

## Out of scope
- Non-GitHub SCM integrations.
- Auto-merge workflows.
- PR review automation (can be follow-up).

## User stories
1. As a developer, I can download current workspace state as zip.
2. As a developer, I can create a GitHub branch with workspace changes.
3. As a developer, I can see whether export/fork succeeded and retrieve outputs.

## Deliverables
- D1 schema additions:
  - `workspace_artifacts`
- Worker APIs:
  - `POST /api/workspaces/:id/export/zip`
  - `POST /api/workspaces/:id/export/patch`
  - `POST /api/workspaces/:id/fork/github`
  - `GET /api/workspaces/:id/artifacts`
- Artifact storage:
  - Store zip/patch in R2 with retention metadata.
  - Signed URL generation with short TTL.
- GitHub fork flow:
  - Create branch from source commit SHA.
  - Apply workspace diff.
  - Commit and push to target repo/branch.

## API contract notes
- Fork request should include:
  - target repo, branch name, commit message template
- Fork response should include:
  - branch ref, commit SHA, repo URL, optional compare URL
- Exports should include:
  - artifact ID, bytes, content type, expiresAt

## Acceptance criteria
- Zip artifact downloads and unpacks to expected filesystem contents.
- Patch artifact applies cleanly against baseline commit in expected cases.
- GitHub branch creation succeeds with correct base commit and authored commit.
- Permission/auth failures return actionable errors.

## Test plan
- Integration: create workspace -> modify -> zip export -> verify archive contents.
- Integration: create workspace -> modify -> patch export -> apply and validate.
- Integration: fork to test repo branch and verify commit tree.
- Failure tests: token scope missing, branch collision, push rejection.

## Rollout
- Feature flags:
  - `workspace_export_enabled`
  - `workspace_github_fork_enabled`
- Start with internal GitHub org allowlist.

## Interview focus for this phase
- GitHub auth mode (App vs OAuth token) and required scopes.
- Branch naming conventions and collision policy.
- Artifact retention defaults and user-visible expiration behavior.
