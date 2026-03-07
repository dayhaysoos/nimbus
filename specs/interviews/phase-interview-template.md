# Phase/Slice Interview Template

Use this template before implementation for each phase or slice.

## 1) Outcome and user flow
- What is the exact user-visible outcome for this phase?
- What starts the flow?
- What determines success/failure from the user perspective?

## 2) Scope boundaries
- In-scope behaviors (must ship now):
- Explicit non-goals (defer):
- Dependencies on prior phases:

## 3) Data and contracts
- New/changed DB tables and fields:
- New/changed API endpoints:
- Request/response schemas:
- Idempotency and deduping requirements:

## 4) State machine and failure semantics
- States and transitions:
- Terminal states:
- Retryable vs non-retryable errors:
- Compensation/cleanup behavior:

## 5) Security and permissions
- Who is authorized to invoke this flow?
- Credential sources and required scopes:
- Sensitive data handling and redaction:
- Allowed vs disallowed operations:

## 6) Observability and operations
- Required events/logs/metrics:
- User-facing progress updates:
- Alert thresholds and operational dashboards:

## 7) Testing strategy
- Unit tests to add:
- Integration tests to add:
- End-to-end manual verification steps:
- Regression areas to re-validate:

## 8) Rollout and migration
- Feature flags:
- Backward compatibility constraints:
- Data migration steps:
- Rollout stages and rollback plan:

## 9) Acceptance checklist
- [ ] API contracts stable and documented
- [ ] Tests pass and cover primary failure paths
- [ ] Security review items addressed
- [ ] Metrics/events visible in logs
- [ ] CLI/API UX reviewed

## 10) Open questions to resolve now
-
-
-
