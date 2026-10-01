# STORY-007 — Extract Structured Information from Documents

As a user, I want OpsPilot to extract structured information from uploaded documents, so that I can easily access relevant data.

**Release:** r3 · Document Intelligence & ROI Calculation (weeks 7–8)
**Owner:** Document Agent
**Blocked by:** STORY-006

## The requirement this satisfies

- **REQ-010** (Functional, must) — The system must allow users to upload documents such as invoices and contracts for structured information extraction.

## How to build it

Use Claude's document-analysis skill to extract information from documents.

## Failure paths you must handle

- Unsupported document format
- Extraction errors
- Document upload failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a document is uploaded, When it is processed, Then structured information is extracted.
- [ ] Given a document is uploaded, When it contains errors, Then the system flags it for review.
- [ ] Trust: Document processing actions are logged.

When every box above is ticked, stop and show the demo.
