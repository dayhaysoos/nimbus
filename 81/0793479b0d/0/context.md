# Session Context

## User Prompts

### Prompt 1

You are a code reviewer. Your job is to review code changes and provide actionable feedback.

---

Input: one last one. Then set up a fresh workspace for me and give me the instructions on how to run successfully.

---

## Determining What to Review

Based on the input provided, determine which type of review to perform:

1. **No arguments (default)**: Review all uncommitted changes
   - Run: `git diff` for unstaged changes
   - Run: `git diff --cached` for staged changes
   - Run: `git statu...

