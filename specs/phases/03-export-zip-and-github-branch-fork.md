# Phase 3: Export Zip and GitHub Branch Fork

## Objective
Let users take workspace changes out of Nimbus safely via downloadable artifacts or GitHub branch forks.

## Decision
- Git provider support in v1: GitHub only.
- GitHub auth mode in v1: GitHub App installation tokens only (no stored user PAT/OAuth tokens).

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
  - `workspace_operations`
  - `workspace_operation_idempotency`
- Worker APIs:
  - `POST /api/workspaces/:id/export/zip`
  - `POST /api/workspaces/:id/export/patch`
  - `POST /api/workspaces/:id/fork/github`
  - `GET /api/workspaces/:id/artifacts`
  - `GET /api/workspaces/:id/operations/:operationId`
- Artifact storage:
  - Store zip/patch in R2 with retention metadata.
  - Signed URL generation with short TTL.
- GitHub fork flow:
  - Create branch from source commit SHA.
  - Apply workspace diff.
  - Commit and push to target repo/branch.

## API contract notes
- Fork request should include:
  - target repo, optional branch name, commit message template
  - optional `installationId` override (server auto-resolves by repo owner when omitted)
  - idempotency key (required)
- Fork response should include:
  - branch ref, commit SHA, repo URL, optional compare URL
  - operation/job ID and status
  - `baseline_stale=true` warning when baseline commit is behind target default branch head
- Exports should include:
  - artifact ID, bytes, content type, expiresAt
  - sha256, source baseline SHA, workspace ID, creator ID
  - operation/job ID and status
- Branch collision policy:
  - If caller provides an explicit `branch`, return `409 branch_exists` when occupied.
  - If caller omits `branch`, server generates one and auto-suffixes on collision (`-2`, `-3`, ...).
  - Never overwrite existing refs and never force-push in Phase 3.
- Fork commit model:
  - Create one deterministic squashed commit per fork operation representing workspace delta.
- Baseline mismatch policy:
  - Fork from the original workspace baseline SHA for determinism.
  - Include `baseline_stale=true` warning when target default branch has moved.
- Diff application strategy:
  - Materialize full workspace tree and commit snapshot for fork reliability.
  - Patch-based apply remains for patch export path only.
- Cross-repo safety policy:
  - Restrict forks via org allowlist + explicit source->target policy table.
- Binary and large file policy:
  - Zip export includes binaries.
  - Patch export excludes binaries and records exclusions in artifact metadata.
  - Fork preflight hard-fails when files exceed GitHub blob limits, with actionable file list.
- Operation semantics:
  - Export and fork endpoints run as async jobs with status polling.
- Idempotency:
  - Caller-provided idempotency key is required for export/fork POSTs.
  - Dedupe window: 24h on `(workspace_id, operation_type, key)`.
- Partial failure behavior:
  - If branch is created but commit/push fails, keep branch and mark operation failed with recovery instructions.
- Artifact expiration behavior:
  - Default artifact retention: 7 days.
  - Signed download URL TTL: 15 minutes.
  - Expired artifact download returns `410 Gone` with regeneration guidance.
  - Support regenerate-from-template flow using prior artifact parameters with a new idempotency key.
- Secrets leakage policy:
  - Detect secret patterns and include warnings in metadata.
  - Optional policy mode `block_on_secret_match` is available behind feature/config flag.

## Concrete API schemas

### Shared conventions
- Auth: existing Nimbus auth + workspace access checks.
- Idempotency: required `Idempotency-Key` header for all export/fork POSTs.
- Async model: POST returns `202 Accepted` with `operation` envelope; client polls operation status endpoint.
- Error envelope:

```json
{
  "error": {
    "code": "branch_exists",
    "message": "Branch already exists.",
    "details": {
      "branch": "nimbus/ws_123/20260307-173000",
      "suggestedBranch": "nimbus/ws_123/20260307-173000-2"
    },
    "requestId": "req_01J..."
  }
}
```

### `POST /api/workspaces/:id/export/zip`
Create async zip export job.

Request body:

```json
{
  "sourceArtifactId": "art_01J...",
  "include": {
    "paths": ["src/**", "README.md"],
    "exclude": ["node_modules/**"]
  }
}
```

Request notes:
- `sourceArtifactId` is optional; when provided, server reuses prior artifact params as regeneration template.
- `include` is optional; omitting means full workspace snapshot.

Response `202`:

```json
{
  "operation": {
    "id": "op_01J...",
    "type": "export_zip",
    "status": "queued",
    "workspaceId": "ws_123",
    "idempotencyKey": "9c68636f-...",
    "createdAt": "2026-03-07T17:30:00Z"
  }
}
```

