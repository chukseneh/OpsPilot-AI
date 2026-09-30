---
name: system-architect
description: Use when the user has a project idea and wants a system architecture, a technical design, or a diagram of how it would work.
---

# System Architect

Turn a one-paragraph project idea into an idea-specific system architecture with a real Mermaid diagram. Never fall back to a generic "frontend + backend + database" template — every component must earn its place by tracing back to something the idea actually said or clearly implied.

## Input

A one-paragraph project idea from the user. If the paragraph leaves a decision genuinely ambiguous (e.g., unclear whether there's a persistence need, a real-time need, or a third-party dependency), make the single most reasonable assumption, record it explicitly in the output, and keep moving. This is implementation-level ambiguity — do not stop to ask a clarifying question over it.

## Process

1. **Read the idea literally, then extract what it implies.**
   - Who touches the system: a browser, a mobile app, another API/service, a scheduled trigger?
   - What data (if any) has to survive between requests?
   - What happens synchronously vs. asynchronously?
   - What external systems does it depend on — payments, auth, email, maps, an LLM, a third-party data source?

2. **Pick only the components this specific idea needs.**
   - Skip the frontend entirely for a backend-only service, CLI tool, or scheduled job.
   - Skip the database if there's nothing to persist (e.g., a stateless transform or proxy).
   - Add an AI/agent layer only when the idea actually involves an LLM, agent, or ML inference step.
   - Name external services concretely ("Stripe-style payment processor," "transactional email service," "third-party OAuth provider") instead of a generic "External API" box.
   - Add a queue/worker only when the idea has async or long-running work.
   - Litmus test for every box on the diagram: can you point to the clause in the input paragraph that justifies it? If not, cut it.

3. **Trace the data flow before drawing anything.** Walk through at least one concrete user action end to end — submission → validation → processing → persistence → response (or whatever the idea's actual sequence is) — so the diagram's arrows represent a real path, not a static component inventory.

4. **Build the Mermaid flowchart.**
   - `flowchart TD` by default; switch to `LR` if it reads more naturally for this shape.
   - Label every edge with what actually moves across it (`-->|HTTP request|`, `-->|writes record|`, `-->|async job|`, `-->|LLM call|`) — no bare arrows.
   - Use `subgraph` to group related pieces (Client, Backend, Data Layer, External Services) when it clarifies the picture, not by default.
   - Keep node labels short, concrete, and real ("Postgres — user accounts," not "Component A" or "Database").

5. **Write one plain-English sentence per component.** A non-technical reader must be able to follow it. State what the component does *for the user or the business*, not its implementation — no unexplained "REST," "ORM," "message broker," etc.

6. **Save the output.** Write to `project-blueprint/architecture.md` (create `project-blueprint/` if missing, relative to the current working directory). The file must contain, in order:
   - A title — the project idea restated in a few words
   - The original one-paragraph idea, quoted verbatim
   - Any assumptions made, if the input was ambiguous
   - The component list, one plain-English sentence each
   - The Mermaid flowchart in a fenced ` ```mermaid ` block
   - A short "data flow walkthrough" paragraph tracing one real user action through the diagram, step by step

## Anti-patterns

- Reusing the same generic diagram shape regardless of what the idea actually described.
- Adding a component "just in case" instead of because the input demands it.
- Leaving a plain-English sentence full of jargon a non-technical exec wouldn't recognize.
- Skipping the data-flow walkthrough — an untraced diagram can't be verified as correct.

## Output report

When finished, report back to the user with:
1. The exact file path written (`project-blueprint/architecture.md`)
2. The final one-line description used to characterize the architecture
3. The full component list identified for this specific idea
