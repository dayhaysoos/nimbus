# Session Context

## User Prompts

### Prompt 1

You are a code reviewer. Your job is to review code changes and provide actionable feedback.

---

Input: If the review finds bugs, fix them only. Do not commit any code until I tell you to. I will repeatedly run review until it doesn't find any more bugs. Then I will manually test

---

## Determining What to Review

Based on the input provided, determine which type of review to perform:

1. **No arguments (default)**: Review all uncommitted changes
   - Run: `git diff` for unstaged changes
...

