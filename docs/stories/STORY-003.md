# STORY-003 — Implement Risk Assessment

As a compliance officer, I want OpsPilot to perform risk assessments, so that I can manage AI system risks effectively.

**Release:** r1 · Risk & Governance Features (weeks 3–4)
**Owner:** Risk Agent
**Blocked by:** STORY-002

## The requirement this satisfies

- **REQ-005** (Functional, must) — The system must perform risk assessments for AI systems in the organisation.

## How to build it

Build the risk assessment in your own code, against the AI systems already in your inventory from STORY-004. For each registered system, identify its risks and put them into named categories you choose and can defend, then record a suggested mitigation for each one. Write every assessment run to a log with what was assessed, what was found and when, so the Trust line is satisfied by a real record rather than a claim. No external service and no pre-built skill is required for this story.

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
