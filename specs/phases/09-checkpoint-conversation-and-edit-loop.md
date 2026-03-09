# Phase 9: Checkpoint Conversation and Edit Loop

## Objective
Make checkpoint context fully conversational and editable: users can ask questions about a checkpoint state, request changes through the agent, and iterate safely in the same workspace session.

## Why this phase exists
Today, checkpoint source selection and workspace actions exist, but the "ask questions + edit + re-ask + deploy" loop is not yet a cohesive product flow.

## Product decisions (proposed final)
1. **Checkpoint as immutable anchor:** conversation always references a resolved checkpoint commit.
2. **Workspace as mutable branch:** edits occur in workspace state, never rewriting checkpoint history.
3. **Prompt provenance required:** persist prompt + model context for every mutating task.
4. **Cloudflare-first execution:** conversation tasks execute through existing workspace task runtime in Worker + Sandbox.
5. **Apply-gate required:** mutating edits require explicit apply step; no implicit file writes from ask-only calls.
6. **Deterministic review:** every apply response includes changed files + patch summary before deploy eligibility.
7. **Safety by default:** destructive intents require explicit override flag and are blocked by policy otherwise.
8. **Model continuity:** one model per conversation; no per-message model switching.
9. **Destructive definition:** delete and rename operations are destructive by default.
10. **Provenance depth:** persist full raw tool transcripts for conversation tasks.

## In scope
- Conversation/task API for checkpoint-scoped Q&A.
- Edit task types (analyze, propose, apply).
- Provenance chain linking prompts, operations, resulting diffs, and deployments.
- Guardrails for destructive edits.
- Cursor-based conversation retrieval and resume.
- Linking conversation turns to deployment provenance in final deploy record.

## Out of scope
- Autonomous long-running planning beyond configured step/time limits.
- Fine-tuned custom model hosting.

## Deliverables

### D1. Conversation model
- `workspace_conversations` and `workspace_messages` records.
- Message roles: `user|assistant|system|tool`.
- References to `checkpointId`, `commitSha`, `workspaceId`.
- Store `taskId`, `operationId`, `model`, and `policyVersion` per assistant/tool message.

### D2. Agent edit actions
- API to create conversational task from message.
- Result envelope includes:
  - proposed changes summary
  - changed file list
  - patch/diff handle
- Contracts:
  - `POST /api/workspaces/:id/conversations/:conversationId/messages`
  - `POST /api/workspaces/:id/conversations/:conversationId/tasks/:taskId/apply`
  - `GET /api/workspaces/:id/conversations/:conversationId/messages?cursor=<n>`

### D3. CLI conversational commands
- `nimbus workspace ask <workspace-id> "..."`
- `nimbus workspace apply <workspace-id> --task <id>`
- `nimbus workspace review <workspace-id> --task <id>`
- Add:
  - `nimbus workspace convo <workspace-id> --tail`
  - `nimbus workspace ask <workspace-id> "..." --checkpoint <id>`

## Acceptance criteria
- User can ask a checkpoint-scoped question and receive grounded answer with references.
- User can request and apply edits through the same conversation context.
- Diff/provenance for each edit task is inspectable before deploy.
- Applied edit tasks persist prompt + model + diff linkage queryable from deployment provenance.
- Unsafe destructive requests are blocked with policy code and actionable override guidance.

## Implementation checklist
1. Add conversation/message schema and mappers.
2. Add checkpoint-scoped ask endpoint.
3. Add edit task API + result payload contract.
4. Add CLI commands for ask/review/apply loop.
5. Add policy tests for unsafe/dangerous edit requests.
6. Add provenance linkage from message/task -> deployment.
7. Add replay tests for conversation cursor pagination.
