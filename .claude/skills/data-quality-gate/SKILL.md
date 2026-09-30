---
name: data-quality-gate
description: Use when the user asks to validate a dataset, CSV, ETL output, query result, or dashboard/report data source for quality before publication — i.e., requests to check, gate, or sign off on data quality, or on publish/publication readiness. Returns PASS, WARN, or FAIL with evidence and a PUBLISH or BLOCK recommendation. Do NOT use for ordinary requests to write SQL, calculate a metric, or design/build a dashboard — those alone are not sufficient reason to invoke this skill unless the user also asks for a quality check or a publish/block verdict.
---

# Data Quality Gate

## Purpose

Validate a dataset against a quality contract before it is published, and return a clear verdict with a publish/block recommendation. This skill is read-only: it never modifies, deletes, or reformats source data.

## When to invoke

Invoke for: validating a dataset/CSV/ETL output/query result before it feeds a report or dashboard, running a data-quality check, or answering "is this safe to publish."

Do NOT invoke for: writing or reviewing SQL, calculating or defining a metric, or designing/building a dashboard's layout or visuals. None of those, by themselves, are data-quality-gate requests — invoke only if the request also asks for a quality check, validation, or a publish/block verdict.

## Required Input

- **Dataset path** — required. If the user has not supplied one, ask for it before doing anything else. Do not guess or substitute a different file.
- **Quality contract** — use one if supplied by the user or found alongside the dataset (e.g., a `quality-contract.md` or similar in the same directory). If no contract is available, fall back to the default rules in `references/quality-checks.md` and state plainly in the output that no contract was supplied.

## Procedure

1. Locate and read the dataset. Do not write to it, move it, or alter it in any way.
2. Locate and read the quality contract, if available. Contract rules override the defaults wherever they overlap.
3. Read `references/quality-checks.md` for the full list of checks, default thresholds, and PASS/WARN/FAIL assignment rules before running any checks — read it every time you run this skill, even if the checks seem obvious from the contract.
4. Run the checks from that reference. For every check, cite concrete evidence — row numbers, values, or counts. Never assert a result without evidence.
5. Present results as a single table with columns: **Check | Evidence | Status | Recommended Action**.
6. Roll the table up into one overall verdict: **PASS**, **WARN**, or **FAIL** — FAIL if any check fails, WARN if any check warns and none fail, PASS only if every check passes.
7. End with an explicit recommendation: **PUBLISH** or **BLOCK** — BLOCK on any FAIL; BLOCK or PUBLISH-with-caveats on WARN depending on contract severity; PUBLISH only on a clean PASS.

## Constraints

- Never modify, delete, reformat, or "clean up" the source dataset.
- Never publish, move, or delete the dataset yourself — only recommend an action.
- Keep the output procedural and concise: the table, the verdict, and the recommendation. No narrative padding.
