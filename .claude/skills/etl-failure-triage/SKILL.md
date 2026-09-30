---
name: etl-failure-triage
description: Use when the user asks why an ETL or ELT pipeline, scheduled load, SQL job, data refresh, or ingestion process failed or produced suspicious output. Reviews logs and run metadata, ranks likely causes, cites evidence, and recommends the next safe diagnostic steps.
---

# ETL Failure Triage

## Purpose

Diagnose why a pipeline run failed or produced suspicious output, using only the evidence in the log and run metadata supplied. This skill is diagnostic-only: it never changes pipeline code, never reruns jobs, and never claims a root cause it can't point to evidence for.

## When to invoke

Invoke for: an ETL/ELT pipeline, scheduled load, SQL job, data refresh, or ingestion process that failed, errored, or produced output the user finds suspicious, and the user wants to know why.

Do NOT invoke for: writing new pipeline code, fixing a bug the user has already diagnosed, or data-quality validation of a dataset that loaded successfully (that's `data-quality-gate`).

## Required Input

- **A log, run output, or failure description** — required. If none is supplied, ask for it before doing anything else. Do not fabricate log content.
- **Run metadata** — read it if supplied (schedule, source/target, row counts, prior run history, config). Use it to corroborate or rule out hypotheses; do not treat its absence as a blocker.

## Procedure

1. Read the log/failure description end to end. Read the run metadata if supplied.
2. Read `references/common-failures.md` for the failure-pattern catalog and evidence-matching guidance before ranking causes — read it every time, even if the log looks familiar.
3. Separate **facts** (directly observed in the log/metadata: error messages, timestamps, row counts, exit codes) from **hypotheses** (explanations that would account for those facts but aren't themselves stated in the log).
4. For each candidate cause, cite the specific evidence (log line, timestamp, field name, count) that supports it. A cause with no cited evidence is not reported.
5. Rank causes most-to-least likely based on how directly the evidence points to them and whether metadata corroborates or contradicts them.
6. For each ranked cause, give one concrete next diagnostic step (e.g., a specific field to inspect, a specific upstream system to check, a specific log to pull) — not a fix, not a rerun.
7. Return exactly these sections, in order: **Incident Summary, Evidence, Ranked Causes, Next Tests, Escalation Recommendation.**

## Constraints

- Never modify, patch, or refactor pipeline code.
- Never rerun, retry, or trigger a job.
- Never state a root cause without citing the evidence for it — if evidence is insufficient to rank causes, say so and recommend what additional log/metadata would resolve the ambiguity.
- Keep the output procedural and concise: the five sections above, no narrative padding.
