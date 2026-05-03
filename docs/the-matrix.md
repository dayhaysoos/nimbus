# The Matrix

## Purpose

This document maps how inference is used in Nimbus today and identifies the concrete code paths required to add another review-analysis backend without removing the existing OpenRouter path.

The intended audience is a contributor implementing a new `ReviewProvider` for review analysis and, optionally, a matching provider for policy derivation / intent summarization.

This document does not propose removing OpenRouter. It describes how to add another provider cleanly.

## High-level model

Nimbus review execution is split into two layers:

1. Review orchestration
   - Queueing
   - Durable Object handoff
   - Context assembly
   - Retry / failure handling
   - Finalization and persistence

2. Inference
   - Structured review analysis over a prepared review context
   - Optional policy / intent summarization from session prompts

Only the inference layer should need substantial provider-specific work.

## Current review execution flow

Primary review lifecycle:

1. `POST /api/reviews` or `POST /api/reviews/policy/derive`
2. Review is persisted in D1
3. Review is queued on `REVIEWS_QUEUE`
4. Queue dispatch hands off to `ReviewRunner` Durable Object
5. `ReviewRunner` executes `runReviewInlineWithRetries`
6. Review context is assembled
7. Review analysis runs
8. Findings and summary are validated, persisted, and emitted as events

Main entrypoints:

- `packages/worker/src/api/reviews/create.ts`
- `packages/worker/src/api/reviews/policy.ts`
- `packages/worker/src/lib/review-dispatch.ts`
- `packages/worker/src/review-runner-do.ts`
- `packages/worker/src/lib/review-runner.ts`
- `packages/worker/src/lib/review-runner/execution.ts`

## Inference matrix

### 1. Main review analysis path

This is the most important inference path.

Core files:

- `packages/worker/src/lib/review-analysis.ts`
- `packages/worker/src/lib/review-analysis/provider.ts`
- `packages/worker/src/lib/review-analysis/prompt.ts`
- `packages/worker/src/lib/review-analysis/tools.ts`
- `packages/worker/src/lib/review-analysis/output.ts`
- `packages/worker/src/lib/review-runner/deployment-report/analysis.ts`

What happens here:

- Nimbus hydrates a sandbox snapshot for analysis.
- It builds a review prompt from diff, files, intent, evidence, and provenance.
- It runs a deterministic evidence collection phase.
- It then enters a provider-backed loop that asks for one tool call at a time or returns final structured output.
- Provider output is schema-validated and normalized before becoming review findings.

Provider abstraction already exists:

- `ReviewAgentProvider`
- `OpenRouterReviewProvider`
- `CloudflareAgentSdkReviewProvider`

Current provider selection happens in:

- `packages/worker/src/lib/review-analysis.ts`

Current logic:

- If an OpenRouter API key is available, Nimbus uses `OpenRouterReviewProvider`.
- Otherwise it uses `CloudflareAgentSdkReviewProvider`, which calls a separate worker endpoint.

Important point:

- The current abstraction is real, but provider selection is still tied to OpenRouter-specific assumptions and env names.

### 2. Agent endpoint inference path

This is a separate worker that can act as the model backend for review analysis.

Core files:

- `packages/agent-endpoint/src/index.ts`
- `packages/agent-endpoint/src/lib/agent.ts`

What happens here:

- The main worker calls this endpoint through `CloudflareAgentSdkReviewProvider`.
- The endpoint validates auth and request shape.
- For review prompts, it currently calls OpenRouter directly.
- It validates structured output and returns the next action / final payload.

Important point:

- Even when the main worker is not directly calling OpenRouter, the bundled agent endpoint still does.
- A full provider replacement or additive backend can either:
  - update this endpoint too, or
  - bypass it and keep the new provider fully inside the main worker.

### 3. Policy derivation / intent summarization path

This is separate from the main review-analysis provider loop.

Core files:

- `packages/worker/src/api/reviews/policy.ts`
- `packages/worker/src/lib/review-runner/intent-summary.ts`

What happens here:

- Nimbus derives an intent summary from session prompts.
- That summary is converted into a review policy draft.
- If model summarization fails, Nimbus falls back to heuristic extraction.

