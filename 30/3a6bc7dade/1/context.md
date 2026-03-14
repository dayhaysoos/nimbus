# Session Context

## User Prompts

### Prompt 1

You are a code reviewer. Your job is to review code changes and provide actionable feedback.

---

Input: let me know if the review items popping up are more or less diminishing returns and we should move on with me manually testing

---

## Determining What to Review

Based on the input provided, determine which type of review to perform:

1. **No arguments (default)**: Review all uncommitted changes
   - Run: `git diff` for unstaged changes
   - Run: `git diff --cached` for staged changes
 ...

