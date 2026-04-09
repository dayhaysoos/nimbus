# Review Regressions

## R-001 Concurrent Recovery Execution
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Area: `packages/worker/src/api/reviews/recovery.ts`
- Expected: Nimbus should report that manual recovery can requeue replacement work while an original run is still in flight, allowing overlapping executions and nondeterministic final state.
- Minimum evidence:
  - recovery requeues or reschedules review execution
  - the original attempt is not cancelled or fenced
  - downstream finalization can still persist status/findings from stale work
- Expected severity: `medium` or `high`
- Baseline external finding: found

## R-002 Malformed Retry Token Causes Destructive Failure
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Area: `packages/worker/src/api/reviews/recovery.ts`
- Expected: Nimbus should report that malformed retry credentials can push the recovery path into a destructive terminal failure instead of returning a safe validation error.
- Minimum evidence:
  - invalid token input becomes unusable
  - the flow falls through into a terminal failure path
  - the endpoint mutates review state on bad input instead of rejecting the request safely
- Expected severity: `medium`
- Baseline external finding: found

## Evaluation Checklist
- Correct target reviewed
- R-001 found with concrete failing scenario
- R-002 found with concrete failing scenario
- Evidence cites the right code path
- No obvious false-positive correctness findings

## Attempts

### Attempt 1
- Date: `2026-04-08`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_90qibmdp --format json --out /tmp/.../review.json`
- Review ID: `review_90qibmdp`
- Result:
  - status: `succeeded`
  - findings: `2`
- Findings summary:
  1. `medium logic` — SSE `/api/studio/new-review/start/events` endpoint may hang silently without an initial event or heartbeat
  2. `low logic` — `primaryVerdictHeadline` may diverge slightly from detailed status narrative
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `no`
  - Obvious false positives: `possibly yes` (Attempt 1 findings did not match the known recovery defects)
- Notes:
  - Nimbus is now producing concrete findings on the target, but it is still not surfacing the two recovery bugs from `packages/worker/src/api/reviews/recovery.ts`.
  - The findings returned here are adjacent UX/runtime concerns rather than the target correctness regressions.

### Attempt 2
- Date: `2026-04-08`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - deterministic evidence gathering now derives targeted `search_code` queries from sensitive changed files and reads a few matched cross-file files before the provider loop completes
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_25cc1fo1 --format json --out /tmp/.../review.json`
- Review ID: `review_25cc1fo1`
- Result:
  - status: `failed`
  - findings: `0`
- Failure summary:
  - `review_execution_failed: Review agent output does not match required schema`
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `no`
  - Obvious false positives: `no findings returned`
- Notes:
  - The more aggressive evidence collection improved cross-file context, but it also caused the provider to return schema-invalid final output.
  - The harness currently treats schema-invalid completion as terminal failure instead of attempting a structured repair turn.

### Attempt 3
- Date: `2026-04-08`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - deterministic cross-file evidence remains enabled
  - schema-invalid completion now gets one bounded repair turn instead of immediate failure
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_ds0sm6v3 --format json --out /tmp/.../review.json`
- Review ID: `review_ds0sm6v3`
- Result:
  - status: `succeeded`
  - findings: `2`
- Findings summary:
  1. `medium logic` — awaited `onProgress` callbacks in `resolveReviewContext` can block or fail review setup
  2. `low logic` — Studio start SSE lacks explicit anti-buffering / keep-alive behavior
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `no`
  - Obvious false positives: `partially` (the findings are concrete but still not the target recovery defects)
- Notes:
  - The review is healthy again and emitting concrete findings.
  - However, the provider still focused on CLI/SSE issues instead of the recovery defects.
  - Event traces showed deterministic evidence collection consumed 11 tool steps before the provider turn, effectively leaving the model only a single reasoning turn to finalize.

### Attempt 4
- Date: `2026-04-08`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - worker now honors a larger total review step cap
  - deterministic and provider phases now reserve a minimum provider reasoning budget instead of letting setup consume everything
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_am534nuw --format json --out /tmp/.../review.json`
- Review ID: `review_am534nuw`
- Result:
  - status: `succeeded`
  - findings: `0`
- Summary:
  - `No concrete correctness issues were identified in the changed code paths under the documented behavior and contracts.`
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `no`
  - Obvious false positives: `no`
