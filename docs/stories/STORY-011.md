# STORY-011 — Provide Dashboard for Process Analysis Results

As a data analyst, I want a dashboard to display process analysis results and automation opportunities, so that I can identify areas for improvement.

**Release:** r0 · Initial Integration & Process Analysis (weeks 1–2)
**Owner:** data_analyst
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-013** (Functional, must) — The system must provide a dashboard to display process analysis results and automation opportunities.

## How to build it

Create a dashboard interface that pulls data from the process analysis module and displays it to users.

## Failure paths you must handle

- Data retrieval failure
- Dashboard rendering error
- Unauthorized access

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given process analysis data is available, when I access the dashboard, then I see the analysis results and automation opportunities.
- [ ] Given no data is available, when I access the dashboard, then I see a message indicating no data is present.
- [ ] Trust: The system logs all dashboard accesses and data views for audit purposes.

When every box above is ticked, stop and show the demo.