### `POST /api/workspaces/:id/export/patch`
Create async patch export job.

Request body:

```json
{
  "sourceArtifactId": "art_01J..."
}
```

Response `202`:

```json
{
  "operation": {
    "id": "op_01J...",
    "type": "export_patch",
    "status": "queued",
    "workspaceId": "ws_123",
    "idempotencyKey": "91ff6743-...",
    "createdAt": "2026-03-07T17:30:00Z"
  }
}
```

### `POST /api/workspaces/:id/fork/github`
Create async GitHub fork job.

Request body:

```json
{
  "target": {
    "owner": "acme",
    "repo": "backend",
    "branch": "nimbus/ws_123/feature-export"
  },
  "commit": {
    "message": "Apply Nimbus workspace ws_123 changes"
  },
  "installationId": 12345678
}
```

Request notes:
- `target.branch` optional. If omitted, server generates deterministic branch name and auto-suffixes on collision.
- `installationId` optional override. Server auto-resolves by target repo owner when omitted.

Response `202`:

```json
{
  "operation": {
    "id": "op_01J...",
    "type": "fork_github",
    "status": "queued",
    "workspaceId": "ws_123",
    "idempotencyKey": "52b5b1e2-...",
    "createdAt": "2026-03-07T17:30:00Z"
  }
}
```

### `GET /api/workspaces/:id/operations/:operationId`
Poll export/fork job status.

Response `200` (running):

```json
{
  "operation": {
    "id": "op_01J...",
    "type": "fork_github",
    "status": "running",
    "workspaceId": "ws_123",
    "createdAt": "2026-03-07T17:30:00Z",
    "updatedAt": "2026-03-07T17:30:05Z"
  }
}
```

Response `200` (succeeded, export):

```json
{
  "operation": {
    "id": "op_01J...",
    "type": "export_zip",
    "status": "succeeded",
    "workspaceId": "ws_123",
    "result": {
      "artifactId": "art_01J..."
    },
    "createdAt": "2026-03-07T17:30:00Z",
    "updatedAt": "2026-03-07T17:30:12Z"
  }
}
```

Response `200` (succeeded, fork):

```json
{
  "operation": {
    "id": "op_01J...",
    "type": "fork_github",
    "status": "succeeded",
    "workspaceId": "ws_123",
    "warnings": [
      {
        "code": "baseline_stale",
        "message": "Forked from workspace baseline while target default branch moved."
      }
    ],
    "result": {
      "target": {
        "owner": "acme",
        "repo": "backend",
        "branch": "nimbus/ws_123/feature-export"
      },
      "branchRef": "refs/heads/nimbus/ws_123/feature-export",
      "commitSha": "f7ac6d...",
      "repoUrl": "https://github.com/acme/backend",
      "compareUrl": "https://github.com/acme/backend/compare/main...nimbus/ws_123/feature-export"
    },
    "createdAt": "2026-03-07T17:30:00Z",
    "updatedAt": "2026-03-07T17:30:18Z"
  }
}
```

Response `200` (failed):

```json
{
  "operation": {
    "id": "op_01J...",
    "type": "fork_github",
    "status": "failed",
    "workspaceId": "ws_123",
    "result": {
      "partial": {
        "branchCreated": true,
        "branchRef": "refs/heads/nimbus/ws_123/feature-export"
      }
    },
    "error": {
      "code": "push_rejected",
      "message": "GitHub rejected push.",
      "details": {
        "recovery": "Inspect branch and retry with a new operation/idempotency key."
      }
    },
    "createdAt": "2026-03-07T17:30:00Z",
    "updatedAt": "2026-03-07T17:30:14Z"
  }
}
```

### `GET /api/workspaces/:id/artifacts`
List workspace artifacts with integrity/provenance and current availability.

Response `200`:

```json
{
  "artifacts": [
    {
      "id": "art_01J...",
      "type": "zip",
      "status": "available",
      "bytes": 48219,
      "contentType": "application/zip",
      "sha256": "8af5f0...",
      "workspaceId": "ws_123",
      "sourceBaselineSha": "9cd1b1...",
      "creatorId": "usr_456",
      "createdAt": "2026-03-07T17:30:12Z",
      "expiresAt": "2026-03-14T17:30:12Z",
      "download": {
        "url": "https://r2.example/signed/...",
        "expiresAt": "2026-03-07T17:45:12Z"
      },
      "warnings": [
        {
          "code": "secret_match",
          "message": "Potential secret pattern detected in .env.local"
        }
      ]
    },
    {
      "id": "art_01J...",
      "type": "patch",
      "status": "expired",
      "bytes": 2190,
      "contentType": "text/x-diff",
      "sha256": "21be13...",
      "workspaceId": "ws_123",
      "sourceBaselineSha": "9cd1b1...",
      "creatorId": "usr_456",
      "createdAt": "2026-02-20T10:00:00Z",
      "expiresAt": "2026-02-27T10:00:00Z",
      "download": null,
      "warnings": [
        {
          "code": "binary_excluded",
          "message": "2 binary files excluded from patch",
          "details": {
            "files": ["assets/logo.png", "bin/tool"]
          }
        }
      ]
    }
  ]
}
```

### Status and error codes
- Operation statuses: `queued | running | succeeded | failed`.
- Artifact statuses: `available | expired`.
- Standard errors:
  - `403 installation_access_denied`
  - `403 target_repo_not_allowed`
  - `409 branch_exists`
  - `409 idempotency_conflict`
  - `410 artifact_expired`
  - `422 file_too_large_for_github`
  - `422 secret_match_blocked`
  - `502 github_api_error`

## DB schema (D1)

### `workspace_operations`
Tracks async export/fork execution and final outcome.

Suggested columns:
- `id` (text/uuid, pk)
- `workspace_id` (text/uuid, not null, fk -> workspaces.id)
- `type` (enum: `export_zip | export_patch | fork_github`, not null)
- `status` (enum: `queued | running | succeeded | failed`, not null)
- `actor_id` (text/uuid, nullable fk -> users.id)
- `auth_principal` (jsonb, not null) // subject, provider, installation context
- `request_payload` (jsonb, not null)
- `request_payload_sha256` (text, not null)
- `idempotency_key` (text, not null)
- `started_at` (timestamptz, nullable)
- `finished_at` (timestamptz, nullable)
- `duration_ms` (integer, nullable)
- `result` (jsonb, nullable) // fork branch/commit or artifact pointer
- `warnings` (jsonb, not null default `[]`)
- `error_code` (text, nullable)
- `error_class` (text, nullable)
- `error_message` (text, nullable)
- `error_details` (jsonb, nullable)
- `created_at` (timestamptz, not null default now())
- `updated_at` (timestamptz, not null default now())

Recommended indexes:
- `(workspace_id, created_at desc)` for history views
- `(workspace_id, status, created_at desc)` for active polling lists
- `(type, created_at desc)` for ops dashboards
- `(error_code, created_at desc)` for failure analysis

### `workspace_operation_idempotency`
Provides 24h dedupe contract without relying on time-window unique indexes.

Suggested columns:
- `id` (text/uuid, pk)
- `workspace_id` (text/uuid, not null, fk -> workspaces.id)
- `operation_type` (enum: `export_zip | export_patch | fork_github`, not null)
- `idempotency_key` (text, not null)
- `operation_id` (text/uuid, not null, fk -> workspace_operations.id)
- `request_payload_sha256` (text, not null)
- `expires_at` (timestamptz, not null) // `created_at + interval '24 hours'`
- `created_at` (timestamptz, not null default now())

Required unique constraint:
- unique `(workspace_id, operation_type, idempotency_key)`

Behavior:
- On POST, upsert/lookup idempotency row first.
- If existing row is unexpired and payload hash matches, return prior `operation_id`.
- If existing row is unexpired and payload hash differs, return `409 idempotency_conflict`.
- Expired rows are cleaned by background job; cleanup can then free the key for reuse.

### `workspace_artifacts`
Stores artifact metadata, integrity/provenance, lifecycle, and warnings.

Suggested columns (additions highlighted by purpose):
- `id` (text/uuid, pk)
- `workspace_id` (text/uuid, not null, fk -> workspaces.id)
- `operation_id` (text/uuid, nullable fk -> workspace_operations.id)
- `type` (enum: `zip | patch`, not null)
- `status` (enum: `available | expired`, not null)
- `object_key` (text, not null) // R2 key
- `bytes` (bigint, not null)
- `content_type` (text, not null)
- `sha256` (text, not null)
- `source_baseline_sha` (text, not null)
- `creator_id` (text/uuid, nullable fk -> users.id)
- `retention_expires_at` (timestamptz, not null)
- `expired_at` (timestamptz, nullable)
- `warnings` (jsonb, not null default `[]`)
- `metadata` (jsonb, not null default `{}`) // include/exclude filters, binary exclusion counts
- `created_at` (timestamptz, not null default now())
- `updated_at` (timestamptz, not null default now())