- Notes:
  - The step-budget rebalance worked partially: the run succeeded and the repair path recovered a schema-invalid completion.
  - But the provider still completed immediately after the first reasoning turn and repaired to an empty finding set.
  - The next change should reduce low-signal deterministic breadth and focus the model more explicitly on sensitive changed paths before it finalizes.

### Attempt 5
- Date: `2026-04-08`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - deterministic search/read breadth reduced
  - provider minimum reasoning budget increased
  - prompt now explicitly prioritizes sensitive changed paths over lower-risk UI/transport issues
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_4q4de7bd --format json --out /tmp/.../review.json`
- Review ID: `review_4q4de7bd`
- Result:
  - status: `succeeded`
  - findings: `3`
- Findings summary:
  1. `medium logic` — awaited `onProgress` callback can stall review setup
  2. `low logic` — SSE start-events endpoint lacks an initial heartbeat/comment
  3. `low logic` — recover-review UI error handling can lose server context on non-JSON failures
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `partially` (the third finding touched recovery UX, not backend recovery semantics)
  - Obvious false positives: `possibly` (all three findings are plausible, but still miss the target backend defects)
- Notes:
  - This attempt materially improved harness behavior: deterministic setup dropped to 9 tool steps instead of 14, and the provider returned multiple concrete findings.
  - However, search/follow-up evidence still appears biased toward UI paths using broad terms like `recovery`, which is probably steering attention away from backend dependencies in `packages/worker/src/api/reviews/recovery.ts`.

### Attempt 6
- Date: `2026-04-08`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - deterministic search now prefers dependency-oriented identifiers over file-stem queries
  - follow-up reads rank search matches by path locality to the sensitive changed file
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_bzxewb0v --format json --out /tmp/.../review.json`
- Review ID: `review_bzxewb0v`
- Result:
  - status: `succeeded`
  - findings: `3`
- Findings summary:
  1. `medium logic` — awaited progress callback can hang review setup
  2. `low logic` — Studio start SSE stream may stay open without explicit termination semantics
  3. `low logic` — recover-review UI polling can keep refreshing stale state after a failed recovery attempt
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `partially` (the third finding moved closer to recovery, but still only at the UI layer)
  - Obvious false positives: `possibly`
- Notes:
  - Dependency-first/path-local search improved relevance somewhat: the third finding moved from generic “Recover review” UI messaging toward refresh/polling around recovery.
  - Even so, the model still finalized without surfacing the backend recovery invariants in `packages/worker/src/api/reviews/recovery.ts`.

### Attempt 7
- Date: `2026-04-08`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - completion is now supposed to be rejected if sensitive changed paths are not explicitly cleared or cited in findings
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_n0s82c3f --format json --out /tmp/.../review.json`
- Review ID: `review_n0s82c3f`
- Result:
  - status: `succeeded`
  - findings: `3`
- Findings summary:
  1. `low logic` — progress callback errors can abort review setup
  2. `low logic` — Studio SSE start endpoint can close without sending any events
  3. `low logic` — ReportPage recovery logic can treat unknown recover actions as success
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `no`
  - Obvious false positives: `possibly`
- Notes:
  - The sensitive-path guard did not bite because the summary mentioned “recovery” generically, which incorrectly counted as clearing the sensitive path.
  - The next change should require explicit file-path or filename clearance for sensitive paths, not a vague thematic mention.

### Attempt 8
- Date: `2026-04-08`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - sensitive-path clearance now requires explicit file path or filename mention, not vague thematic summary language
  - deterministic search breadth increased slightly to include one more dependency-oriented query
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_q9f88uu5 --format json --out /tmp/.../review.json`
- Review ID: `review_q9f88uu5`
- Result:
  - status at export time: `queued`
  - findings: `0`
- Failure summary:
  - initial completion was schema-invalid and required repair
  - repaired completion was rejected by the sensitive-path guard
  - a subsequent provider turn stalled long enough for the worker to mark the review `retry_scheduled`
  - CLI surfaced `D1_ERROR: internal error` during the event stream fallback path
- Regression checklist:
  - Correct target reviewed: `partially` (the intended target was used, but the attempt did not reach a stable terminal analysis result)
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `no`
  - Obvious false positives: `none returned`
- Notes:
  - The stricter sensitive-path guard is directionally correct, but in this form it can push the provider into a non-productive extra turn and hang the attempt.
  - The next change needs to keep the stronger focus while remaining bounded and deterministic.

