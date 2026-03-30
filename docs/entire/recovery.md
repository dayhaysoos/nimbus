# Entire Recovery Guide

## Purpose

This document explains how to recover Nimbus review preflight when Entire session metadata becomes unreadable, incomplete, or stops attaching usable checkpoint data to commits.

This is based on the failure mode we hit on `huge-refactor` in March 2026.

## Known Failure Pattern

The observed symptoms were:

- `nimbus review preflight <commit>` fell back to an older checkpoint instead of using the commit's direct checkpoint.
- `entire explain --commit <commit>` resolved a checkpoint ID, but the checkpoint metadata was incomplete.
- a new commit was created without an `Entire-Checkpoint` trailer.
- `.entire/settings.local.json` had been flipped to `"enabled": false`.
- after re-enabling Entire, an already-running OpenCode process did not re-establish an active Entire session, so the next commit still did not get a usable checkpoint trailer.

There was also a second-order issue in Nimbus itself:

- Entire had started writing transcript-backed checkpoint metadata.
- Nimbus was only treating `context` or `prompt` paths as readable metadata.
- direct checkpoint resolution therefore looked broken even when the checkpoint existed.

That Nimbus-side issue was fixed by teaching the resolver to read transcript-backed checkpoints.

## Fast Triage

Run these first:

```bash
entire status
entire explain --commit HEAD
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review preflight HEAD
git log -1 --format=raw HEAD
```

What to look for:

- `entire status` should show Entire as enabled.
- `entire status` should show the current OpenCode session as active.
- `git log -1 --format=raw HEAD` should include an `Entire-Checkpoint:` trailer.
- `entire explain --commit HEAD` should resolve the checkpoint directly.
- `review preflight HEAD` should say `Entire session metadata is readable` and should not mention branch fallback.

## Recovery Steps

### 1. Verify Entire is enabled

Inspect:

- `.entire/settings.local.json`

Expected:

```json
{
  "enabled": true
}
```

If it is `false`, set it back to `true`.

### 2. Make sure this OpenCode session is actually registered

This matters. Re-enabling Entire is not enough if the currently running OpenCode process never re-established an active Entire session.

Run:

```bash
entire status
```

If the current session is not shown as active, start a fresh OpenCode session after fixing the Entire settings.

### 3. Create a tiny verification commit

Prefer a tiny real code/doc change. An empty commit can prove trailer attachment, but it is not enough to validate review preflight end to end because preflight may reject it for having no patch.

If you only need to test trailer/session attachment first, an empty commit is acceptable:

```bash
git commit --allow-empty -m "chore: test Entire session health"
```

Then make one tiny real commit to verify reviewability.

### 4. Verify the commit trailer and checkpoint

Run:

```bash
git log -1 --format=raw HEAD
entire explain --commit HEAD
```

Expected:

- the commit has an `Entire-Checkpoint` trailer
- `entire explain` resolves the checkpoint for `HEAD`

### 5. Verify Nimbus can read the checkpoint directly

Run:

```bash
pnpm --filter @dayhaysoos/nimbus exec node dist/index.js review preflight HEAD
```

Expected:

- `Resolved checkpoint ... from <commit>`
- `Entire session metadata is readable`
- no fallback warning

If you see fallback language, inspect whether the checkpoint exists but Nimbus thinks the metadata is incomplete.

## If Direct Resolution Still Falls Back

Check the checkpoint branch data.

Useful commands:

```bash
git log -1 --format=raw HEAD
entire explain --commit HEAD
git show "entire/checkpoints/v1:<checkpoint-prefix>/<checkpoint-suffix>/metadata.json"
git show "entire/checkpoints/v1:<checkpoint-prefix>/<checkpoint-suffix>/0/metadata.json"
```

Questions to answer:

- Does the commit have a trailer?
- Does the checkpoint exist on `entire/checkpoints/v1`?
- Does the session entry reference `prompt`, `context`, or `transcript`?

## Known Good State

A healthy commit should satisfy all of these:

- commit message contains `Entire-Checkpoint: ...`
- `entire explain --commit <sha>` resolves the same checkpoint ID
- `review preflight <sha>` passes with direct resolution
- preflight prints `Entire session metadata is readable`
- preflight does not report branch fallback

## Practical Notes

- If Entire was disabled and later re-enabled, prefer starting a fresh OpenCode session before trusting new commits.
- Do not assume the absence of a trailer means commit hooks are broken; it may just mean the active OpenCode session was stale.
- Do not assume fallback means Entire is broken; Nimbus may be rejecting a newer checkpoint shape that Entire now emits.
- Prefer a tiny real commit for final verification, not just an empty commit.

## Current Nimbus Compatibility Note

Nimbus now supports transcript-backed Entire checkpoints.

If a future corruption incident looks similar, verify whether Entire changed the checkpoint metadata shape again before assuming the session data itself is missing.
