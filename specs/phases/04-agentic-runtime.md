# Phase 4: Agentic Runtime

## Objective
Enable autonomous or guided agent tasks to modify workspace code safely and observably.

## In scope
- Agent task model and queue/workflow execution.
- Tool surface for agent actions against workspace.
- Streaming task events and durable task logs.
- Guardrails for command/file operations.

## Out of scope
- Full generalized multi-agent marketplace.
- Unbounded shell access.
- Human approval UX beyond minimal endpoint hooks.

## User stories
1. As a developer, I can ask an agent to apply changes in my workspace.
2. As a developer, I can watch progress and inspect outputs/errors.
3. As a developer, I can review resulting diff before export/fork.

## Deliverables
- D1 schema additions:
  - `workspace_tasks`
  - `workspace_task_events`
- Worker APIs:
  - `POST /api/workspaces/:id/tasks`
  - `GET /api/workspaces/:id/tasks/:taskId`
  - `GET /api/workspaces/:id/tasks/:taskId/events`
  - `POST /api/workspaces/:id/tasks/:taskId/cancel`
- Agent execution runtime:
  - queue-backed runner and retry policy
  - optional Workflows integration for durable multi-step runs
- Tooling contract:
  - read/write/list files
  - run constrained commands
  - request diff summary

## Safety and policy
- Explicit allowlist for commands.
- Denylist for high-risk operations.
- Path sandboxing under workspace root.
- Secret-aware output filtering.
- Hard limits on runtime, memory, and output volume.

## Acceptance criteria
- Agent task can complete successful code edits with event trace.
- Cancellation works and leaves workspace in coherent state.
- Policy violations are blocked with clear error codes.
- Re-running same idempotent task key does not duplicate side effects.

## Test plan
- Unit: policy enforcement and tool argument validation.
- Integration: task create -> run -> diff produced.
- Integration: task cancel path and cleanup behavior.
- Chaos/failure tests: transient sandbox failures and retry behavior.

## Rollout
- Feature flag: `workspace_agent_runtime_enabled`.
- Begin with internal models/prompts and curated tool policy.

## Interview focus for this phase
- Agent autonomy level (fully autonomous vs approval checkpoints).
- Model/provider choices per task type.
- Retry/idempotency policy and failure classification.
