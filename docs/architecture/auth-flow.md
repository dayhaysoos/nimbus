# Auth Flow

## Status

- State: current-state baseline
- Last updated for: pre-refactor baseline

## Purpose

Describe the hosted authentication model, including API key usage and GitHub OIDC token exchange.

## Main Auth Paths

- Hosted API key auth: hosted worker requests use `X-Nimbus-Api-Key`, which can be either a long-lived hashed API key or a short-lived Nimbus JWT minted through OIDC exchange.
- GitHub Actions OIDC exchange: GitHub Actions requests a GitHub OIDC token for audience `nimbus`, sends it to `/api/auth/exchange`, and receives a short-lived Nimbus JWT for later worker requests.
- Admin flows: admin-scoped hosted API keys can be provisioned through the worker admin API and later used as authenticated bearer material for management actions.

## High-Level Steps

1. Caller identity source
2. Token or key validation
3. Account resolution
4. Authorization checks
5. Downstream request handling

Current implementation details:

1. `packages/worker/src/lib/auth.ts` decides whether the worker is running in hosted mode or self-hosted mode.
2. In self-hosted mode, the worker returns a synthetic authenticated admin context and skips hosted credential checks.
3. In hosted mode, a small set of paths remain public, including `/api/auth/exchange` and system readiness routes.
4. All other API paths require `X-Nimbus-Api-Key`.
5. If the key starts with `nmb_jwt_`, the worker verifies an HMAC-signed Nimbus JWT using `NIMBUS_TOKEN_SECRET` and extracts `accountId` from claims.
6. Otherwise the worker hashes the provided API key with SHA-256 and looks it up in `nimbus_api_keys`.
7. Resource handlers then enforce account scoping with account-aware helper checks such as `canAccessAccount` and resource-specific `require*Access` functions.
8. The OIDC exchange endpoint verifies the GitHub-issued OIDC token signature against GitHub JWKS, validates issuer, audience, repository, and expiration, maps the repository to a registered Nimbus account, and mints a short-lived Nimbus JWT.

## Inputs And Outputs

- Inputs:
  - `X-Nimbus-Api-Key` for hosted authenticated routes
  - GitHub OIDC token for `/api/auth/exchange`
  - repo registration records in D1 for exchange authorization
- Outputs:
  - `AuthContext` inside the worker for downstream authorization
  - short-lived Nimbus JWT from the exchange endpoint
  - health status from `/api/auth/exchange/health`
- Security-sensitive dependencies:
  - `NIMBUS_TOKEN_SECRET`
  - D1 tables for API keys and repo registrations
  - GitHub OIDC JWKS, cached in KV when available

## Failure Modes

- Hosted authenticated routes return `401` when `X-Nimbus-Api-Key` is missing or invalid.
- OIDC exchange returns `401` when token verification fails or the GitHub token does not satisfy issuer, audience, signature, or expiration checks.
- OIDC exchange returns `403` when the verified repository is not registered to a Nimbus account.

## Non-Regression Expectations

- Self-hosted mode must continue bypassing hosted credential requirements and provide an internal admin-like auth context.
- Hosted mode must continue restricting non-public API routes to authenticated callers only.
- GitHub OIDC exchange must continue requiring repository registration before minting a Nimbus JWT.

## Current Implementation References

- `packages/worker/src/lib/auth.ts`
- `packages/worker/src/api/auth.ts`
- `packages/worker/src/api/admin.ts`
- `packages/worker/src/api/repos.ts`
- `packages/cli/src/commands/auth/exchange.ts`
- `packages/cli/src/commands/auth/health.ts`
- `.github/workflows/nimbus-pr-review.yml`

## Refactor Notes

- Keep verification, authorization, and transport concerns separate. Treat security behavior as contract-sensitive.
