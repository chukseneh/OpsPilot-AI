# STORY-002 — Perform Process Analysis

As a process analyst, I want to perform process analysis, so that I can identify inefficiencies and areas for improvement.

**Release:** r0 · Initial Integration & Process Analysis (weeks 1–2)
**Owner:** process analyst
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-003** (Functional, must) — The system must analyse business processes to identify inefficiencies such as bottlenecks and duplicated activities.
- **REQ-004** (Functional, must) — The system must identify potential automation opportunities within business workflows.

## How to build it

Implement the process analysis module to handle data input, processing, and report generation. Ensure logging of all analysis activities in the audit trail.

## Failure paths you must handle

- Data set is incomplete
- Analysis process is interrupted
- User lacks permission to perform analysis

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a set of process data, when the analysis is initiated, then the system should provide a detailed report of inefficiencies.
- [ ] Given an incomplete data set, when the analysis is attempted, then the system should notify the user of missing data.
- [ ] Trust: The system logs all analysis activities with timestamps and user IDs for audit purposes.

When every box above is ticked, stop and show the demo.
