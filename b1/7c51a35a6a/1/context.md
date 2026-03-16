# Session Context

## User Prompts

### Prompt 1

You are starting a focused security hardening pass on Nimbus. This is not feature work — every change must be minimal, targeted, and not break existing behavior.


Work through the following in order, committing after each item. Stop and report 
after all items are complete.


## Item 1 — CI security workflows


Add two GitHub Actions workflows in `.github/workflows/`:


**`secret-scan.yml`**
- Trigger: on push and pull_request to any branch
- Use `gitleaks/gitleaks-action@v2`
- Fail the work...

### Prompt 2

Summarize the task tool output above and continue with your task.

### Prompt 3

what do you mean there were no change? You literally made commits with some new files right? I want to run a review on the branch? Explain what happened to me, don’t do anything.

### Prompt 4

Summarize the task tool output above and continue with your task.

### Prompt 5

Summarize the task tool output above and continue with your task.

### Prompt 6

Fix the request body size cap introduced in `packages/worker/src/lib/request-size.ts` and `packages/worker/src/index.ts` to be route-aware rather than a blanket global cap.


Problem: the current 5MB global cap breaks upload routes that legitimately accept 
large payloads (checkpoint/workspace source bundle uploads, up to 100MB).


Fix: instead of one global limit, apply different caps based on the route:


- Upload routes (checkpoint source bundles, workspace source uploads): 
  100MB cap — ...

### Prompt 7

Summarize the task tool output above and continue with your task.

### Prompt 8

commit it

### Prompt 9

Summarize the task tool output above and continue with your task.

### Prompt 10

Summarize the task tool output above and continue with your task.

