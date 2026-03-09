# Phase 6: Toolchain-Parity Deploy Runtime

## Objective
Make workspace deployment execution faithfully reflect project toolchain expectations (package manager + runtime setup), reduce manual recovery, and improve deploy ergonomics/speed for repeated runs.

This phase builds directly on Phase 5 (deploy lifecycle + provenance) and focuses on environment parity and operator experience.

## Why this phase exists
Phase 5 proved deployment lifecycle correctness, but manual validation exposed practical blockers:
- Validation can fail when sandbox runtime lacks expected package manager (for example `pnpm`).
- Baseline drift may require reset/retry loops.
- CLI deploy path lacks explicit validation toggles and auto-fix controls.
- Repeated deploys do not yet leverage dependency caching for speed.

Phase 6 addresses those gaps with deterministic toolchain bootstrap, preflight remediation, and faster repeat execution.

## Product decisions (final)
1. **Manager authority:** `packageManager` in `package.json` is the source of truth when present. Lockfiles are fallback signal.
2. **Bootstrap strategy:** use `corepack` first for `pnpm`/`yarn`; fallback to `npm` only when safe and explicit.
3. **Validation default:** keep validation enabled by default (`build/test if present`), but expose first-class CLI controls to disable.
4. **Auto-fix policy:** preflight supports explicit `autoFix` mode; no hidden remediations outside well-defined safe actions.
5. **Caching scope:** dependency cache is per-workspace + lockfile hash + package manager/version + project root.
6. **Safety:** never execute unknown install scripts in preflight; bootstrap checks are capability/setup only.

## In scope
- Toolchain detection from workspace source (`packageManager`, lockfiles, scripts).
- Runtime bootstrap for package manager in sandbox (`corepack enable/prepare`).
- Validation command execution with manager-aware wrappers.
- Preflight enhancements:
  - capability checks
  - optional auto-fix actions
  - actionable hints and remediation outcomes
- CLI deploy ergonomics:
  - `--no-tests`
  - `--no-build`
  - `--preflight-only`
  - `--auto-fix`
- Dependency cache for repeated deploy validation/build steps.
- Events/metrics for observability of bootstrap and cache behavior.

## Out of scope
- Multi-runtime image orchestration.
- Language-specific dependency caching beyond JavaScript package managers.
- Full immutable container snapshotting.
- Arbitrary package manager installation via curl/bash scripts.

## Deliverables

### D1. Toolchain detection + normalization
- New internal model `WorkspaceToolchainProfile`:
  - `manager`: `pnpm | yarn | npm | unknown`
  - `requestedVersion`: string | null
  - `detectedFrom`: `packageManager | lockfile | scripts | fallback`
  - `projectRoot`: normalized path
  - `lockfile`: `{ name, sha256 } | null`
