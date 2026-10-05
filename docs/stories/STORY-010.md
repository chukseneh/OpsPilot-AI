# STORY-010 — Simulate Workflows Using Synthetic Data

As a system tester, I want OpsPilot to simulate workflows using synthetic data, so that I can validate system behavior without real data.

**Release:** r4 · Advanced Governance & Simulation (weeks 9–10)
**Owner:** Simulation Agent
**Blocked by:** STORY-009

## The requirement this satisfies

- **REQ-014** (Functional, must) — The system must simulate workflows using synthetic data for demonstration purposes.

## How to build it

Run the workflows you built in STORY-005 against synthetic data you generate yourself. Nothing external is required. A good simulation proves two things: a correct run behaves as expected, and a deliberately broken input is flagged rather than silently processed. Keep the synthetic data clearly marked as synthetic so a reviewer can never mistake it for real records, and log each simulation run.

## Failure paths you must handle

- Data generation errors
- Simulation timeout
- Unexpected workflow behavior

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given synthetic data is available, When a workflow is simulated, Then it executes as expected.
- [ ] Given synthetic data is incorrect, When a workflow is simulated, Then it flags errors.
- [ ] Trust: Simulation results are logged for review.

When every box above is ticked, stop and show the demo.
