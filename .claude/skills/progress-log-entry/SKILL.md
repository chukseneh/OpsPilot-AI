---
name: progress-log-entry
description: Use immediately after completing any change that touches /backend, /frontend, /scripts, /nginx, or /directives in this repo — i.e., whenever a code, config, or directive change is about to be marked "done." Appends one correctly formatted, verification-backed entry to PROGRESS.md under the current Session ID. Do NOT use for work that never lands in the repo — Mandrill sends, Basecamp ticket creation, ad-hoc data pulls, memory file writes, or dry-run script output — CLAUDE.md explicitly excludes those from PROGRESS.md.
---

# Progress Log Entry

## Purpose

Produce a PROGRESS.md entry that satisfies the CLAUDE.md hard gate: every entry has verification evidence, carries the correct Session ID, and is appended safely even if other Claude instances are writing to the same file concurrently.

## When to invoke

Invoke right before declaring any implementation change "done," whenever that change touched `/backend`, `/frontend`, `/scripts`, `/nginx`, or `/directives`.

Do NOT invoke for: sending emails on the user's behalf, creating Basecamp tickets, one-off data pulls, memory file additions, or discovery/dry-run output that didn't ship code. CLAUDE.md names these as explicit non-entries.

## Required Input

- **Session ID** — the current session's `CC-<YYYYMMDD>-<4 random alphanumerics>`. If none has been minted yet this session, mint one now (fresh random suffix, never reused from PROGRESS.md).
- **Task name** — the checklist item this entry belongs under.
- **What changed** — one line, plain language.
- **Verification evidence** — a concrete artifact: a test name and result, a deploy URL, an explicit user confirmation, or a passing `tsc --noEmit`. A stated intent ("should work") is not evidence and blocks this skill from proceeding.
- **Notes** — only if there's a blocker, deviation, or non-obvious decision worth recording.

## Procedure

1. Confirm verification evidence exists. If it doesn't, stop and get it first (run the test, deploy, or ask the user) — never write `[x]` on intent alone.
2. Re-read the tail of `PROGRESS.md` right before writing. Another instance may have appended since it was last read.
3. Format the entry exactly as:
   ```markdown
   - [x] <task name>
     - Date: YYYY-MM-DD
     - Session: CC-<YYYYMMDD>-<id>
     - What changed: <one line>
     - Verification: <test name | deploy URL | "user confirmed" | "TypeScript passes">
     - Notes: <only if applicable>
   ```
4. Append after the current last line of the relevant task section. Never edit, reformat, or "clean up" another session's existing entries.
5. If this is a catch-up entry for earlier untracked work in the same session, date it for the day the work actually happened, not today.

## Constraints

- Never mark `[x]` without verification evidence on the same entry.
- Never touch a PROGRESS.md entry carrying a different Session ID.
- Never `git add -A` when committing this — stage only the files actually changed this session.
- If PROGRESS.md does not exist yet, create it before writing the entry.
