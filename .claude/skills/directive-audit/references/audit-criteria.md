# Directive Audit Criteria

Full checklist for auditing a file in `/directives`, derived from CLAUDE.md's Architecture (Directives row) and Directive Validation sections.

## 1. Required sections

A directive must have identifiable content covering each of the following, under any heading names (exact headings are not required — the content must exist):

| Section | Passes if the directive states... | Fails if... |
|---|---|---|
| Goal / Purpose | What outcome this SOP produces and why it exists | No stated goal, or goal is only implied by the title |
| Inputs | What information, files, or triggers this SOP needs to start | Inputs are referenced mid-document with no upfront list |
| Outputs | What artifact, state change, or decision this SOP produces | Ends without saying what "done" looks like |
| Edge cases | At least one non-happy-path scenario and what to do about it | Only describes the golden path |
| Safety constraints | Any explicit boundary (what NOT to do, escalation trigger, irreversible-action warning) | Silent on risk entirely for an SOP that touches production, money, or external comms |
| Verification | How someone confirms the SOP was followed correctly | "Just run it" with no way to check the result |

## 2. Referenced file/script existence

- Extract every file path, script name, or directory the directive names.
- Confirm each with `Glob`. A path that doesn't resolve is a hard fail on that check — do not soften it to a warning.
- Note the exact string that failed to resolve, so it's actionable.

## 3. Markdown integrity

- Every fenced code block (` ``` `) has a matching close.
- Heading levels don't skip (an `###` should not appear directly under an `#` with no `##` between, if the document otherwise uses nested structure).
- No links pointing to `[text]()`  with an empty target, and no obviously broken relative links to files that don't exist (cross-check with Glob same as section 2).

## 4. Clarity for a junior developer

Heuristic, not mechanical — judge whether someone new to the codebase could execute this without pinging a senior engineer:

- Jargon or internal shorthand used without being defined on first use
- Steps that assume unstated prior context ("then do the usual cleanup" with no definition of "usual")
- Numbered steps that are actually multiple steps compressed into one
- No example of expected output/state at key checkpoints

Flag specific sentences, don't just assert "unclear."

## Verdict thresholds

- **PASS** — all required sections present, all referenced paths resolve, no markdown integrity issues, no clarity flags.
- **NEEDS WORK** — required sections present and paths resolve, but one or more clarity flags or minor markdown issues.
- **FAIL** — any required section missing, or any referenced path does not exist.
