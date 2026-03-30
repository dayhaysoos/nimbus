# Nimbus Refactor Baseline

## Purpose

This document records the repo state immediately before major refactor work begins.

It is the reference point for answering two questions during the cleanup:

- Was this behavior already broken before the refactor?
- What is the minimum command set we should use to verify changes safely?

## Snapshot

- Date: 2026-03-30
- Git branch: `huge-refactor`
- Worktree status at sweep time: only new documentation files were untracked

## Package Scripts

### Root

- `pnpm build`
- `pnpm test:report-ui`

### `packages/worker`

- `pnpm --filter @dayhaysoos/nimbus-worker test`
- No dedicated `build` script
- Standalone typecheck command used for baseline: `pnpm --filter @dayhaysoos/nimbus-worker exec tsc -p tsconfig.json --noEmit`

### `packages/cli`

- `pnpm --filter @dayhaysoos/nimbus test`
- `pnpm --filter @dayhaysoos/nimbus build`

### `packages/agent-endpoint`

- `pnpm --filter @dayhaysoos/nimbus-agent-endpoint test`
- No dedicated `build` script
- Standalone typecheck command used for baseline: `pnpm --filter @dayhaysoos/nimbus-agent-endpoint exec tsc -p tsconfig.json --noEmit`

### `packages/report-ui`

- `pnpm --filter @dayhaysoos/nimbus-report-ui test`
- `pnpm --filter @dayhaysoos/nimbus-report-ui build`

## Baseline Results

### Tests

- Worker tests: pass
  - Command: `pnpm --filter @dayhaysoos/nimbus-worker test`
  - Result: `All tests passed (31)`
- CLI tests: pass
  - Command: `pnpm --filter @dayhaysoos/nimbus test`
  - Result: `All tests passed (17)`
- Agent endpoint tests: pass
  - Command: `pnpm --filter @dayhaysoos/nimbus-agent-endpoint test`
  - Result: `All tests passed (2)`
- Report UI tests: pass
  - Command: `pnpm --filter @dayhaysoos/nimbus-report-ui test`
  - Result: `3` test files passed, `18` tests passed

### Build / Typecheck

- Root build: pass
  - Command: `pnpm build`
  - Result: built `report-ui` and `cli` successfully
- Agent endpoint standalone typecheck: pass
  - Command: `pnpm --filter @dayhaysoos/nimbus-agent-endpoint exec tsc -p tsconfig.json --noEmit`
- Worker standalone typecheck: fail
  - Command: `pnpm --filter @dayhaysoos/nimbus-worker exec tsc -p tsconfig.json --noEmit`
  - Errors:
    - `packages/worker/src/lib/workspace-deployment-runner.ts:279`
    - `packages/worker/src/lib/workspace-deployment-runner.ts:280`
    - `packages/worker/src/lib/workspace-deployment-runner.ts:287`
    - `packages/worker/src/lib/workspace-deployment-runner.ts:288`
  - Error class: `TS2591 Cannot find name 'Buffer'`

## Important Pre-Existing Findings

### 1. Worker tests pass, but worker standalone typecheck does not

This is the most important baseline finding.

The worker package test config includes Node types in `packages/worker/tsconfig.test.json`, but the main worker tsconfig only includes Cloudflare worker types in `packages/worker/tsconfig.json`.

That means the package currently has a split baseline:

- test suite: green
- standalone package typecheck: red

Any future refactor in the worker should be evaluated against this known pre-existing gap so we do not falsely attribute it to refactor work.

### 2. Custom test runners are still part of the baseline

Current package test entrypoints:

- `packages/worker/src/lib/run-tests.ts`
- `packages/cli/src/lib/run-tests.ts`
- `packages/agent-endpoint/src/lib/run-tests.ts`

This matters because test migration will change package-level verification behavior, not just file locations.

### 3. Report UI tests emit React Router future warnings

These warnings did not fail the suite during the baseline run.

They should be treated as pre-existing noise unless we choose to address them deliberately.

## Recommended Verification Set During Refactor

### Minimum package-level checks

- CLI changes:
  - `pnpm --filter @dayhaysoos/nimbus test`
  - `pnpm --filter @dayhaysoos/nimbus build`
- Report UI changes:
  - `pnpm --filter @dayhaysoos/nimbus-report-ui test`
  - `pnpm --filter @dayhaysoos/nimbus-report-ui build`
- Agent endpoint changes:
  - `pnpm --filter @dayhaysoos/nimbus-agent-endpoint test`
  - `pnpm --filter @dayhaysoos/nimbus-agent-endpoint exec tsc -p tsconfig.json --noEmit`
- Worker changes:
  - `pnpm --filter @dayhaysoos/nimbus-worker test`
  - Optional: `pnpm --filter @dayhaysoos/nimbus-worker exec tsc -p tsconfig.json --noEmit`
  - Note: the standalone worker typecheck is currently known-red and should not be used as a new regression signal until fixed intentionally

### Whole-repo checks

- `pnpm build`
- package-specific tests for touched areas

## Baseline Conclusion

The repo starts this refactor program in a mostly healthy state:

- all existing package test suites are green
- root build is green
- one standalone worker typecheck command is already red before refactor work begins

This is a good baseline for incremental cleanup because the main application behavior appears stable, while at least one real pre-existing type-safety issue is now explicitly recorded.
