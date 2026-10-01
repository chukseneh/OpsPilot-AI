# OpsPilot AI — Enterprise AI Operations, Workflow & Risk Automation Platform — Requirements

An AI agent that analyses organisational operations, identifies inefficiencies and risks, automates workflows, and measures financial and operational impact.

This is the source of truth for what you are building. Your Claude Code prompts
point here. If you sharpen a requirement, edit it — your version is the real one.

| Kind | Meaning |
|---|---|
| Functional | something the system does |
| Safety | a guardrail, with a check that enforces it |
| Reliability | how it behaves when something fails |
| Constraint | a technology or vendor you must use — context, not a task |

## Agent Orchestration

### REQ-012 — Functional · must

The system must support multi-agent orchestration for process, risk, and finance operations.

Fulfilled by: STORY-001

## Audit & Logging

### REQ-008 — Safety · must

The system must log all actions and decisions for audit purposes.

Fulfilled by: STORY-006

## Document Intelligence

### REQ-010 — Functional · must

The system must allow users to upload documents such as invoices and contracts for structured information extraction.

Fulfilled by: STORY-007

## Governance

### REQ-015 — Functional · must

The system must provide configurable governance controls adaptable to different jurisdictions.

Fulfilled by: STORY-009

## Human Oversight

### REQ-007 — Functional · must

The system must provide human-in-the-loop controls for high-risk actions.

Fulfilled by: STORY-005

## Integration

### REQ-001 — Constraint

The system must connect to Microsoft 365 and Google Workspace to access emails and documents.

Fulfilled by: STORY-001

### REQ-002 — Constraint

The system must connect to CRM and ticketing systems to gather customer and request data.

Context for the stories that use it — constraints do not get their own story.

### REQ-011 — Constraint

The system must connect to MCP servers for tool interactions such as finance and HR operations.

Context for the stories that use it — constraints do not get their own story.

## Process Analysis

### REQ-003 — Functional · must

The system must analyse business processes to identify inefficiencies such as bottlenecks and duplicated activities.

Fulfilled by: STORY-002

### REQ-004 — Functional · must

The system must identify potential automation opportunities within business workflows.

Fulfilled by: STORY-002

## Risk & Governance

### REQ-005 — Functional · must

The system must perform risk assessments for AI systems in the organisation.

Fulfilled by: STORY-003

### REQ-006 — Functional · must

The system must maintain an AI system inventory including system, department, purpose, risk, owner, and status.

Fulfilled by: STORY-004

### REQ-016 — Functional · should

The system must perform privacy assessments for AI systems in the organisation.

_Not yet fulfilled by any story._

### REQ-017 — Functional · should

The system must support real-time risk assessment for ongoing operations.

_Not yet fulfilled by any story._

## ROI Calculation

### REQ-009 — Functional · must

The system must calculate estimated ROI based on user-provided assumptions.

Fulfilled by: STORY-008

## Simulation

### REQ-014 — Functional · must

The system must simulate workflows using synthetic data for demonstration purposes.

Fulfilled by: STORY-010

## User Interface

### REQ-013 — Functional · must

The system must provide a dashboard to display process analysis results and automation opportunities.

Fulfilled by: STORY-011

### REQ-018 — Functional · should

The system must provide a workflow builder for users to design and automate processes.

_Not yet fulfilled by any story._
