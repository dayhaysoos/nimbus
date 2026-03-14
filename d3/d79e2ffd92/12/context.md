# Session Context

## User Prompts

### Prompt 1

Before we go further with the co-change lookup implementation, we need to verify that the data we're assuming exists actually exists in the format we need.

Investigate the following and report back with findings:


1. **Inspect the `.entire` directory in this repo** — what is the actual structure of the data stored locally?


2. **Inspect the `entire/checkpoints/v1` branch** — look at real session files for commits that have valid `Entire-Checkpoint` trailers. Specifically look at:
   - `met...

### Prompt 2

Before we make any changes to the co-change lookup implementation, describe exactly how it currently works:

1. Which files on `entire/checkpoints/v1` are you reading to get the list of files touched per session?
2. Are you using `metadata.json` `files_touched`, parsing `full.jsonl`, or something else?
3. What is the exact code path for co-change lookup in `packages/worker/src/lib/review-runner.ts`?


Do not change anything. Just report back.

