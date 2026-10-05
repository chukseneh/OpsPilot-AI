# STORY-005 — Enable Workflow Automation with Human Oversight

As a process manager, I want OpsPilot to automate workflows with human oversight, so that high-risk actions are reviewed before execution.

**Release:** r2 · Automation & Human Oversight (weeks 5–6)
**Owner:** Automation Agent
**Blocked by:** STORY-004

## The requirement this satisfies

- **REQ-007** (Functional, must) — The system must provide human-in-the-loop controls for high-risk actions.

## How to build it

Build the approval gate in your own code. There is no pre-built skill for this and you do not need one. Classify each action as high or low risk using the risk work from STORY-003, then let a low-risk action execute and hold a high-risk one until a human approves it. Put the thing that actually performs an action behind one small interface, so a real connector can replace a stand-in later without touching the approval logic. Log every action with its risk level and who approved it.

## Failure paths you must handle

- Approval delays
- Incorrect risk categorization
- Automation failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a workflow is automated, When a high-risk action is detected, Then it requires human approval.
- [ ] Given a workflow is automated, When a low-risk action is detected, Then it executes automatically.
- [ ] Trust: All automated actions are logged with risk levels.

When every box above is ticked, stop and show the demo.
