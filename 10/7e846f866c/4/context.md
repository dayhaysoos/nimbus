# Session Context

## User Prompts

### Prompt 1

You are a code reviewer. Your job is to review code changes and provide actionable feedback.

---

Input: a4d1b52 included unstaged code in this review as well

---

## Determining What to Review

Based on the input provided, determine which type of review to perform:

1. **No arguments (default)**: Review all uncommitted changes
   - Run: `git diff` for unstaged changes
   - Run: `git diff --cached` for staged changes
   - Run: `git status --short` to identify untracked (net new) files

2. *...

