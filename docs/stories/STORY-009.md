# STORY-009 — Provide Configurable Governance Controls

As a compliance officer, I want OpsPilot to provide configurable governance controls, so that it can adapt to different jurisdictions.

**Release:** r4 · Advanced Governance & Simulation (weeks 9–10)
**Owner:** Governance Agent
**Blocked by:** STORY-008

## The requirement this satisfies

- **REQ-015** (Functional, must) — The system must provide configurable governance controls adaptable to different jurisdictions.

## How to build it

Implement governance configuration using a modular policy framework.

## Failure paths you must handle

- Misconfiguration
- Regulatory updates
- Unauthorized configuration changes

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a jurisdiction is selected, When governance controls are configured, Then they reflect local regulations.
- [ ] Given a jurisdiction is selected, When controls are misconfigured, Then the system alerts the user.
- [ ] Trust: Configuration changes are logged for audit purposes.

When every box above is ticked, stop and show the demo.
