# Architecture Docs

This directory now keeps a small, intentional set of architecture and product-planning documents.

## Read Order

1. `architecture.md`
   - Current source of truth for how Nimbus is structured today.
2. `review-session-pivot.md`
   - Active product-direction and implementation handoff for the session-based review redesign, including the local-first branch/worktree return path.
3. `review-studio-experience.md`
   - Locked product and UX decisions for the current Review Studio model.
4. `review-studio-implementation-plan.md`
   - Current shipped-state snapshot for the existing Review Studio implementation.
5. `review-studio-experience-build-plan.md`
   - Historical pre-slice build sequencing and guardrails.
6. `adr/`
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
- one active review-session pivot document for the redesign direction
- one stable Review Studio spec and one living Review Studio status doc
- targeted module docs only where a subsystem still needs a deeper explanation
