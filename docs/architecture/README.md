# Architecture Docs

This directory now keeps a small, intentional set of architecture and product-planning documents.

## Read Order

1. `architecture.md`
   - Current source of truth for how Nimbus is structured today.
2. `review-studio-experience.md`
   - Locked product and UX decisions for Review Studio.
3. `review-studio-implementation-plan.md`
   - Current slice status, shipped work, open gaps, and next-slice guidance.
4. `review-studio-experience-build-plan.md`
   - Historical pre-slice build sequencing and guardrails.
5. `adr/`
   - Architecture decision records for major structural changes.

## Related Docs Outside This Directory

- `docs/modules/*`
  - Focused subsystem deep dives.
- `docs/refactor-baseline.md`
  - Historical pre-refactor verification snapshot.
- `docs/refactor-audit.md`
  - Original refactor rationale and target package direction.
- `docs/refactor-audit-phase-5.md`
  - Current refactor handoff for readability cleanup.
- `docs/jsdoc-guidelines.md`
  - JSDoc rules used during readability and refactor work.

## Why The Older Flow Docs Were Removed

The previous per-flow baseline docs had drifted behind the current CLI and worker structure.

Nimbus is easier to understand now with:

- one current-state architecture document for the broad mental model
- one stable Review Studio spec and one living Review Studio status doc
- targeted module docs only where a subsystem still needs a deeper explanation
