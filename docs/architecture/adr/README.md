# Architecture Decision Records

Use this directory to track significant architectural decisions made during the refactor.

## When To Write An ADR

Write an ADR when a change affects one or more of the following:

- package boundaries
- test strategy
- API contract shape
- persistence structure
- queue / retry / state-machine behavior
- security model
- major folder structure or naming conventions

## Naming

Use zero-padded numeric prefixes.

Examples:

- `0001-split-worker-routes-from-services.md`
- `0002-move-package-tests-into-test-directories.md`

## Required Sections

- Status
- Context
- Decision
- Consequences
- Alternatives considered

Start from `0000-template.md`.
