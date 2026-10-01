# STORY-003 — Implement Risk Assessment

As a compliance officer, I want OpsPilot to perform risk assessments, so that I can manage AI system risks effectively.

**Release:** r1 · Risk & Governance Features (weeks 3–4)
**Owner:** Risk Agent
**Blocked by:** STORY-002

## The requirement this satisfies

- **REQ-005** (Functional, must) — The system must perform risk assessments for AI systems in the organisation.

## How to build it

Use Claude's risk-assessment skill to evaluate AI systems.

## Failure paths you must handle

- Incomplete system data
- Risk model errors
- Assessment timeout

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given AI systems are registered, When a risk assessment is performed, Then risks are identified and categorized.
- [ ] Given AI systems are registered, When a risk assessment is performed, Then it suggests mitigation actions.
- [ ] Trust: Risk assessment results are logged for audit purposes.

When every box above is ticked, stop and show the demo.
