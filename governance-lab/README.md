# governance-lab
A small acting agent: `agent.js` proposes an action; `gate.js` checks it against `policy.json` and only on allow appends a line to `data/ledger.jsonl`.
Every decision, allow or deny, is recorded in `data/decisions.jsonl`. Anything no rule permits is denied. Nothing leaves the machine. Zero dependencies; Node.js 18+.
Run: `node run.js` (or `npm start`) from inside this folder.
Set the mode with `AGENT_MODE` = `normal` (default) | `generous` | `sloppy` | `rogue`, e.g. `AGENT_MODE=rogue node run.js`.
`data/` is run output and is git-ignored.
