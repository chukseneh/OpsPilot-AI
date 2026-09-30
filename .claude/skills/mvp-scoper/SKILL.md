---
name: mvp-scoper
description: Use when the user wants to know what to build first, see what their idea could look like, and get a short pitch for it.
allowed-tools: Read, Write, Bash
---

# MVP Scoper

Turn an existing project idea into three concrete artifacts: the smallest real Week-1 build plan, a visual mockup of what it could look like, and a one-page pitch. This skill does not invent the idea or the architecture — it scopes and packages work that `system-architect` and `tech-stack-recommender` have already defined.

Bash in this skill exists for exactly one purpose: detecting which PDF-generation tool is available and running the single command (or single script) that produces `one-pager.pdf`. Do not use Bash for anything else — no installs, no git, no unrelated system commands.

## Input

Read `project-blueprint/architecture.md` and `project-blueprint/tech-stack.md`. If either is missing, tell the user to run `system-architect` (and then `tech-stack-recommender`) first — do not invent components or technology picks from scratch.

## Process

### 1. mvp-plan.md — the smallest real Week-1 slice

1. From `architecture.md`, identify the single core user action that proves the idea works end to end (e.g., "a user submits X and sees Y come back"). Cut everything else, including components in the architecture that aren't needed to prove that one path.
2. Map each step of that path to the specific architecture component and tech-stack pick that implements it — no generic steps like "set up backend."
3. List what's deliberately deferred (other architecture components not needed for the proof) with a one-line reason each.
4. Populate `template.md` in this skill's directory with the above. Use its structure and section order as-is — do not add, remove, reorder, or rename sections.
5. Write the result to `project-blueprint/mvp-plan.md`.

### 2. mockup.html — a real mockup of the main screen

1. Pick the one screen that best represents the idea: a landing page for a product/service idea, or the core in-app view for a tool/utility idea.
2. Build a single self-contained HTML file: inline `<style>`, no external stylesheets, fonts, or CDN links (this file must open standalone in a browser with no network access). Use inline SVG or Unicode/emoji glyphs for icons — never reference an external icon library.
3. Write actual layout — header/nav, hero or primary content area, a couple of supporting sections (features, stats, secondary actions) as fits the idea — not a gray-box wireframe.
4. Write real, idea-specific sample copy: a real headline, a real subheadline, real feature names and one-line descriptions, real-sounding sample data (names, numbers, statuses) that fits this idea's domain. No "Lorem ipsum," no "Feature 1 / Feature 2," no placeholder brackets.
5. Use color deliberately (a small palette, not defaults) so it reads as visually designed, not unstyled HTML.
6. Save to `project-blueprint/mockup.html`.

### 3. one-pager.pdf — a real single-page marketing PDF

1. Write the marketing copy first, separately from layout: what it does (one line), who needs it (one line), one sentence on why it matters, plus 3-5 short punchy feature/benefit lines with an icon each. This is pitch language for a prospective user or investor, not a technical description — no architecture terms, no tech-stack names.
2. Lay that copy out as a single styled page (inline CSS, print-friendly — one page at a normal page size).
3. Generate the actual PDF. Check for an available tool in this order, using Bash only to check and only to run the one command/script that does the conversion:
   - **Headless Chrome/Edge print-to-PDF** — if a Chromium-based browser binary is on the machine (`chrome`, `google-chrome`, `chromium`, or `msedge`), run it once with `--headless --disable-gpu --print-to-pdf=<output path>` against the laid-out HTML file.
   - **Python + reportlab** — if `python -c "import reportlab"` succeeds, write a small reportlab script (via Write, not Bash) that renders the one-pager content, then run it with a single `python <script>` call.
   - **Node + puppeteer** — if `node -e "require('puppeteer')"` succeeds (already installed — do not `npm install` anything new), write a small puppeteer script that loads the HTML and calls `page.pdf()`, then run it with a single `node <script>` call.
   - If none of the three are available, stop and tell the user which one to install. Never save the HTML or Markdown copy as `one-pager.pdf` under a renamed extension — that is not a PDF and does not satisfy this step.
4. Save the final output to `project-blueprint/one-pager.pdf`. Delete any intermediate HTML/script file used only to generate it, so `project-blueprint/` ends up with exactly the three deliverables plus whatever `architecture.md`/`tech-stack.md` already had.

## Anti-patterns

- Scoping Week 1 as a feature list instead of one provable end-to-end slice.
- An mvp-plan.md that isn't traceable back to specific `architecture.md` components and `tech-stack.md` picks.
- A mockup that's a gray-box wireframe, uses lorem ipsum, or pulls in external fonts/CDNs/icon libraries.
- A one-pager written like a technical spec instead of a pitch.
- Renaming an `.html` or `.md` file to `.pdf` instead of actually generating one.
- Using Bash for anything beyond detecting and invoking the PDF generation step.

## Output report

When finished, report back to the user with:
1. Every file created, with its exact path
2. One line on what each file contains
3. Which tool actually generated the PDF (headless Chrome/Edge, reportlab, or puppeteer)
