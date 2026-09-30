---
description: Test, format, and draft a PR for the current change
argument-hint: [pr-title]
allowed-tools: Bash(npm --prefix backend test), Bash(npm --prefix frontend test), Bash(npm --prefix frontend run lint -- --fix), Bash(git add backend frontend), Bash(git diff --staged)
---

Scope: `backend/` and `frontend/` only. `nhs-ops-status/` has no test or format
tooling configured (no pytest, no black/ruff, nothing in its `pyproject.toml`) —
if the current change lives there, say so plainly in step 1 and stop; do not
guess at a command that doesn't exist.

1. Run the real test command for each scoped project:
   - `npm --prefix backend test`
   - `npm --prefix frontend test`

   If either fails, STOP and report the failures verbatim. Do not continue to step 2.

   # WHY: verification is step one, and step one is allowed to say no.

2. On green, run the formatter and stage the change:
   - `npm --prefix frontend run lint -- --fix` — this repo has no dedicated
     formatter (no prettier, no `format` script anywhere); `oxlint --fix` is
     the only real, installed tool that rewrites files, so it stands in for
     "the formatter" here. Backend has no lint/format script at all — nothing
     runs there, and that's expected, not a gap to paper over.
   - `git add backend frontend`

3. Run `git diff --staged` and read the output. Draft a PR description titled
   "$ARGUMENTS" with:
   - **Summary** — what changed and why, in plain language.
   - **Test Evidence** — quote the actual passing output lines from step 1
     (not a paraphrase or a claim — the real lines).
   - **Risk** — what could break, and what the tests that ran do *not* cover.

   Present this as your final response. Do not create, commit, or push
   anything — `/ship` prepares a change, it does not ship one.

   # WHY: $ARGUMENTS is whatever you type after /ship — the title travels into the body.
