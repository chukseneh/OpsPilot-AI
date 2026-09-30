---
name: executive-dashboard-brief
description: Use when the user asks to turn a data-quality result, failed refresh, pipeline incident, KPI variance, or technical investigation into an executive dashboard update. Produces a concise leadership brief containing status, business impact, verified evidence, decision needed, owner, and next update time.
---

# Executive Dashboard Brief

## Purpose

Translate an existing technical finding — a data-quality report, ETL/pipeline triage report, KPI variance analysis, or similar investigation — into a short, non-technical brief a leadership audience can act on. This skill is a translation/formatting layer: it never re-investigates, never re-diagnoses, and never adds information beyond what the supplied report(s) already establish.

## When to invoke

Invoke when the user has a completed data-quality result, failed refresh, pipeline incident, KPI variance, or technical investigation and wants it turned into an executive-facing dashboard update or leadership brief.

Do NOT invoke to perform the underlying investigation itself — run `data-quality-gate` or `etl-failure-triage` (or equivalent) first, and pass this skill their output. This skill has no diagnostic procedure of its own.

## Required Input

- **At least one source report** — a data-quality report, ETL/triage report, or equivalent technical finding — required. If none is supplied, ask for it before doing anything else. Do not fabricate findings.
- **Any explicitly supplied business context** (owner name, financial figures, decision deadline, next update time) — use only if stated in the source report or given directly by the user. Absence of this context is not a blocker; it becomes an entry in "What We Do Not Know."

## Procedure

1. Read every supplied quality/triage report end to end.
2. Extract only claims the source report(s) state directly (status, verdict, evidence, root cause, recommended action, owner, dates). These are **verified facts**.
3. Identify anything the brief would need but the source report(s) do not state (e.g., dollar impact, named owner, resolution ETA, root cause confidence). These are **unresolved questions** — list them, never fill them in with an estimate or guess.
4. Do not invent or infer: financial/business impact figures, root cause, owner/assignee, or timing — if the source doesn't state it, it goes in "What We Do Not Know," not in "Business Impact," "What We Know," or "Owner."
5. Strip raw log lines, stack traces, row-level dumps, and other technical detail not needed for a leadership decision. Reference findings by their conclusion (e.g., "duplicate order record detected"), not by log excerpt.
6. Determine and state explicitly whether the downstream dashboard/publish should remain blocked, based on the source report's verdict/recommendation — do not soften or override a BLOCK/FAIL verdict.
7. Populate `template.md` with the extracted content. Use the template's structure and section order as-is; do not add, remove, reorder, or rename its sections.
8. Return exactly the seven sections in `template.md`, in order: **Status, Business Impact, What We Know, What We Do Not Know, Decision or Action Needed, Owner, Next Update.**

## Constraints

- Never invent financial impact, root cause, owner, or timing not present in the source report(s) or explicit user input.
- Never include raw logs, stack traces, or unnecessary technical detail.
- Always state plainly whether the dashboard/publish should remain blocked.
- Always populate every section of `template.md`; if a section has no verified content, write it as an open item under "What We Do Not Know" rather than leaving it blank or guessing.
- This skill does not modify pipeline code, does not run or rerun any job, and does not publish or commit anything — it produces a brief document only.
