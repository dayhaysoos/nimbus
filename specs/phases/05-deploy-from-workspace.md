# Phase 5: Deploy From Workspace

## Objective
Make deployment a deliberate downstream action from validated workspace state.

## In scope
- Deploy source from selected workspace state.
- Persist deployment metadata on workspace/job records.
- Surface deploy status and URL in CLI/API.

## Out of scope
- Multi-target deployment matrix.
- Advanced release orchestration.

## User stories
1. As a developer, I can deploy the exact workspace state I reviewed.
2. As a developer, I can see deployment status and resulting URL.
3. As a developer, I can correlate deploy output with workspace provenance.

## Deliverables
- Worker APIs:
  - `POST /api/workspaces/:id/deploy`
  - `GET /api/workspaces/:id/deployments/:deployId`
- Deployment pipeline integration:
  - build/validate from workspace snapshot
  - publish deployed URL and artifact metadata
- CLI:
  - `nimbus workspace deploy <id>`

## Provenance requirements
- Every deployment must retain:
  - workspace ID
  - source checkpoint/commit provenance
  - diff hash or snapshot reference
  - deployment timestamp and URL

## Acceptance criteria
- Deploy endpoint uses workspace state, not stale source bundle.
- Successful deploy returns stable URL and persists metadata.
- Failed deploy records actionable diagnostics and does not corrupt workspace.

## Test plan
- Integration: workspace edit -> deploy -> verify URL and metadata chain.
- Integration: failure in build/deploy step -> correct failed state.
- Regression: existing checkpoint deploy behavior remains functional during transition.

## Rollout
- Feature flag: `workspace_deploy_enabled`.
- Shadow deploy mode optional before full enablement.

## Interview focus for this phase
- Deploy trigger policy (manual only vs agent-assisted).
- Required validations pre-deploy.
- Rollback behavior expectations.
