# Nimbus Restart Context

## Status

- This repository is archived.
- Do not make new product or architecture edits here.
- This document replaces every previous doc in `docs/`.
- Purpose: preserve the lessons from the failed implementation so the next `nimbus` repo can start from a cleaner foundation.

## Why We Are Restarting

Nimbus did not fail because of one isolated bug. It failed because the whole review system accumulated too many conflicting assumptions at once.

What went wrong:

1. The inference layer started in the wrong place.
   OpenRouter became the default path too early, which created provider ambiguity, header confusion, fallback drift, and a lot of control-plane complexity before the core product was even stable.

2. Long-running review execution lived in the wrong runtime shape.
   We tried to make long review turns work inside a worker-oriented execution loop, then layered retries, recovery, and provider offloading around that. The system became more operationally complicated before it became reliably useful.

3. Reliability and quality were tuned at the same time.
   We were still trying to make reviews complete at all while also trying to improve what they found. That made it hard to tell whether a change improved recall, only reduced timeouts, or merely changed the failure mode.

4. The code-substrate story was too ad hoc.
   The implementation relied on source bundles, sandbox hydration, and review-context assembly paths that were expensive, brittle, and not aligned with newer Cloudflare storage primitives.

5. There was no stable evaluation bar early enough.
   We had real examples of missed bugs, but they were documented after a lot of prompt and runtime complexity had already accumulated. That let the system drift without a hard quality floor.

6. Too much product surface moved at once.
   Review sessions, remediation, studio UX, review recovery, provider routing, and deployment validation all changed in parallel. The result was a branch that taught us a lot but is not a solid platform to keep building on.

This archive exists because the right next move is not "refactor this harder." The right next move is "start over with a much smaller contract."

## What We Keep From This Archive

We are not throwing away the lessons. We are throwing away the implementation direction.

Things worth carrying forward:

- The core product thesis: Nimbus should produce trustworthy code review outcomes, not just raw model output.
- The insight that review quality requires deliberate evidence gathering, not a blind one-shot prompt.
- The discovery that long-running review loops need durable orchestration and a better runtime boundary.
- The real missed-bug examples from this repo and branch history.
- The understanding that provider routing must be simple and explicit.
- The insight that "a review completed" and "a review was useful" are separate success criteria.

Things we should not carry forward as first-class design constraints:

- OpenRouter-first inference routing.
- The current review runner and retry stack.
- The current source-bundle hydration workflow.
- The current assumption that one large review loop should own too many responsibilities at once.
- The idea that we need to preserve compatibility with this implementation.

## Product Goal For The Rebuild

The next Nimbus should do one thing well before it does anything ambitious:

- take a code change
- gather the right evidence
- run one bounded review pass
- return a trustworthy result

Everything else is secondary.

That means:

- reliability comes before fancy loops
- evals come before prompt tuning
- one execution path comes before multiple fallback paths
- one provider path comes before multi-provider abstraction
- a clean code-substrate comes before optimization

## Non-Goals For The First Rebuild

The next repo should explicitly avoid these in the first milestone:

- autonomous remediation loops
- multi-pass review orchestration
- multiple inference providers on day one
- backward compatibility with this archived repo
- preserving existing worker names, queues, databases, or bindings
- rebuilding the entire Studio UX before review quality is proven

## Exact Cloudflare Primitives We Will Use

This section is intentionally concrete. It is the contract for the next pass.

### Phase 1 primitives: use these immediately

1. Cloudflare Workers
   Use Workers as the public control plane and API surface.
   Workers will accept review requests, expose status, and coordinate durable work.
   Workers will not be the place where long inference turns spend most of their time.

2. Cloudflare D1
   Use D1 as the authoritative metadata store.
   D1 should hold:
   - review records
   - workflow/job state
   - execution attempts
   - findings
   - evaluation fixtures and run results if needed

3. Cloudflare Workflows
   Use Workflows for durable multi-step review orchestration.
   This replaces the impulse to hand-build durable retry logic around ad hoc queue plus worker loops.
   Workflows should own:
   - step sequencing
   - retries
   - timeouts
   - waiting between stages
   - human-approval pauses later, if needed

