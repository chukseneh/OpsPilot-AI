# Common ETL/ELT Failure Patterns Reference

Failure-pattern catalog for the etl-failure-triage skill. Read this before ranking causes for any incident — use it to recognize evidence patterns, not to guess causes without evidence.

## Schema mismatch

**Typical evidence:** a type-conversion, cast, or mapping error naming a specific column; a column present in the source but missing/renamed in the target; a load that succeeds for most rows but errors or nulls out one field.
**Common triggers:** upstream source added/renamed/reordered a column; a nullable field started arriving null or empty where the target expects non-null; an enum/lookup value changed shape (e.g., blank string vs. a valid code).
**What corroborates it:** run metadata showing the source schema version or column list changed between the last-good run and the failing run.

## Failed conversion or mapping step

**Typical evidence:** an explicit "conversion failed," "cast error," "mapping not found," or "invalid value for field X" message, usually with the offending raw value quoted in the log.
**Common triggers:** a lookup/mapping table missing an entry for a new source value; a type coercion (string→numeric, string→enum) hitting a value outside the expected domain; encoding or whitespace differences preventing an exact-match lookup.
**What corroborates it:** the offending value appears verbatim in both the log and the source extract/staging data, if available.

## Retry that did not resolve the problem

**Typical evidence:** two or more attempt/run entries in the log with the same error signature; a retry counter or `attempt=N` field; identical failure point across attempts.
**Common triggers:** the failure is deterministic (bad data, bad mapping) rather than transient (timeout, lock contention) — retries only help transient failures, so a repeated identical failure is evidence the cause is NOT infrastructure flakiness.
**What corroborates it:** retry timestamps close together with no intervening fix, and the same row/column/value implicated each time.

## Other patterns worth checking evidence against

- **Timeout / connection failure** — evidence: explicit timeout or connection-reset messages, no partial row counts logged. Usually transient; retries are the expected mitigation, so repeated timeouts across many rows conflict with a schema/mapping explanation.
- **Volume anomaly** — evidence: row counts far outside historical norms in run metadata (near-zero or wildly high), with no explicit error. Suggests an upstream extract problem rather than a transformation bug.
- **Partial commit / inconsistent state** — evidence: some target rows present with the new run's batch ID, others missing; no clear single error line. Suggests a mid-run failure without a clean rollback.

## Evidence-matching guidance

- Prefer causes with evidence naming a specific field, value, row, or count over causes inferred only from an error's category.
- If two causes are both consistent with the evidence, rank the one more directly stated in the log (fact) above the one that must be inferred (hypothesis), and label each accordingly in the report.
- If the log and run metadata point to different causes, report the conflict explicitly rather than silently picking one.
