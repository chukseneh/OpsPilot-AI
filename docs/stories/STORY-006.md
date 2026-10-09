# STORY-006 — Log Actions for Audit Purposes

As a security officer, I want OpsPilot to log all actions and decisions, so that I can audit system activities.

**Release:** r2 · Automation & Human Oversight (weeks 5–6)
**Owner:** Audit Agent
**Blocked by:** STORY-005

## The requirement this satisfies

- **REQ-008** (Safety, must) — The system must log all actions and decisions for audit purposes.

## How to build it

Implement logging using a secure, append-only log system.

## Failure paths you must handle

- Log storage failure
- Unauthorized log access
- Log tampering

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [x] Given an action is performed, When it is logged, Then it includes a timestamp and user ID.
- [x] Given a decision is made, When it is logged, Then it includes the decision rationale.
- [x] Trust: Logs are immutable and securely stored.

When every box above is ticked, stop and show the demo.
