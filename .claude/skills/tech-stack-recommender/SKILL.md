---
name: tech-stack-recommender
description: Use when the user has a system architecture and wants a recommended tech stack, explained simply.
---

# Tech Stack Recommender

Turn an existing system architecture into a concrete, idea-specific tech stack recommendation — one real, current technology per component, rated for how well it actually fits this project's scale and needs, explained in plain English.

## Input

Read `project-blueprint/architecture.md`. If it does not exist, tell the user to run the system-architect skill first (or provide an architecture doc) — do not invent components from scratch.

## Process

1. **Read the architecture fully.** Pull the component list and the plain-English description of what each component does. The stack recommendation must map one-to-one to those components — no generic additions, no skipped components.

2. **For each component, recommend exactly one real, current technology.** Name it specifically (e.g., "PostgreSQL," "Redis," "Next.js," not "a relational database" or "a frontend framework"). Prefer technologies that are actively maintained and broadly adopted today — no deprecated, EOL, or niche-to-the-point-of-risky picks unless the idea specifically demands it.

3. **Rate the fit against THIS idea's actual scale and needs, not a generic default.** A technology being popular or "industry standard" does not automatically earn 🟢. Judge against what the architecture doc actually implies: expected traffic/volume, team size hints, real-time vs. batch needs, persistence needs, budget signals. Use exactly one of these three ratings per row:
   - 🟢 great fit — squarely matches this project's scale and needs, no meaningful downside for this use case
   - 🟡 good fit — works well, but there's a tradeoff or a mismatch in scale/complexity worth knowing about
   - 🔴 consider carefully — real risk of over/under-engineering, cost, or complexity mismatch for what this idea actually needs; explain the risk, don't just flag it

   Do not rate everything 🟢. If every row comes out 🟢, re-check the ratings against the architecture's actual scale — most real stacks have at least one 🟡 or 🔴.

4. **Explain the "why" in one plain-English sentence.** No unexplained jargon. If a technical term is unavoidable (e.g., "ORM," "message broker," "vector database"), attach a one-line definition inline, in parentheses, written for someone non-technical. State why *this* pick suits *this* project, not a textbook description of the technology.

5. **Use icons and short labels — never a wall of text.** Each component gets a compact row, not a paragraph. Keep the "why" to one sentence. No multi-paragraph justifications, no bullet sub-lists per row.

6. **End every row with a copy-ready follow-up prompt.** A single sentence in backticks the user could paste into a new message later to learn more about that specific technology in the context of their project. Pattern: `Explain <Technology> to me like I'm new to <category>, using my project as the example.` Adapt the category phrase naturally per technology (e.g., "databases," "frontend frameworks," "message queues").

7. **Save the result.** Write to `project-blueprint/tech-stack.md` (create `project-blueprint/` if missing, relative to the current working directory). The file must contain, in order:
   - A title — the project idea restated in a few words (reuse the architecture doc's title if present)
   - A one-line legend explaining the three fit-rating icons
   - One table with columns: **Component | Technology | Fit | Why (plain English) | Ask More**
   - A short closing note calling out any 🔴 rows by name and, in one sentence each, what to watch out for

## Anti-patterns

- Recommending a technology because it's trendy or familiar rather than because it fits this architecture's actual needs.
- Rating everything 🟢 — that signals the ratings weren't actually judged against scale.
- Writing a paragraph of justification per row instead of one plain sentence.
- Leaving jargon (ORM, message broker, CDN, vector database, etc.) unexplained.
- Recommending more than one technology option per component — pick one, commit to it.
- Skipping a component from the architecture doc or adding one that isn't there.

## Output report

When finished, report back to the user with:
1. The exact file path written (`project-blueprint/tech-stack.md`)
2. The fit-rating breakdown: how many 🟢, how many 🟡, how many 🔴
