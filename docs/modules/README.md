# Module Docs

This directory is for focused subsystem and module documentation.

Use it for areas that remain complex even after refactoring, especially where correctness depends on nuanced sequencing, retries, state transitions, or provider behavior.

## Good Candidates

- review context assembly
- review execution and retries
- workspace deployment execution
- sandbox hydration and file access
- auth token exchange

## Current Module Docs

- `review-execution.md`
- `workspace-deployment.md`
- `auth-exchange.md`
- `report-ui-report-page.md`

## Rules

- Prefer one document per subsystem, not one document per small helper.
- Document behavior, boundaries, invariants, and failure modes.
- Include source references.
- Add local doc comments in code for subtle functions, but keep the long-form explanation here.

Start from `module-template.md`.
