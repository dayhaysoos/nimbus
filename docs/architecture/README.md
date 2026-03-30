# Architecture Docs

This directory tracks the architecture of Nimbus as it exists today and as it evolves through the refactor program.

## Documents

- `overview.md`: system boundaries, package responsibilities, and cross-package relationships
- `review-flow.md`: end-to-end review lifecycle
- `workspace-flow.md`: workspace creation, inspection, reset, and deletion lifecycle
- `deployment-flow.md`: workspace deployment preflight, execution, polling, and cancellation
- `auth-flow.md`: hosted auth and GitHub OIDC exchange model
- `report-ui-flow.md`: report UI data loading, polling, routing, and user-visible states
- `adr/`: architecture decision records for major structural changes

## Current Coverage

- The overview, review-flow, workspace-flow, deployment-flow, auth-flow, and report-ui-flow documents are filled in for the current pre-refactor implementation.
- Module-level docs for key subsystems live under `docs/modules/`.

## Writing Rules

- Document current behavior first.
- Record target-state changes only when they are approved or implemented.
- Keep flow docs focused on triggers, steps, state transitions, and failure modes.
- Link to concrete source files when documenting implementation details.
- Update these docs as part of major refactors, not as an afterthought.
