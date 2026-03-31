# Report UI Flow

## Status

- State: current-state baseline
- Last updated for: pre-refactor baseline

## Purpose

Describe how the report UI loads data, navigates user flows, and represents review lifecycle states.

## Main User Flows

- Review history browsing: the root route fetches recent reviews, groups them by `repo/branch`, computes branch-level stats, and refreshes every 3 seconds.
- Branch review browsing: the branch route filters history to a single repo/branch, supports status filters and sort direction, and links each review into either the policy page or report page depending on current state.
- Policy review and approval: the policy route polls the review until derivation is complete, lets the user edit a draft policy, and submits approval to the worker.
- Report viewing: the report route loads a single review, subscribes to live SSE while the review is active, and presents summary, findings, provenance, timeline, and event history.

## High-Level Steps

1. Route resolution
2. Data fetch / polling
3. Response parsing
4. View-model derivation
5. UI rendering
6. Navigation or action handling

Current implementation details:

1. Routing is defined in `packages/report-ui/src/App.tsx`.
2. All pages call worker APIs directly with `fetch`, using `VITE_NIMBUS_API_BASE_URL` when present.
3. `packages/report-ui/src/lib/review.ts` is the central response parser and formatter for report/history payloads.
4. `ReviewHistoryPage.tsx` and `BranchReviewsPage.tsx` both use interval polling against `GET /api/reviews`.
5. `PolicyPage.tsx` loads `GET /api/reviews/:id`, polls during `policy_pending`, derives a local editable draft from `derivedPolicy`, and posts approval to `/api/reviews/:id/policy/approve`.
6. `ReportPage.tsx` loads `GET /api/reviews/:id`, then uses `EventSource` against `/api/reviews/:id/events` while the review is active.
7. Live event messages are deduplicated into a local activity log, and terminal events trigger a full refresh of review data.
8. Report rendering includes markdown normalization, DOM sanitization, finding grouping, timeline derivation, context/provenance banners, and download/copy affordances.

## Inputs And Outputs

- Inputs:
  - route params: `reviewId`, `repo`, `branch`
  - worker JSON responses for list and detail endpoints
  - worker SSE event stream for active reviews
- Outputs:
  - branch list view
  - branch-specific review history view
  - policy editing and approval UI
  - full report UI with markdown, findings, activity log, and provenance indicators
- User-visible states:
  - loading
  - error
  - empty history
  - policy pending
  - policy ready
  - queued / running review
  - succeeded / failed / cancelled review

## Failure Modes

- Worker endpoints return errors or 404s, producing error cards or messages in the UI.
- SSE is unavailable or disconnects; `ReportPage.tsx` falls back to delayed refresh behavior.
- Report-history support may be missing on older worker deployments, in which case history pages surface an explanatory error instead of silent failure.

## Non-Regression Expectations

- Review history pages must continue distinguishing active review states from terminal states and grouping history by repo/branch.
- Policy approval must continue redirecting users from policy routes to report routes once the review advances past the policy stage.
- Report pages must continue supporting live progress updates, terminal refresh, markdown download, and JSON export without mutating backend review state.

## Current Implementation References

- `packages/report-ui/src/App.tsx`
- `packages/report-ui/src/lib/review.ts`
- `packages/report-ui/src/components/ReviewHistoryPage.tsx`
- `packages/report-ui/src/components/BranchReviewsPage.tsx`
- `packages/report-ui/src/components/PolicyPage.tsx`
- `packages/report-ui/src/components/ReportPage.tsx`

## Refactor Notes

- Separate data loading and state derivation from presentational rendering.
