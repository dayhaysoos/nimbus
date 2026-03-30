# JSDoc Guidelines

## Purpose

Define when Nimbus code should receive JSDoc and when it should not.

The goal is to improve human readability without flooding the codebase with low-value comments.

## Principle

Use JSDoc where a reader would otherwise need to reverse-engineer intent, invariants, side effects, or state transitions.

Do not use JSDoc to restate obvious code.

## Add JSDoc To

### 1. Orchestration Functions

Add JSDoc to functions that coordinate multiple steps, especially when they touch state, persistence, queues, or external integrations.

Examples:

- review lifecycle handlers
- workspace lifecycle handlers
- workspace operation execution
- queue dispatch and retry paths
- deployment orchestration

### 2. Functions With Important Invariants

Add JSDoc when correctness depends on rules that are not obvious from the signature alone.

Examples:

- idempotency behavior
- auth and access assumptions
- required preconditions
- expected state transitions
- retry and timeout assumptions

### 3. Functions With Side Effects Across Boundaries

Add JSDoc when a function writes to persistence, enqueues work, mutates external systems, or depends on non-local state.

Examples:

- D1 write paths
- queue producers and consumers
- GitHub mutation flows
- sandbox mutation flows
- R2 artifact creation and deletion

### 4. Exported Functions That Define Module Behavior

If an exported function is a meaningful entrypoint for a module, it should usually have JSDoc unless the behavior is trivial.

Examples:

- public worker API handlers
- app-layer CLI flows
- review runner entrypoints
- repository functions with non-trivial semantics

### 5. Subtle Internal Functions

Internal functions should get JSDoc when they are easy to misuse or hide tricky behavior.

Examples:

- fallback resolution logic
- partial failure recovery
- branch naming / signing / token flows
- diff truncation / event replay rules

## Do Not Add JSDoc To

### 1. Tiny Obvious Helpers

Do not document helpers whose names already fully explain the behavior.

Examples:

- `parseBoolean`
- `toHex`
- `normalizeBranchRef`
- `sleep`

### 2. Mechanical Wrappers

Do not add JSDoc to thin pass-through wrappers unless they define an important contract boundary.

### 3. Comments That Only Restate Syntax

Bad examples:

- "Returns the workspace"
- "Sets the status"
- "Parses the input"

These add noise without helping readers.

## What Good JSDoc Should Explain

Good JSDoc should usually answer some combination of:

- what this function is responsible for
- what must already be true before it runs
- what it changes or persists
- what important side effects it triggers
- what special failure or retry behavior exists
- what the caller should not assume

## Preferred Style

- Keep it short.
- Prefer 2-6 lines over long blocks.
- Focus on behavior and constraints, not parameter duplication.
- Use `@param` and `@returns` only when they add clarity.
- If a function needs a huge explanation, that usually belongs in `docs/modules/` instead.

## Examples

### Good

```ts
/**
 * Requeues a stalled review if retry conditions are still valid.
 * Marks the review failed instead when retries are exhausted or auth cannot be recovered.
 */
```

```ts
/**
 * Resets sandbox contents back to the originally uploaded source bundle.
 * Preserves the workspace record and re-establishes the git baseline when possible.
 */
```

### Bad

```ts
/**
 * Gets the workspace.
 */
```

```ts
/**
 * Parses a boolean.
 */
```

## Application Rule For This Refactor

From this point forward, new or newly extracted orchestration-heavy functions should receive JSDoc where it materially improves readability.

We should not stop progress to backfill JSDoc everywhere at once.

Instead:

1. add JSDoc to meaningful new boundaries as we refactor
2. add JSDoc when touching an important function anyway
3. avoid mass comment-only churn on trivial helpers