4. Cloudflare Containers
   Use Containers for long-running execution that needs a real filesystem and a less fragile runtime boundary than a hot Worker request.
   Containers should own:
   - repo checkout or mounted repo access
   - file reads for review evidence
   - test/build execution if needed later
   - long model/tool turns if the orchestration path needs them

5. Cloudflare Artifacts
   Use Artifacts as the canonical code substrate instead of source bundles in R2.
   The mental model should be:
   - one canonical repo or imported baseline
   - per-review or per-task forks/branches when needed
   - diff, compare, and merge through a Git-native substrate

6. Cloudflare AI Gateway
   Use AI Gateway as the inference control plane.
   AI Gateway should own:
   - provider routing
   - auth boundary to upstream providers
   - observability and request logs
   - retries/fallbacks where that makes sense

### Phase 1 primitives: allowed but secondary

7. Cloudflare R2
   Use R2 only for large exported artifacts if needed.
   Examples:
   - zipped review evidence
   - debug snapshots
   - downloadable reports

   R2 should not be the primary code substrate for the rebuild.

### Deferred primitives: do not use in milestone 1

8. ArtifactFS
   ArtifactFS is promising, but the docs explicitly say regular `git clone` is simpler for smaller repos and that ArtifactFS is best when startup time matters more than a full local clone and the repo is large enough to justify the extra complexity.

   Decision:
   - do not use ArtifactFS in the first milestone
   - revisit it only after the new system works with plain Artifacts access or clone-based access inside Containers
   - adopt it later only if repo hydration becomes a real bottleneck

9. Cloudflare Queues
   Do not use Queues for the core review lifecycle in milestone 1.
   Workflows should be enough for the first rebuild.
   Queues can come back later for high-volume async fanout if the product actually needs them.

10. Custom Durable Objects
   Do not build a new custom `ReviewRunner`-style Durable Object in milestone 1.
   Containers already sit on top of Durable Objects, and Workflows already solve the durable sequencing problem more directly for this use case.

11. Workers AI as the default model path
   Do not force the model decision into Workers AI just because it is native to Cloudflare.
   The first concern is review quality and execution stability.
   AI Gateway should be the stable integration layer.

### Explicit rejections from the archived design

We are explicitly not using these as the foundation of the next pass:

- OpenRouter as the primary inference path
- R2 source bundles as the canonical code substrate
- the existing queue plus DO review-runner execution model
- the existing `@cloudflare/sandbox` workflow as the default review environment model

## Exact Inference Stance

The rebuild needs a crisp inference contract.

The contract should be:

- AI Gateway is the only gateway abstraction in the first implementation.
- Provider choice is explicit.
- Model choice is explicit.
- Authentication is explicit.
- Nimbus should not guess provider from arbitrary environment shape.

Recommended first-pass approach:

- start with OpenAI through AI Gateway
- use a single model path
- keep provider selection explicit in config
- use request-time provider credentials first if that keeps the product simple
- add richer provider connection management only after the core review product works

What this means in practice:

- no OpenRouter default
- no mixed fallback stack in milestone 1
- no model/provider inference from partial environment variables

## Architecture For The Next Repo

The next repo should be designed around clean boundaries.

### Boundary 1: control plane

Implemented with:

- Workers
- D1
- Workflows

Responsibilities:

- accept requests
- create review records
- start workflows
- expose status
- store findings
- expose events and results

This layer should not own heavyweight repo materialization or long-running inference turns.

### Boundary 2: code substrate

Implemented with:

- Artifacts
- optional R2 for exports later

Responsibilities:

- hold the canonical repo state
- create isolated review branches or forks
- provide diffable history and mergeable results

This layer replaces the source-bundle mental model.

### Boundary 3: execution runtime

Implemented with:

- Containers

Responsibilities:

- clone or access repo state
- gather file evidence
- run commands if needed
- host the bounded reviewer runtime

This layer is where filesystem-dependent work belongs.

### Boundary 4: inference control plane

Implemented with:

