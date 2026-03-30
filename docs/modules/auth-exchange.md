# Module: Auth Exchange

## Status

- State: current-state baseline
- Owner: `packages/worker/src/api/auth.ts` and `packages/worker/src/lib/auth.ts`

## Purpose

Allow trusted GitHub Actions workflows to exchange a GitHub OIDC token for a short-lived Nimbus JWT that can authenticate later hosted worker requests.

## Boundaries

- Inputs:
  - GitHub OIDC token
  - repository registration mapping
  - token secret and optional KV cache binding
- Outputs:
  - Nimbus JWT
  - auth exchange health report
  - worker `AuthContext` when Nimbus JWTs are later presented
- External dependencies:
  - GitHub OIDC JWKS endpoint
  - KV cache for JWKS
  - D1 registrations table
- Things this module must not own:
  - repo registration workflow itself
  - PR review workflow logic
  - non-auth worker business rules

## Important Concepts

- Hosted mode vs self-hosted mode: hosted mode enforces credentials; self-hosted mode bypasses them.
- Repository registration: exchange is allowed only when the verified repo slug is already mapped to a Nimbus account.
- Nimbus JWT: a short-lived HMAC-signed token that later travels in `X-Nimbus-Api-Key` with `nmb_jwt_` prefix.

## Core Flow

1. GitHub Actions obtains an OIDC token for audience `nimbus`.
2. The CLI posts the token to `/api/auth/exchange`.
3. The worker verifies signature, issuer, audience, repo claim, and expiration.
4. The worker maps the repository to an account and mints a Nimbus JWT.

## Invariants

- Exchange must require a valid GitHub-issued RS256 token.
- Exchange must require audience `nimbus`.
- Exchange must refuse unregistered repositories.

## Failure Modes

- Token verification fails because JWKS retrieval, signature verification, or claim validation fails.
- The repository claim is valid but not registered to any Nimbus account.
- `NIMBUS_TOKEN_SECRET` is missing, making exchange unavailable.

## Source References

- `packages/worker/src/api/auth.ts`
- `packages/worker/src/lib/auth.ts`
- `packages/cli/src/commands/auth/exchange.ts`
- `packages/cli/src/commands/auth/health.ts`
- `.github/workflows/nimbus-pr-review.yml`

## Notes For Future Refactors

- Keep JWT minting, GitHub OIDC verification, and downstream request authentication in separate modules.
- Treat exchange behavior as security-sensitive and contract-sensitive.
