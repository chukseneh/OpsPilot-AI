# STORY-004 — Maintain AI System Inventory

As an IT manager, I want OpsPilot to maintain an AI system inventory, so that I have a comprehensive view of all AI systems.

**Release:** r1 · Risk & Governance Features (weeks 3–4)
**Owner:** Governance Agent
**Blocked by:** STORY-003

## The requirement this satisfies

- **REQ-006** (Functional, must) — The system must maintain an AI system inventory including system, department, purpose, risk, owner, and status.

## How to build it

Implement inventory management using a PostgreSQL database.

## Failure paths you must handle

- Database connection failure
- Data inconsistency
- Unauthorized access

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given AI systems are registered, When I view the inventory, Then it lists all systems with details.
- [ ] Given AI systems are registered, When I update a system's status, Then the inventory reflects the change.
- [ ] Trust: Inventory changes are logged for audit purposes.

When every box above is ticked, stop and show the demo.