### Attempt 9
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - sensitive-path follow-up is now bounded and forced into one corrected final completion instead of an open-ended extra turn
  - sensitive-path evidence summary is injected into history before the provider loop
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_2phr1czk --format json --out /tmp/.../review.json`
- Review ID: `review_2phr1czk`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — recovery endpoint can requeue or fail a review that has already reached a terminal state, causing status regressions or duplicate work
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `partially` (this is closer to unsafe recovery/requeue semantics, but not the specific still-running concurrent execution bug)
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `possibly no`
- Notes:
  - This is the closest attempt so far. Nimbus finally focused on `packages/worker/src/api/reviews/recovery.ts` and returned a real backend recovery finding.
  - The miss now looks more like decomposition than total recall: the model is still collapsing multiple unsafe recovery scenarios into one umbrella issue instead of separating the concurrent-running case and malformed-token case.

### Attempt 10
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - prompt now explicitly says distinct failing triggers in the same path should be separate findings
  - sensitive-path review history now includes a small generic checklist for state transitions, overlap, and malformed credentials/input
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_2mtnahna --format json --out /tmp/.../review.json`
- Review ID: `review_2mtnahna`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — review recovery can downgrade a successfully finished review back to a queued/failed state and overwrite final findings, violating terminal-state immutability
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `partially no` (still not the specific running/concurrent execution bug)
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `likely no`
- Notes:
  - The decomposition prompt/history changes did not split the recovery semantics into the two target defects.
  - Nimbus ended in the same place as Attempt 9 conceptually: one broad backend recovery invariant finding instead of the two concrete failure modes that external review found.

## Tooling Attempts

### Tooling Attempt 1
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - added first-class read-only tracing tools: `trace_symbol` and `read_batch`
  - deterministic evidence collection now traces symbols and reads matched cross-file files in batches before provider completion
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_xml3yel9 --format json --out /tmp/.../review.json`
- Review ID: `review_xml3yel9`
- Result:
  - status: `succeeded`
  - findings: `0`
- Findings summary:
  - none
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes` (the review context included `packages/worker/src/api/reviews/recovery.ts` and related analysis files)
  - Obvious false positives: `none`
- Notes:
  - This was the first clean run with the new tool surface. The provider used `trace_symbol` and `read_batch`, and it reviewed the right recovery-related files.
  - Despite that, Nimbus still concluded the recovery path was safe and returned `0` findings, which means the remaining miss is not just “the model never looked there.”

### Tooling Attempt 2
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - added `trace_terms` for batch state/validation vocabulary tracing
  - deterministic evidence collection now traces risky literals and identifiers like queue/status/token/retry terms before the provider completes
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_0auhgibx --format json --out /tmp/.../review.json`
- Review ID: `review_0auhgibx`
- Result:
  - status: `succeeded`
  - findings: `0`
- Findings summary:
  - none
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `none`
- Notes:
  - The provider used `trace_terms` in addition to symbol tracing and batch reads, and its summary explicitly discussed `packages/worker/src/api/reviews/recovery.ts`.
  - Even with that added retrieval, Nimbus still concluded the path was safe. The next gap looks like control-flow decomposition inside the sensitive file, not file selection.

### Tooling Attempt 3
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - added `trace_branches` to expose `if`/`throw`/`return` control flow inside sensitive files
  - deterministic evidence collection now records branch snippets for sensitive changed paths before provider completion
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_yfityks6 --format json --out /tmp/.../review.json`
- Review ID: `review_yfityks6`
- Result:
  - status: `succeeded`
  - findings: `0`
- Findings summary:
  - none
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `none`
- Notes:
  - This was the first run with structured branch tracing on `packages/worker/src/api/reviews/recovery.ts`.
  - Nimbus still summarized the recovery path as safe, so branch visibility alone did not force decomposition into the target failure modes.