Recommended indexes:
- `(workspace_id, created_at desc)` for artifact listing
- `(workspace_id, status, retention_expires_at)` for expiry scans/UI
- `(operation_id)` for joining operation -> artifact result
- `(sha256)` optional for integrity investigations/dedupe analytics

### Warning payload shape (`warnings` jsonb)
Use a consistent array item shape in both `workspace_operations.warnings` and `workspace_artifacts.warnings`:

```json
[
  {
    "code": "binary_excluded",
    "message": "2 binary files excluded from patch",
    "severity": "info",
    "details": {
      "files": ["assets/logo.png", "bin/tool"],
      "count": 2
    }
  },
  {
    "code": "secret_match",
    "message": "Potential secret pattern detected in .env.local",
    "severity": "warn",
    "details": {
      "path": ".env.local",
      "detector": "generic-key-pattern"
    }
  }
]
```

Recommended warning codes:
- `baseline_stale`
- `binary_excluded`
- `secret_match`
- `artifact_near_expiry`

### Audit persistence minimums
Persist per operation:
- actor identity (`actor_id`, `auth_principal`)
- source context (`workspace_id`, `source_baseline_sha` in result/metadata)
- target context for fork (repo owner/name, branch)
- request traceability (`request_payload_sha256`, idempotency key)
- execution timing (`started_at`, `finished_at`, `duration_ms`)
- failure shape (`error_code`, `error_class`, `error_details`)
- produced artifact integrity (`artifact_id`, `sha256`) when applicable

## SQL migration sketch (Postgres-style)

```sql
-- Enums (use CHECK constraints instead if preferred)
DO $$ BEGIN
  CREATE TYPE workspace_operation_type AS ENUM ('export_zip', 'export_patch', 'fork_github');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE workspace_operation_status AS ENUM ('queued', 'running', 'succeeded', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE workspace_artifact_type AS ENUM ('zip', 'patch');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE workspace_artifact_status AS ENUM ('available', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS workspace_operations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  type workspace_operation_type NOT NULL,
  status workspace_operation_status NOT NULL,
  actor_id text NULL REFERENCES users(id),
  auth_principal jsonb NOT NULL,
  request_payload jsonb NOT NULL,
  request_payload_sha256 text NOT NULL,
  idempotency_key text NOT NULL,
  started_at timestamptz NULL,
  finished_at timestamptz NULL,
  duration_ms integer NULL,
  result jsonb NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text NULL,
  error_class text NULL,
  error_message text NULL,
  error_details jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_operations_workspace_created
  ON workspace_operations (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_operations_workspace_status_created
  ON workspace_operations (workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_operations_type_created
  ON workspace_operations (type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_operations_error_code_created
  ON workspace_operations (error_code, created_at DESC)
  WHERE error_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_operation_idempotency (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_type workspace_operation_type NOT NULL,
  idempotency_key text NOT NULL,
  operation_id text NOT NULL REFERENCES workspace_operations(id),
  request_payload_sha256 text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, operation_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_operation_idempotency_expires
  ON workspace_operation_idempotency (expires_at);

-- If workspace_artifacts already exists, use ALTER TABLE guards in your migration framework.
CREATE TABLE IF NOT EXISTS workspace_artifacts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  operation_id text NULL REFERENCES workspace_operations(id),
  type workspace_artifact_type NOT NULL,
  status workspace_artifact_status NOT NULL,
  object_key text NOT NULL,
  bytes bigint NOT NULL,
  content_type text NOT NULL,
  sha256 text NOT NULL,
  source_baseline_sha text NOT NULL,
  creator_id text NULL REFERENCES users(id),
  retention_expires_at timestamptz NOT NULL,
  expired_at timestamptz NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_workspace_created
  ON workspace_artifacts (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_workspace_status_expiry
  ON workspace_artifacts (workspace_id, status, retention_expires_at);

CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_operation_id
  ON workspace_artifacts (operation_id)
  WHERE operation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_sha256
  ON workspace_artifacts (sha256);
```

## Ready-to-build checklist
- Spec decisions are now fully locked for API behavior, async semantics, idempotency, safety controls, and audit expectations.
- Remaining pre-build work is small and implementation-oriented:
  - map these schemas to your actual ORM/migration style (D1/Drizzle/Prisma/sqlc)
  - finalize exact auth middleware wiring for `Idempotency-Key` and workspace access checks
  - choose worker queue contract (`queued/running/succeeded/failed` payload format)