Important point:

- A new `ReviewProvider` for the main review pass does not automatically replace policy derivation.
- Free mode can launch in stages:
  - Stage 1: new provider only for review analysis, keep existing policy behavior
  - Stage 2: add a matching provider-backed policy summarization path

### 4. Workspace task runtime

This is adjacent, but not the same feature.

Core files:

- `packages/worker/src/api/workspace-tasks.ts`
- `packages/worker/src/lib/workspace-task-runner.ts`

This powers agentic workspace tasks, not the main review report flow.

Unless the new backend is also meant to power workspace task agents, this path is not required for the first implementation of a new review-analysis provider.

## Current provider-specific assumptions

These assumptions currently leak through the codebase and should be considered when adding a new provider.

### Request / env naming

- `OPENROUTER_API_KEY`
- `X-Openrouter-Api-Key`
- `missing_openrouter_api_key`

Relevant files:

- `packages/worker/src/types.ts`
- `packages/worker/src/lib/review-analysis.ts`
- `packages/worker/src/lib/review-analysis/output.ts`
- `packages/worker/src/lib/review-runner/intent-summary.ts`
- `packages/cli/src/clients/worker/shared.ts`
- `packages/agent-endpoint/src/lib/agent.ts`

### Response parsing

OpenRouter response parsing currently expects a chat-completions style payload with:

- `choices[0].message.content`

Relevant files:

- `packages/worker/src/lib/review-analysis/provider.ts`
- `packages/worker/src/lib/review-runner/intent-summary.ts`
- `packages/agent-endpoint/src/lib/agent.ts`

### Structured output expectations

Nimbus expects structured JSON output for review findings and actions.

Relevant files:

- `packages/worker/src/lib/review-analysis/provider.ts`
- `packages/worker/src/lib/review-analysis/output.ts`
- `packages/worker/src/lib/review-output-v2.ts`
- `packages/agent-endpoint/src/lib/agent.ts`

### OpenRouter-only extras

- `response_format` with JSON schema
- `plugins: [{ id: "response-healing" }]`
- `HTTP-Referer`
- `X-Title`

These are convenience features, not architectural requirements. A new provider can omit them if it can still produce stable structured output.

## Files a contributor should read first

If someone is implementing a new `ReviewProvider`, start here in this order:

1. `packages/worker/src/lib/review-analysis.ts`
2. `packages/worker/src/lib/review-analysis/provider.ts`
3. `packages/worker/src/lib/review-analysis/output.ts`
4. `packages/worker/src/lib/review-analysis/tools.ts`
5. `packages/worker/src/lib/review-runner/deployment-report/analysis.ts`
6. `packages/worker/src/lib/review-runner/intent-summary.ts`
7. `packages/agent-endpoint/src/lib/agent.ts`
8. `packages/worker/src/types.ts`
9. `packages/worker/wrangler.toml`

## Recommended implementation shape for a new ReviewProvider

Do not name the new class after a specific person. Keep the codebase generic.

Suggested naming:

- `CustomReviewProvider`
- `ExternalReviewProvider`
- `ThirdPartyReviewProvider`

Recommended steps:

### Step 1. Add a provider enum / explicit selection

Today, selection is mostly inferred from key presence.

Refactor toward an explicit provider choice, for example:

- `openrouter`
- `cloudflare_agent_endpoint`
- `custom`

Likely touchpoints:

- `packages/worker/src/lib/review-analysis.ts`
- `packages/worker/src/types.ts`
- `packages/worker/wrangler.toml`

Goal:

- provider selection should not depend on whether `OPENROUTER_API_KEY` happens to exist

### Step 2. Add a new provider class implementing `ReviewAgentProvider`

Target file:

- `packages/worker/src/lib/review-analysis/provider.ts`

Requirements:

- implement `next(...)`
- preserve retry semantics
- preserve timeout semantics
- preserve abort behavior
- return a valid `ReviewAgentAction`

The new provider should be responsible only for:

- issuing the API request
- parsing provider responses
- converting them into Nimbus action payloads

It should not own:

- prompt construction
- tool execution
- validation rules
- result persistence

### Step 3. Generalize provider-specific error handling