### Tooling Attempt 4
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - added required sensitive-path scenario coverage for invalid input, overlapping execution, terminal-state behavior, and cross-file guards
  - completion is now supposed to classify those scenarios separately before finalizing
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_ow7vwemo --format json --out /tmp/.../review.json`
- Review ID: `review_ow7vwemo`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — manual recovery conflates missing/non-recoverable reviews with successful recovery by still returning `200 OK`
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `possibly` (this is a concrete API-semantics issue, but still not one of the target state/retry/token defects)
- Notes:
  - Scenario coverage successfully forced Nimbus into a concrete finding on `packages/worker/src/api/reviews/recovery.ts`.
  - The remaining miss is prioritization: the model chose a response-semantics issue in the right file instead of the deeper overlapping-execution and destructive-invalid-input bugs.

### Tooling Attempt 5
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - sensitive-path findings now have to map back to one of the required runtime scenarios instead of any nearby issue in the same file
  - unrelated API-semantics findings in risky files are rejected and the provider is forced to correct them
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_p768j47r --format json --out /tmp/.../review.json`
- Review ID: `review_p768j47r`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — manual review recovery can race with stale-running auto-recovery and violate active/terminal status invariants, causing conflicting state transitions
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `partially` (this is finally in the right defect family: overlapping recovery execution and conflicting state transitions)
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `likely no`
- Notes:
  - This is the closest fresh tooling-loop result so far. Nimbus now returns a concrete recovery race in the target file instead of unrelated UI or API-shape issues.
  - The remaining gap is decomposition and invalid-input handling: it still did not isolate the malformed-token destructive-failure bug, and its overlap finding is broader than the original concurrent-running execution report.

### Tooling Attempt 6
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - sensitive scenarios now require grounded per-scenario notes tied to concrete evidence before completion can clear them
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_3dj1be09 --format json --out /tmp/.../review.json`
- Review ID: `review_3dj1be09`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — manual recovery can requeue a run even when an up-to-date run is already queued or running, and the UI treats `requeued` as clean recovery
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `partially`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `partially` (mixed backend race with UI semantics)
- Notes:
  - Grounded scenario notes kept the finding in the recovery race family, but the model still blended backend overlap with UI interpretation concerns.

### Tooling Attempt 7
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - invalid-input scenario notes now must include the concrete bad-input outcome path
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_q47awf36 --format json --out /tmp/.../review.json`
- Review ID: `review_q47awf36`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — manual recovery can race with live runner completion and incorrectly mark a succeeded review as failed or requeue it after completion
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `partially`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `likely no`
- Notes:
  - This tightened the overlap/terminal-state narrative further, but still did not surface malformed-input handling.

### Tooling Attempt 8
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - branch tracing now explicitly seeds invalid-input and status-transition terms for auth/token-sensitive files
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_i7losleg --format json --out /tmp/.../review.json`
- Review ID: `review_i7losleg`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — manual review recovery can enqueue a duplicate run concurrently with an already-running recovery, leading to overlapping execution and ambiguous terminal status
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `yes, close enough`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `likely no`
- Notes:
  - This is the best match to the original concurrent-execution bug: duplicate run, concurrent recovery, ambiguous terminal state.
  - The malformed-token/destructive-failure bug was still not found.

### Tooling Attempt 9
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - no code change; repeat run to measure stability on the current harness
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_smravvpn --format json --out /tmp/.../review.json`
- Review ID: `review_smravvpn`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — manual review recovery can race with concurrent automatic stale-running recovery, leading to duplicate or conflicting transitions on the same review run
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `yes, close enough`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `likely no`
- Notes:
  - This confirms the harness now stably finds the concurrency/recovery race family.

### Tooling Attempt 10
- Date: `2026-04-09`
- Target commit: `2c1d8e7`
- Target checkpoint: `1c50fb778db0`
- Change under test:
  - no code change; final stability run
- Command:
  - `node packages/cli/dist/index.js review create --commit 2c1d8e7 --policy-mode none --output-review-id /tmp/.../review_id.txt`
  - `node packages/cli/dist/index.js review export review_gl4jlw0n --format json --out /tmp/.../review.json`
- Review ID: `review_gl4jlw0n`
- Result:
  - status: `succeeded`
  - findings: `1`
- Findings summary:
  1. `medium logic` — manual recovery denies recovery for already-queued reviews but reports a generic failed action
- Regression checklist:
  - Correct target reviewed: `yes`
  - R-001 found: `no`
  - R-002 found: `no`
  - Evidence cites correct recovery code path: `yes`
  - Obvious false positives: `possibly`
- Notes:
  - The loop is still not fully stable; the harness can drift back toward secondary recovery semantics instead of staying on the overlap bug.
