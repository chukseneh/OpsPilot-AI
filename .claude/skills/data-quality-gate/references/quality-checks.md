# Quality Checks Reference

Full definitions for the checks the data-quality-gate skill runs. Read this before running checks against any dataset.

## Checks

Run all of these (skip only if the contract explicitly says a rule doesn't apply):

- **Schema** — expected columns are present; no unexpected columns are silently dropping data.
- **Freshness** — the newest load/timestamp field is within the contract's max-age window (default: 24 hours).
- **Expected volume** — row count meets or exceeds the contract's minimum (default: at least 10 rows).
- **Key uniqueness** — the designated key column has no duplicate values.
- **Duplicates** — no fully duplicate rows.
- **Required fields** — contract-designated required fields are non-empty in every row.
- **Nulls** — null/blank rate on required fields is reported even when it does not fail a check.
- **Numeric rules** — contract-designated numeric fields satisfy their stated constraints (e.g., greater than zero).

## Default thresholds (used only when the contract is silent or missing)

- Freshness max-age: 24 hours.
- Minimum expected row count: 10.
- No default key column — if the contract doesn't designate one, ask, or infer from an obviously unique ID-like column and state the assumption explicitly in the report.

## Status assignment

- **FAIL** — violates a hard contract rule (uniqueness, required field, numeric rule, or a freshness/volume threshold the contract marks as hard).
- **WARN** — a soft concern not covered by a hard rule (e.g., missing contract, ambiguous schema, borderline volume).
- **PASS** — rule satisfied.

## Evidence requirement

Every check's status must be backed by concrete evidence: row numbers, specific values, or counts. Never assert a result without pointing to the data that supports it.
