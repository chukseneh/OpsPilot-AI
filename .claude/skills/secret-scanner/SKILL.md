---
name: secret-scanner
description: Use before committing, sharing, or reviewing files in this repo, or when the user asks to check for hardcoded secrets, API keys, tokens, passwords, or database credentials in code, config, or scripts. Scans given files for common secret patterns (AWS keys, Mandrill tokens, embedded DB credentials, private key blocks, bearer tokens) and reports redacted matches with file and line number — the raw secret value is never displayed. Do NOT use for general code review, linting, or style checks; this Skill looks only for credential-shaped strings, nothing else.
allowed-tools: Read, Glob, Grep, Bash
---

# Secret Scanner

## Purpose

Catch hardcoded secrets before they leave a developer's machine, in line with this repo's Security Enforcement Layer ("No secrets in source code. No secrets in commit history."). Reports findings with enough location detail to fix them, without ever printing the secret itself in plain text.

## Package contents and how they interact

```
secret-scanner/
├── SKILL.md            <- you are here: orchestrates the other files
└── utils/
    ├── patterns.js      <- defines what a "secret-shaped" string looks like
    ├── redact.js         <- masks a raw match before it is ever displayed
    ├── scanFile.js        <- reads one file, applies patterns.js, calls redact.js
    └── runScan.js          <- entry point: loops scanFile.js over every target file, prints one JSON report
```

Call chain: `runScan.js` (called by this Skill via `Bash`) → `scanFile.js` (one file at a time) → `patterns.js` (what to look for) + `redact.js` (how to mask what was found) → JSON report back to `runScan.js` → printed to stdout.

Each file has exactly one job, matching this repo's Modular Composition Rule ("One responsibility per module"):

- **`patterns.js`** never reads a file and never redacts — it only defines regexes and labels. Adding a new secret pattern (say, a new vendor's key format) means editing only this file.
- **`redact.js`** is the single choke point that ever sees a raw matched value. Every other file downstream of it only ever handles the already-masked string — this makes it easy to verify raw secrets can't leak into the report by checking one small file instead of the whole package.
- **`scanFile.js`** is the only file that touches the filesystem, and it only ever reads (`fs.readFileSync`) — never writes, never deletes.
- **`runScan.js`** has no logic of its own beyond looping and printing — it is the thin, disposable "glue" the Skill calls, which is why it's the only file addressed directly by the procedure below.

## Why `allowed-tools` includes `Bash` here (unlike a pure-reference Skill)

This Skill's job requires *running* code, not just reading files — `Read`/`Glob`/`Grep` alone can locate candidate files but can't execute `runScan.js`, so `Bash` is included out of necessity. That is a real capability grant, unlike a Skill that can be restricted to zero execution ability. The scope is narrowed a different way instead: `Write`, `Edit`, and `NotebookEdit` are deliberately absent, so nothing this Skill does — including its use of `Bash` — can ever modify, move, or delete a file. The Constraints section below reinforces this in the procedure itself: `Bash` is to be used only to invoke `utils/runScan.js`, never for any other shell command.

## When to invoke

Invoke for: pre-commit secret checks, a direct request to "scan for secrets/keys/credentials," or reviewing a diff/PR for accidentally committed tokens.

Do NOT invoke for: general code review, style/lint checks, or dependency audits — those are different concerns handled elsewhere.

## Required Input

- **Target files or directory** — required. If the user says "this repo" or gives no target, use `Glob` to resolve a reasonable file set (e.g., changed files in the working tree, or a named directory) before scanning — never scan the entire repository including `node_modules` or build output.

## Procedure

1. Resolve the target file list using `Glob` (and `Read`/`Grep` if narrowing by content type first is useful). Exclude `node_modules`, `dist`, `build`, and other generated directories.
2. Run the scanner via `Bash`: `node utils/runScan.js <file1> <file2> ...` (paths relative to `secret-scanner/`, or pass absolute paths).
3. Parse the JSON report from stdout. The exit code is informational only (`1` means findings exist, `0` means clean) — do not treat a non-zero exit as a script failure.
4. Present findings as a table: **File | Line | Pattern | Redacted value**. Use the `redacted` field exactly as returned — never re-derive or reconstruct the raw value from context.
5. If `clean` is `true` for every scanned file, state that plainly — don't pad a clean result with hedging.
6. If any findings exist, follow this repo's stated remediation: state clearly that any matched secret must be treated as compromised, rotated immediately, and cleaned from history — per CLAUDE.md's Secrets Management rules. This Skill only reports; rotation and history-cleaning are separate, deliberate actions outside its scope.

## Constraints

- Never use `Bash` for anything other than invoking `utils/runScan.js` — no moving, deleting, or editing files through it.
- Never print a raw secret value, even partially, outside of what `utils/redact.js` already produced.
- Never modify, move, or delete any scanned file — this Skill has no `Write`/`Edit` access, and the procedure must not attempt to work around that.
- Report every match the scanner returns; do not silently drop a finding because it looks like a false positive — flag uncertainty in the table instead of omitting the row.