Current code uses OpenRouter-specific error names and messages.

Relevant file:

- `packages/worker/src/lib/review-analysis/output.ts`

The new path should avoid baking provider names into shared error helpers.

Suggested refactor:

- introduce provider-neutral helpers for auth failure, timeout, malformed response, and retryable upstream failure

### Step 4. Wire provider selection into the analysis stage

Current entry:

- `packages/worker/src/lib/review-runner/deployment-report/analysis.ts`

This layer currently determines whether review analysis is enabled and records provider names in events.

Contributor should update:

- provider name emitted in events
- enablement rules
- how request-scoped overrides and env defaults are resolved

### Step 5. Decide whether the agent endpoint is in or out

Two valid approaches exist.

Approach A: keep everything in the main worker

- Add the new provider only in `packages/worker/src/lib/review-analysis/provider.ts`
- Do not route through `packages/agent-endpoint`
- Simplest path for a first iteration

Approach B: also make the separate agent endpoint support the new backend

- Update `packages/agent-endpoint/src/lib/agent.ts`
- Add a generic provider call path there as well
- Useful if the architecture wants model access isolated behind the endpoint

Recommended first pass:

- Approach A

It has fewer moving parts and avoids maintaining two provider integrations immediately.

### Step 6. Add or defer policy summarization support

If free mode should also support policy derivation with the new backend, update:

- `packages/worker/src/lib/review-runner/intent-summary.ts`

If not, the current fallback behavior is acceptable for an incremental launch:

- model-backed summarization may fail
- heuristic fallback still produces a policy draft when possible

This is a product choice, not just a technical one.

## Likely minimum code paths for a first useful implementation

If the goal is "add a new review-analysis provider with minimal blast radius", the likely minimum set is:

- `packages/worker/src/lib/review-analysis/provider.ts`
- `packages/worker/src/lib/review-analysis.ts`
- `packages/worker/src/lib/review-runner/deployment-report/analysis.ts`
- `packages/worker/src/types.ts`
- `packages/worker/wrangler.toml`

Optional in phase 2:

- `packages/worker/src/lib/review-runner/intent-summary.ts`
- `packages/agent-endpoint/src/lib/agent.ts`
- `packages/cli/src/clients/worker/shared.ts`

## What the new provider must be able to do

At minimum, the provider should support:

- one prompt in, one structured action out
- stable JSON output
- enough context window for review prompts and history
- request timeout handling
- retryable failure detection
- explicit auth failure detection

For best results, it should also support:

- schema-constrained output or equivalent reliability guarantees
- deterministic JSON formatting
- low malformed-output rate

## Product guidance for a "free mode"

If the new backend is being added as a free path rather than a full replacement, keep the design server-side.

Recommended shape:

- worker decides provider based on account / mode / feature flag
- CLI stays mostly unchanged
- free users do not need to supply their own inference key
- provider choice is persisted in review metadata or events for observability

Avoid:

- forcing users to set provider-specific env vars in the CLI for hosted free mode
- silently switching providers without emitting which backend ran

## Suggested rollout order

1. Add provider enum and selection plumbing
2. Add new `ReviewAgentProvider` implementation
3. Wire it into main review analysis
4. Emit provider choice in lifecycle events
5. Test review creation and terminal output on the new path
6. Decide whether policy derivation should also use the new backend
7. Optionally generalize the separate agent endpoint

## Open questions the contributor should answer before coding

1. Is the new backend called directly from the main worker, or through a separate service?
2. Does it support structured JSON/schema output well enough for current validation expectations?
3. Does free mode apply only to review analysis, or also to policy derivation?
4. How is provider choice determined:
   - env flag
   - account feature flag
   - request field
   - hosted-plan routing
5. What rate limits or abuse controls are required for the free path?

## Final recommendation

For a first contribution, implement a new provider in the main worker review-analysis path and keep the rest of the architecture stable.

That gives Nimbus:

- additive provider support
- minimal disruption to existing OpenRouter users
- a clean place to route free-mode reviews

Only after that should the contributor decide whether to mirror the same provider into:

- policy summarization
- the separate `nimbus-agent-endpoint`
- workspace task agent runtime
