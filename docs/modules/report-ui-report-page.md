# Module: Report UI Report Page

## Status

- State: current-state baseline
- Owner: `packages/report-ui/src/components/ReportPage.tsx`

## Purpose

Render the detailed review experience for a single review, including live progress, summary metadata, findings, provenance banners, activity log, timeline, and export/copy actions.

## Boundaries

- Inputs:
  - route params for `reviewId`, optional `repo`, optional `branch`
  - review detail payload from worker API
  - review SSE stream while review is active
- Outputs:
  - rendered report UI
  - local download/copy actions
  - navigation back to branch context
- External dependencies:
  - worker review APIs
  - browser `EventSource`
  - markdown parsing and sanitization libraries
- Things this module must not own:
  - backend review execution
  - cross-package contract decisions
  - durable state beyond local page state

## Important Concepts

- Live states: `policy_pending`, `policy_ready`, `policy_approved`, `queued`, and `running` are treated as active states for live refresh.
- Activity log: SSE events are normalized into user-readable event labels and deduplicated locally.
- Timeline: derived entirely from review timestamps and status, not from a separate backend timeline model.
- Markdown summary normalization: the page strips or renames some sections before rendering and sanitizing HTML.

## Core Flow

1. Load review details from `/api/reviews/:id`.
2. If the review is active, subscribe to `/api/reviews/:id/events` via `EventSource`.
3. Deduplicate and append event log entries while opportunistically updating local status.
4. Refresh full review payload when terminal status is observed.

## Invariants

- The page must remain safe when markdown is rendered, using sanitization before injecting HTML.
- Live event consumption must not duplicate the visible activity log excessively.
- Terminal event observation must trigger a detail refresh so the final persisted report is shown.

## Failure Modes

- Initial load fails and the page enters the error state.
- SSE fails or is unavailable, causing fallback delayed refresh behavior.
- Review payload contains little or no markdown, in which case the page still renders findings and metadata.

## Source References

- `packages/report-ui/src/components/ReportPage.tsx`
- `packages/report-ui/src/lib/review.ts`
- `packages/worker/src/api/reviews.ts`

## Notes For Future Refactors

- Split data loading, SSE handling, timeline derivation, markdown preparation, and presentation into separate feature modules.
- Keep user-visible behavior stable while decomposing the page.
