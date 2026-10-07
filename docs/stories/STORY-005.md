# STORY-005 — Enable Workflow Automation with Human Oversight

As a process manager, I want OpsPilot to automate workflows with human oversight, so that high-risk actions are reviewed before execution.

**Release:** r2 · Automation & Human Oversight (weeks 5–6)
**Owner:** Automation Agent
**Blocked by:** STORY-004

## The requirement this satisfies

- **REQ-007** (Functional, must) — The system must provide human-in-the-loop controls for high-risk actions.

## How to build it

Use Claude's workflow-design skill to implement automation with approval gates.

## Failure paths you must handle

- Approval delays
- Incorrect risk categorization
- Automation failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given a workflow is automated, When a high-risk action is detected, Then it requires human approval.
- [x] Given a workflow is automated, When a low-risk action is detected, Then it executes automatically.
- [x] Trust: All automated actions are logged with risk levels.

When every box above is ticked, stop and show the demo.
