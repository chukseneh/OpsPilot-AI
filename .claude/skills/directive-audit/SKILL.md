---
name: directive-audit
description: Use when the user asks to audit, validate, review, or check one or more directives in /directives for completeness or quality — e.g., "is this directive missing anything," "audit the directives folder," "will a junior dev be able to follow this SOP." Produces a pass/fail report per directive against CLAUDE.md's directive-validation criteria. Read-only: never edits, rewrites, or "fixes" the directive itself — it only reports. Do NOT use for drafting new directive content or applying suggested fixes; that is separate, deliberate write work outside this skill's scope.
allowed-tools: Read, Glob, Grep
---

# Directive Audit

## Purpose

Check one or more files in `/directives` against the directive-validation bar CLAUDE.md sets: required sections present, every referenced file/script actually exists, markdown is well-formed, and the SOP is clear enough for a junior developer to follow unassisted. Output a report. Never modify the directive.

## Why this skill cannot write anything

This skill's tool access is deliberately limited to `Read`, `Glob`, `Grep` — no `Write`, `Edit`, or `Bash`. An audit that can also patch the thing it's auditing invites a bad habit: silently "fixing" a small gap instead of surfacing it, which defeats the point of an audit trail. Because the write-capable tools are absent from this skill entirely, that failure mode is impossible here by construction, not just by instruction. If a fix is warranted, it happens as separate, visible work after this report is read — never inside this skill.

## When to invoke

Invoke for: auditing an existing directive (or all of `/directives`) for completeness, checking whether referenced files/scripts still exist, or answering "is this SOP good enough to hand to a junior developer."

Do NOT invoke for: writing a new directive from scratch, or applying any fix this skill recommends — both require `Write`/`Edit`, which this skill intentionally does not have.

## Required Input

- **Target** — a specific directive path, or "all" to audit every file in `/directives`. If neither is given, ask before proceeding.

## Procedure

1. Read `references/audit-criteria.md` in full before auditing anything — every time, even if the criteria seem memorized from a prior run.
2. Resolve the target: a single file via `Read`, or the full set via `Glob` on `/directives/**/*.md`.
3. For each directive:
   a. Check for each required section from the criteria reference. Missing = fail that check.
   b. For every file or script path the directive references, confirm it exists using `Glob` (existence only — this skill never executes anything, so it cannot run the script to check it *works*, only that the path is real).
   c. Scan for the markdown-integrity issues listed in the criteria reference (`Grep` for unclosed code fences, broken heading hierarchy, dangling links).
   d. Apply the junior-developer clarity heuristics from the criteria reference.
4. Fill out `template.md` per directive: one row per check, with concrete evidence (line numbers, quoted text, the missing path) — never a bare "looks fine."
5. Roll each directive up to an overall verdict: **PASS**, **NEEDS WORK**, or **FAIL** per the thresholds in the criteria reference.
6. If auditing "all," close with a one-line summary table across all directives.

## Constraints

- Never edit, reformat, or annotate the directive file itself.
- Never invent a referenced file's existence — if `Glob` doesn't find it, the check fails, full stop.
- Cite evidence for every check; a check with no evidence is not a passed check.
- This skill cannot execute scripts it finds referenced — do not claim a script "works," only that it exists at the stated path.