- AI Gateway

Responsibilities:

- send model requests
- standardize provider access
- provide observability
- keep auth and logging uniform

## Build Order For The New Nimbus Repo

The new repo should be built in very small steps.

### Step 0: create the new repo with the minimum skeleton

Create:

- one Worker control-plane package
- one Container executor package
- one shared types package if needed
- one docs file in the new repo explaining the scope of the milestone

Do not start with the full old package shape.

### Step 1: prove the control plane

Implement:

- review creation API
- D1 schema for reviews and attempts
- Workflow that can start and complete a dummy review

Success condition:

- a review can be created, progressed, and completed with no inference and no repo work

### Step 2: prove the code substrate

Implement:

- Artifacts repo creation or import
- one review can resolve a target repo state
- one Container can access that repo state

Success condition:

- we can read changed files from the execution runtime without ad hoc tarball hydration

### Step 3: prove one real model-backed review

Implement:

- one AI Gateway-backed provider path
- one prompt
- one bounded review output schema
- one result persisted back to D1

Success condition:

- the system can review a small known diff and return structured findings

### Step 4: add evals before complexity

Implement:

- two or three executable regression cases from real missed bugs
- a way to score whether Nimbus found the right issue family

Success condition:

- future review changes are judged against known misses rather than intuition

### Step 5: only then add breadth

Possible later additions:

- more providers
- richer evidence gathering
- command execution in the review runtime
- remediation
- Studio UX
- ArtifactFS if repo size and startup justify it

## Quality Strategy For The Rebuild

The next repo should treat quality as a product contract, not as something we tune after the fact.

Rules:

1. Every important missed bug becomes an eval.
2. A review that returns zero findings on a known-bad case is a failing system result, even if execution was technically successful.
3. We do not add more loops, retries, or autonomy until the single-pass evaluator catches the known bug set at an acceptable rate.
4. We do not optimize runtime before we know what the correct behavior is.

## Simplicity Rules

These rules exist to stop the new repo from drifting the way this one did.

1. Prefer one explicit path over fallback stacks.
2. Prefer one durable primitive for orchestration instead of combining several too early.
3. Prefer Git-native repo state over custom archive hydration.
4. Prefer evaluation fixtures over prompt folklore.
5. Prefer shipping one proven review pass over building a session system before trust exists.
6. Prefer deferring "clever" platform integrations until a simpler version has already succeeded.

## What The Archive Still Contains

This repository can still help in limited ways.

Use it for:

- examples of what not to repeat
- possible CLI ergonomics worth reusing later
- real regression cases
- historical context on the product direction

Do not use it as:

- the codebase to continue evolving
- the source of truth for architecture
- the starting point for a refactor

## Immediate Next Actions After Leaving This Archive

1. Create the new `nimbus` repository directory from scratch.
2. Start with a single control-plane Worker and a single execution Container.
3. Wire D1, Workflows, Artifacts, Containers, and AI Gateway.
4. Do not introduce OpenRouter.
5. Do not introduce custom review Durable Objects.
6. Do not introduce ArtifactFS until clone-based Artifacts access is proven insufficient.
7. Add the first real regression evals before attempting review-session UX or remediation.

## Cloudflare References For The Rebuild

- Artifacts: https://developers.cloudflare.com/artifacts
- How Artifacts work: https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/
- ArtifactFS: https://developers.cloudflare.com/artifacts/guides/artifact-fs/
- Sandbox SDK + Artifacts example: https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/
- Workflows: https://developers.cloudflare.com/workflows/
- Containers: https://developers.cloudflare.com/containers/
- AI Gateway overview: https://developers.cloudflare.com/ai-gateway/
- AI Gateway OpenAI provider path: https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
- AI Gateway Authenticated Gateway: https://developers.cloudflare.com/ai-gateway/configuration/authentication/

## Final Position

The next Nimbus should not be a continuation of this codebase.

It should be a new implementation with:

- a Git-native code substrate
- durable orchestration
- a real execution runtime
- one explicit inference path
- evals before complexity

That is the reset this archive is meant to protect.
