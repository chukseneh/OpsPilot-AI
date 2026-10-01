# STORY-008 — Calculate Estimated ROI

As a financial analyst, I want OpsPilot to calculate estimated ROI, so that I can assess the financial impact of automation.

**Release:** r3 · Document Intelligence & ROI Calculation (weeks 7–8)
**Owner:** Finance Agent
**Blocked by:** STORY-007

## The requirement this satisfies

- **REQ-009** (Functional, must) — The system must calculate estimated ROI based on user-provided assumptions.

## How to build it

Implement ROI calculation using user-provided data and assumptions.

## Failure paths you must handle

- Incorrect assumptions
- Calculation errors
- Data input errors

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given user assumptions are provided, When ROI is calculated, Then it shows estimated savings.
- [ ] Given user assumptions are incorrect, When ROI is calculated, Then it flags potential errors.
- [ ] Trust: ROI calculations are logged with assumptions.

When every box above is ticked, stop and show the demo.