- Estimated effort before coding starts: effectively none beyond migration syntax translation.
- Suggested implementation order:
  1. migrations + model types
  2. operation service (create/poll/idempotency)
  3. zip/patch workers
  4. github fork worker + preflight checks
  5. `/artifacts` read path + signed URL minting
  6. integration/failure tests from this phase plan

## Acceptance criteria
- Zip artifact downloads and unpacks to expected filesystem contents.
- Patch artifact applies cleanly against baseline commit in expected cases.
- GitHub branch creation succeeds with correct base commit and authored commit.
- Permission/auth failures return actionable errors.
- Export/fork operations are async, observable by job status, and idempotent for 24h keys.
- Fork operation uses deterministic squashed commit behavior and never force-pushes.
- Artifact records expose immutable integrity/provenance fields (sha256, bytes, baseline SHA, workspace ID, creator ID).
- Expired artifacts return `410 Gone` and support regenerate flow.
- Policy enforcement blocks disallowed cross-repo forks and oversized GitHub blobs with actionable diagnostics.

## Test plan
- Integration: create workspace -> modify -> zip export -> verify archive contents.
- Integration: create workspace -> modify -> patch export -> apply and validate.
- Integration: fork to test repo branch and verify commit tree.
- Failure tests: token scope missing, branch collision, push rejection.
- Integration: async job lifecycle (queued -> running -> succeeded/failed) for export and fork.
- Integration: idempotency replay returns original operation/artifact for same key within 24h.
- Integration: baseline stale path returns `baseline_stale=true` while forking from original baseline SHA.
- Integration: collision behavior for generated vs explicit branch names.
- Integration: cross-repo policy allow/deny behavior and installation auto-resolution.
- Failure tests: oversized blob preflight failure, secret warning metadata, optional secret-block mode.

## Rollout
- Feature flags:
  - `workspace_export_enabled`
  - `workspace_github_fork_enabled`
  - `block_on_secret_match` (optional policy mode)
- Start with internal GitHub org allowlist.

## Finalized implementation decisions
- GitHub auth and permissions:
  - Use GitHub App installation token flow per request (short-lived token minting; no long-lived user token storage).
  - Required repo permissions: `contents:write` (includes read), `metadata:read`.
  - Optional only if PR creation is added later: `pull_requests:write`.
  - Validate installation access to target repo before attempting branch push; return actionable `403` when missing.
- Branch naming and collisions:
  - Default generated branch format: `nimbus/{workspaceId}/{yyyyMMdd-HHmmss}`.
  - Sanitize to lowercase `[a-z0-9/_-]`, collapse repeats, trim to GitHub limits.
  - If generated name collides, append numeric suffixes deterministically.
  - If user-specified branch collides, fail fast with `409` and suggested next available name.
- Commit and fork behavior:
  - Produce one deterministic squashed commit per fork operation.
  - Fork from workspace baseline SHA even if target default branch has moved; surface `baseline_stale=true` warning.
  - Materialize workspace tree for fork commit creation (patch apply is not the primary fork path).
- Cross-repo and safety controls:
  - Enforce org allowlist and explicit source->target policy mapping.
  - Keep partially created branches on failure; mark failed with actionable recovery guidance.
  - Apply lightweight per-user/per-org quotas and burst limits for exports/forks/artifact bytes.
- Artifact integrity, expiry, and regeneration:
  - Keep zip/patch artifacts in R2 for 7 days by default (configurable env override).
  - Keep artifact metadata after object expiry so `/artifacts` can show `expired` state.
  - Display `expiresAt` in every artifact response; signed URL TTL is 15 minutes.
  - Download calls mint fresh signed URLs; URLs are never persisted as canonical state.
  - Expose immutable integrity/provenance metadata: sha256, bytes, baseline SHA, workspace ID, creator ID.
  - Allow one-click regeneration using prior artifact parameters with a new idempotency key.
- Async execution and idempotency:
  - Run export/fork as async jobs with status polling.
  - Require caller idempotency keys for export/fork POSTs, with 24h dedupe window.
- Secret handling and binary/size policy:
  - Zip includes binaries by default.
  - Patch excludes binaries and records exclusions in metadata.
  - Fork preflight blocks files over GitHub blob limits and returns actionable file diagnostics.
  - Secret pattern detection emits warnings in metadata; optional blocking mode behind `block_on_secret_match`.
- Audit and compliance persistence:
  - Persist actor, auth principal, source workspace/baseline, target repo/branch, request payload hash, error code/class, timing, and artifact hash for each operation.