- Detection precedence:
  1. `package.json#packageManager`
  2. lockfile presence (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`)
  3. scripts heuristic (`pnpm ...`, `yarn ...`, `npm ...`)
  4. fallback `npm`

### D2. Bootstrap runner support
- Runner bootstraps manager before validation/build when needed:
  - `corepack --version` check
  - `corepack enable`
  - `corepack prepare <manager>@<version> --activate` when version available
- Error code taxonomy:
  - `corepack_missing`
  - `package_manager_bootstrap_failed`
  - `validation_tool_missing` (retained)
  - `validation_command_failed`

### D3. Preflight v2
- Extend `POST /api/workspaces/:id/deploy/preflight` request:
```json
{
  "validation": {
    "runBuildIfPresent": true,
    "runTestsIfPresent": true
  },
  "autoFix": {
    "rehydrateBaseline": true,
    "bootstrapToolchain": true
  }
}
```
- Response includes:
  - `toolchain` profile
  - granular checks
  - applied remediations
  - `nextAction`

### D4. CLI deploy UX
- Add/extend command:
  - `nimbus workspace deploy <workspace-id> [options]`
- New options:
  - `--no-tests`
  - `--no-build`
  - `--preflight-only`
  - `--auto-fix`
  - `--poll-interval-ms <n>`
- Output behavior:
  - preflight summary table
  - remediation summary
  - deployment lifecycle updates
  - actionable next steps on terminal failure

### D5. Dependency cache
- Cache key inputs:
  - `workspaceId`
  - `projectRoot`
  - manager + version
  - lockfile hash
- Cache artifact strategy:
  - manager store/cache directory tarball to R2
  - restore before validation/build
- Events:
  - `deployment_dependency_cache_hit`
  - `deployment_dependency_cache_miss`
  - `deployment_dependency_cache_saved`
  - `deployment_dependency_cache_restore_failed` (non-fatal)

## API contract changes

### 1) Preflight (enhanced)
`POST /api/workspaces/:id/deploy/preflight`

Request schema:
```json
{
  "validation": {
    "runBuildIfPresent": true,
    "runTestsIfPresent": true
  },
  "autoFix": {
    "rehydrateBaseline": true,
    "bootstrapToolchain": true
  }
}
```

Response schema:
```json
{
  "preflight": {
    "ok": true,
    "toolchain": {
      "manager": "pnpm",
      "requestedVersion": "9.12.1",
      "detectedFrom": "packageManager",
      "projectRoot": ".",
      "lockfile": {
        "name": "pnpm-lock.yaml",
        "sha256": "..."
      }
    },
    "checks": [
      { "code": "workspace_ready", "ok": true },
      { "code": "git_baseline", "ok": true },
      { "code": "secret_scan", "ok": true },
      { "code": "toolchain_detect", "ok": true },
      { "code": "toolchain_bootstrap", "ok": true },
      { "code": "validation_tooling", "ok": true }
    ],
    "remediations": [
      { "code": "baseline_rehydrated", "applied": false },
      { "code": "toolchain_bootstrapped", "applied": true }
    ]
  },
  "nextAction": null
}
```

### 2) Deploy create (extended payload)
`POST /api/workspaces/:id/deploy`

Add optional fields:
```json
{
  "validation": {
    "runBuildIfPresent": true,
    "runTestsIfPresent": true
  },
  "autoFix": {
    "rehydrateBaseline": true,
    "bootstrapToolchain": true
  },
  "toolchain": {
    "manager": "pnpm",
    "version": "9.12.1"
  },
  "cache": {
    "dependencyCache": true
  }
}
```

Defaults:
- `autoFix.rehydrateBaseline = true`
- `autoFix.bootstrapToolchain = true`
- `cache.dependencyCache = true`

## Data model and migration sketch

### New columns (`workspace_deployments`)
- `toolchain_json TEXT` (normalized profile used for run)
- `dependency_cache_key TEXT`
- `dependency_cache_hit INTEGER NOT NULL DEFAULT 0`
- `remediations_json TEXT` (applied auto-fixes)

### New table (`workspace_dependency_caches`)
- `id TEXT PRIMARY KEY`
- `workspace_id TEXT NOT NULL`
- `cache_key TEXT NOT NULL`
- `manager TEXT NOT NULL`
- `manager_version TEXT`
- `project_root TEXT NOT NULL`
- `lockfile_name TEXT`
- `lockfile_sha256 TEXT`
- `artifact_key TEXT NOT NULL`
- `artifact_sha256 TEXT NOT NULL`
- `artifact_bytes INTEGER NOT NULL`
- `last_used_at TEXT NOT NULL`
- `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
- `updated_at TEXT NOT NULL DEFAULT (datetime('now'))`
- `UNIQUE(workspace_id, cache_key)`

### Migration file
- `0008_workspace_toolchain_parity.sql`

## Runner lifecycle changes
1. Claim deployment (`queued -> running`) as in Phase 5.
2. Resolve toolchain profile.
3. Baseline check; if missing and auto-fix enabled, attempt rehydrate.
4. Secret scan.
5. Toolchain bootstrap (corepack) if required.
6. Dependency cache restore (best-effort).
7. Validation/test/build execution with manager-aware command path.
8. Dependency cache save (best-effort) if lockfile hash known.
9. Bundle/publish success path unchanged.

## Manager-aware execution rules
- If manager is `pnpm`:
  - validation command wrapper uses `pnpm run -s <script>` where appropriate.
- If manager is `yarn`:
  - use `yarn -s <script>`.
- If manager is `npm`:
  - keep `npm run -s <script>`.
- If `unknown`:
  - fallback `npm`, emit warning event `deployment_toolchain_unknown_fallback`.

## Failure modes and error codes
- `toolchain_detect_failed`
- `corepack_missing`
- `package_manager_bootstrap_failed`
- `validation_tool_missing`
- `validation_command_failed`
- `dependency_cache_restore_failed` (non-terminal unless strict mode introduced)
- existing Phase 5 codes remain valid (`baseline_missing`, `baseline_rehydrate_failed`, etc.)

## Observability
- Add events:
  - `deployment_toolchain_detected`
  - `deployment_toolchain_bootstrap_started`
  - `deployment_toolchain_bootstrap_succeeded`
  - `deployment_toolchain_bootstrap_failed`
  - `deployment_dependency_cache_hit`
  - `deployment_dependency_cache_miss`
  - `deployment_dependency_cache_saved`
  - `deployment_dependency_cache_restore_failed`
- Add counters (if metrics layer available):
  - `workspace_deploy.toolchain_bootstrap.success`
  - `workspace_deploy.toolchain_bootstrap.failure`
  - `workspace_deploy.validation_tool_missing`
  - `workspace_deploy.dependency_cache.hit`
  - `workspace_deploy.dependency_cache.miss`

## Security and safety notes
- Preflight/bootstrap must not execute remote install scripts.
- Use only built-in package manager bootstrap via `corepack`.
- Preserve secret scan guardrail from Phase 5.
- Dependency cache artifacts are private and bound to workspace/cache key.

## Test plan

### Unit tests
- Toolchain detection precedence matrix.
- `packageManager` parser edge cases.
- lockfile hash generation.
- next-action mapping for new failure codes.

### Integration-style tests
- Workspace with `pnpm` scripts + `packageManager` succeeds after bootstrap.
- Missing `corepack` yields `corepack_missing` with actionable nextAction.
- `--no-tests --no-build` path skips tooling checks.
- Baseline missing with auto-fix true rehydrates and continues.
- Baseline missing with auto-fix false fails fast.
- Cache miss first run, cache hit second run.
- Cache restore failure remains non-terminal and emits warning event.

### Regression tests
- Phase 5 happy path unchanged for npm projects.
- Idempotency behavior unchanged.
- Cancel/retry semantics unchanged.

## Rollout plan
1. Ship dark behind runtime flag:
   - `workspace_deploy_toolchain_parity_enabled=false`
2. Enable preflight output fields first (read-only mode).
3. Enable bootstrap + manager-aware validation for staging.
4. Enable dependency cache in staging.
5. Production ramp by percentage of deploy requests.
6. Observe failure rates for new codes; adjust fallbacks.

## Acceptance criteria
- Projects that declare `pnpm` via `packageManager` can run deploy validation without manual sandbox tweaking.
- Preflight identifies toolchain requirements and remediation outcomes.
- CLI deploy supports `--no-tests`, `--no-build`, `--preflight-only`, `--auto-fix`.
- Repeated deploys show measurable improvement with dependency cache hits.
- Failure responses always include actionable `nextAction` for known operational issues.

## Implementation checklist (for delegated agent)
1. Add migration `0008_workspace_toolchain_parity.sql`.
2. Extend worker types and DB accessors for toolchain/cache fields.
3. Implement toolchain detection module and tests.
4. Implement bootstrap helpers (`corepack`) and tests.
5. Integrate manager-aware validation execution in runner.
6. Integrate cache restore/save flow + events.
7. Extend preflight endpoint response schema + auto-fix inputs.
8. Extend deploy API payload parsing for `autoFix`, `toolchain`, `cache`.
9. Implement CLI flags and command UX updates.
10. Add docs/runbook updates and full test pass.

## Operator manual quick reference
- Preflight only:
  - `nimbus workspace deploy <id> --preflight-only`
- Skip validations:
  - `nimbus workspace deploy <id> --no-tests --no-build`
- Auto-fix baseline/toolchain:
  - `nimbus workspace deploy <id> --auto-fix`
