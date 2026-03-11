# Session Context

## User Prompts

### Prompt 1

You are a code reviewer. Your job is to review code changes and provide actionable feedback.

---

Input: one more review to make sure nothing else shows up.

---

## Determining What to Review

Based on the input provided, determine which type of review to perform:

1. **No arguments (default)**: Review all uncommitted changes
   - Run: `git diff` for unstaged changes
   - Run: `git diff --cached` for staged changes
   - Run: `git status --short` to identify untracked (net new) files

2. **C...

