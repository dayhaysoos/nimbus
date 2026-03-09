# Phase 6 Delegated Agent Prompt

Use this as the exact execution brief for implementing Phase 6 from:
- `specs/phases/06-toolchain-parity-deploy-runtime.md`

## Mission
Implement Phase 6 end-to-end with no commits/pushes unless explicitly requested:
- toolchain parity bootstrap (`pnpm`/`yarn`/`npm`),
- preflight auto-fix support,
- manager-aware validation execution,
- dependency cache for repeated deploys,
- CLI deploy UX flags and preflight-only flow,
- tests and review loop until clean.

## Constraints
- Follow existing patterns from Phases 1-5.
- Preserve git/workspace hygiene; do not revert unrelated changes.
- No destructive git commands.
- No commit/push unless asked.
- Keep everything ASCII unless required.

## Required implementation steps

1. **Schema and types**
- Add migration `packages/worker/migrations/0008_workspace_toolchain_parity.sql`.
- Extend `workspace_deployments` for:
  - `toolchain_json`, `dependency_cache_key`, `dependency_cache_hit`, `remediations_json`.
- Add `workspace_dependency_caches` table and indexes per spec.
- Update worker TS types and DB mappers.

2. **Toolchain detection module**
- Implement a dedicated helper (new file under `packages/worker/src/lib/`) for:
  - reading `package.json` (`packageManager`),
  - lockfile detection (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`),
  - scripts heuristic fallback,
  - normalized profile object (`manager`, `version`, `detectedFrom`, `projectRoot`, `lockfile`).
- Add unit tests for precedence and edge cases.

3. **Runner bootstrap and manager-aware validation**
- In deployment runner:
  - detect toolchain profile early,
  - bootstrap with `corepack` when manager requires it,
  - classify failures using explicit codes:
    - `toolchain_detect_failed`,
    - `corepack_missing`,
    - `package_manager_bootstrap_failed`,
    - `validation_tool_missing`,
    - `validation_command_failed`.
  - run test/build with manager-aware commands (`pnpm`, `yarn`, `npm`).
- Emit events:
  - `deployment_toolchain_detected`,
  - `deployment_toolchain_bootstrap_started/succeeded/failed`.

4. **Preflight v2**
- Extend `POST /api/workspaces/:id/deploy/preflight` request with `autoFix`.
- Response must include:
  - `preflight.ok`,
  - `toolchain`,
  - `checks`,
  - `remediations`,
  - `nextAction`.
- Implement optional safe remediations:
  - baseline rehydrate,
  - toolchain bootstrap checks.

5. **Deploy API payload extension**
- Add optional fields in create deploy request parsing:
  - `autoFix`, `toolchain`, `cache`.
- Preserve Phase 5 defaults and backward compatibility.

6. **Dependency cache**
- Implement cache key strategy: workspace + projectRoot + manager/version + lockfile hash.
- Add best-effort restore/save flow around validation/build.
- Emit events:
  - `deployment_dependency_cache_hit/miss/saved/restore_failed`.

7. **CLI UX improvements**
- Extend `nimbus workspace deploy <id>` with:
  - `--no-tests`,
  - `--no-build`,
  - `--preflight-only`,
  - `--auto-fix`,
  - `--poll-interval-ms`.
- Improve output:
  - preflight summary,
  - remediation summary,
  - terminal failure nextAction.

8. **Docs**
- Update or add runbook docs under `specs/testing/`.
- Include one command-based smoke path using new CLI flags.

## Test requirements

Run and maintain green tests while implementing:
- Worker tests: `packages/worker` test suite.
- CLI tests: `packages/cli` test suite.

Add tests for:
- toolchain detection precedence,
- `pnpm` bootstrap success path,
- missing corepack path,
- manager-aware validation command selection,
- preflight auto-fix behavior,
- cache miss then hit behavior,
- CLI flags and preflight-only path.

## Review loop requirements
- Run `/review`.
- Fix findings.
- Re-run tests.
- Re-run `/review`.
- Repeat until no blocking bugs.

## Final handoff format
Return:
1. What was implemented.
2. Bugs found/fixed during review loop.
3. Confidence and residual risks.
4. Exact files changed.
5. Test commands run + outcomes.
