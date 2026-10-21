# OpsPilot AI

An AI operations platform: it analyses how work flows through an organisation, finds
inefficiencies and risks, automates workflows with human approval for anything risky,
estimates financial impact, and keeps a tamper-evident audit trail of every action and
decision.

What it must do is in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md); the work, story by
story, is in [docs/STORIES.md](docs/STORIES.md).

## Running it

Needs Node.js 22.13 or later.

```sh
npm install
npm test                 # the whole suite (several minutes: many tests start a database)
npm run demo:web         # the real system, used end to end over its web API
```

There is one way to start the system — `startOpsPilot()` in [src/system.js](src/system.js) —
and it refuses to start without the audit log's signing key and a database, or when the
audit log is damaged or does not match its anchors.

### Settings

All settings are environment variables. **Never put them in a file in this repository**
(it is public). Use your platform's secret store.

| Variable | |
|---|---|
| `AUDIT_LOG_KEY` | **Required.** At least 32 characters; signs every audit entry. Losing it means the log can no longer be verified. |
| `DATABASE_URL` | A PostgreSQL server, **or** |
| `PGLITE_DATA_DIR` | a folder for a local PGlite database (development only). |
| `AUDIT_LOG_FILE` | Default `data/audit.jsonl`. |
| `AUDIT_LOG_ID` | Default `main`: which anchors in the database belong to this log. |
| `DOCUMENTS_DIR` | Where uploaded files are kept; default `documents` beside the audit log. |
| `GOVERNANCE_JURISDICTION` | Optional, e.g. `UK` or `EU`: whose approved governance policy applies. Unset: built-in rules. |
| `WEB_PORT` | Optional: start the JSON web API on `127.0.0.1` at this port. |
| `WEB_SECURE_COOKIES` | `true` when the API is served over HTTPS (see [Security](#security)). Default `false`. |
| `DASHBOARD_PORT` | Optional: the process-analysis dashboard on `127.0.0.1`. Its sign-in is a **demo stand-in** (it trusts the role you type); use the web API for real access. |

### First run

There are no default accounts or passwords. Create the first security officer once:

```sh
npm run create-first-admin -- --username sec.admin --display-name "Security Admin"
```

It asks for the password twice without showing it (12+ characters, not containing the
username, not a common password). For a scripted setup, pipe it in from a secret store
with `--password-stdin`; it is never accepted as an argument or an environment
variable. Once any account exists the command refuses; the security officer creates
everyone else through the API.

## The web API

JSON over HTTP, under `/api/v1`. A thin layer: every service keeps all of its own
permission checks and rules; the API only tells it who is calling, proven by a session.

### Signing in

```sh
API=http://127.0.0.1:8080/api/v1

# Sign in (the password is read from standard input, so it stays out of the shell history;
# this simple version assumes it has no " or \ in it).
read -rs PW; printf '{"username":"sec.admin","password":"%s"}' "$PW" \
  | curl -s -c jar.txt -H 'Content-Type: application/json' --data @- "$API/auth/sign-in"
# → { "user": {…}, "csrfToken": "…", "expiresAt": "…" }   (the session itself is in the cookie)

CSRF=…   # the csrfToken from that reply

curl -s -b jar.txt "$API/auth/me"                                   # reading: the cookie is enough
curl -s -b jar.txt -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"reason":"Left the company"}' "$API/accounts/bob/disable"    # changing: cookie + CSRF header
```

- **The session** is a random token in an `HttpOnly`, `SameSite=Strict` cookie. It ends after
  30 minutes unused, 8 hours after sign-in, on sign-out, or as soon as the account changes
  (role, disabled, password reset or changed).
- **Every request that changes something** (anything but `GET`) needs the `X-CSRF-Token`
  header from sign-in and a JSON body (`Content-Type: application/json`), except file uploads.
- **Sign-in failures** all say "Wrong username or password." Five wrong passwords lock the
  account for 15 minutes; more than 10 sign-ins a minute from one address get `429`.

### Statuses

| | |
|---|---|
| `200` / `201` | Done (`201`: created). |
| `202` | A simulation is still running; ask again at the `poll` address. |
| `400` | The request is wrong; `error` says why, in the service's words. |
| `401` | Not signed in, or the session has ended. |
| `403` | Your role may not do this, or the CSRF header is missing or wrong. |
| `404` | No such thing. For documents, also one you may not see: the two read the same, so document ids cannot be probed. |
| `405` | Wrong method; `Allow` lists the right ones. |
| `409` | It changed since you read it (send the version you saw), or the name is taken. |
| `413` / `415` | Body too large / not JSON (or not an accepted file type). |
| `429` | Too many sign-ins; wait for `Retry-After` seconds. |
| `500` / `503` / `504` | A server problem. You get `requestId`; the details are in the audit log under `api-<requestId>`. `504` means the work may still finish: check before retrying. |

Errors look like `{ "error": "…", "requestId": "…" }`.

### Endpoints

**Safe to repeat** means sending the same request again does nothing twice: no second
workflow, payment, document, version or assessment.

#### Accounts and sessions

| | Who | Body | |
|---|---|---|---|
| `POST /auth/sign-in` | anyone | `{ username, password }` | Sets the session cookie; returns `{ user, csrfToken, expiresAt }`. |
| `POST /auth/sign-out` | signed in | | Safe to repeat. |
| `GET /auth/me` | signed in | | Who you are. |
| `POST /auth/password` | signed in | `{ currentPassword, newPassword }` | Changes your password and ends your sessions; sign in again. A wrong current password counts toward the lockout. |
| `GET /accounts` | security officer | | Every account (never a password or hash). |
| `POST /accounts` | security officer | `{ username, displayName, role, password, reason }` | `201`; `409` if the name is taken. |
| `GET /accounts/:username` | security officer | | |
| `POST /accounts/:username/role` | security officer | `{ role, reason }` | Not on your own account. |
| `POST /accounts/:username/disable` | security officer | `{ reason }` | Not on your own account. |
| `POST /accounts/:username/enable` | security officer | `{ reason }` | Also clears a lockout. |
| `POST /accounts/:username/password-reset` | security officer | `{ newPassword, reason }` | Also clears a lockout. |

Roles: operations manager, process analyst, compliance officer, IT manager, process
manager, security officer, financial analyst, system tester, data analyst.

#### Workflows and approvals

| | Who | Body | |
|---|---|---|---|
| `POST /workflows` | process or operations manager | `{ workflowId, name, actions: [{ type, params }] }` | Low-risk steps run at once; a high-risk step waits for approval. Safe to repeat (same id, same actions). |
| `GET /workflows/:workflowId` | process, operations manager, compliance officer | | The run and every step, with its risk level and reasons. |
| `POST /workflows/:workflowId/resume` | process or operations manager | | Retries a failed workflow from the failed step; nothing that ran runs again. |
| `POST /workflows/:workflowId/steps/:step/decision` | process manager; once escalated, also operations manager or compliance officer | `{ decision: "approve" \| "reject", note }` | Never the person who started the workflow. The note is the recorded rationale. Safe to repeat. |

An approval not decided in 4 hours is escalated; at 24 hours it expires as rejected (or
as the governance policy in force says). Time passing never approves anything.

#### Documents

| | Who | Body | |
|---|---|---|---|
| `POST /documents?fileName=…&kind=…` | any role | the file itself, as `application/pdf`, `application/json` or `application/octet-stream`, up to 10 MB | Read and extracted, or stored and flagged for review. `kind` (`invoice` or `contract`) is optional; left out, it is worked out. Safe to repeat (same content, same person). |
| `GET /documents[?status=…]` | any role | | Your own uploads; reviewers see all. |
| `GET /documents/:documentId` | any role | | Yours, or any if you are a reviewer. |
| `POST /documents/:documentId/review` | compliance officer or financial analyst | `{ decision: "accept" \| "reject", corrections, kind, note, expectedVersion }` | Only a flagged document; never your own upload; corrections must pass the same checks as extraction. |
| `GET /documents/due-for-deletion` | compliance officer or financial analyst | | Past the retention period in force. Nothing is deleted automatically. |

#### Inventory, risk and ROI

| | Who | Body | |
|---|---|---|---|
| `GET /inventory` | IT manager, compliance or security officer, operations manager | | Every registered AI system with its risk level. |
| `POST /inventory/systems` | IT manager | `{ system, reason }` | `201` new, `200` unchanged, `409` registered with different details. |
| `POST /inventory/systems/:systemId/status` | IT manager | `{ status, expectedVersion, reason }` | `409` if it changed since you read it. |
| `POST /risk/assessments` | compliance or security officer, operations manager | `{ assessmentId, systems }` | Assesses the systems given. Safe to repeat. |
| `POST /risk/assessments/inventory` | compliance or security officer, operations manager | `{ assessmentId }` | Assesses everything registered and records each rating in the inventory (only when the assessment completed). Safe to repeat. |
| `POST /roi/scenarios` | financial analyst or operations manager | `{ scenarioId, assumptions }` | Savings, costs, range, payback, with every formula; implausible assumptions are flagged `needs_review`. Safe to repeat. |
| `GET /roi/scenarios`, `GET /roi/scenarios/:scenarioId` | financial analyst or operations manager | | |

#### Governance, audit and simulation

| | Who | Body | |
|---|---|---|---|
| `POST /governance/proposals` | compliance officer | `{ policy, effectiveFrom, reason }` | A new version; refused with every problem if misconfigured. Safe to repeat. |
| `POST /governance/:jurisdiction/versions/:version/approve` | compliance or security officer | `{ note }` | Never the proposer (two-person rule). |
| `POST /governance/:jurisdiction/versions/:version/reject` | compliance or security officer | `{ note }` | |
| `GET /governance/:jurisdiction/versions` | compliance or security officer | | Every version, with its diff. |
| `GET /governance/:jurisdiction/active` | any role | | The policy in force; `404` if none. |
| `GET /audit?correlationId=&actorId=&action=&from=&to=&after=&limit=` | security or compliance officer (or as the policy in force says) | | A page of entries, `nextAfter` for the next page, and `integrity`: whether the log has been tampered with. `action=governance.` matches a prefix. |
| `POST /simulations` | system tester or process manager | `{ runId, generate: { seed, workflows } }` or `{ runId, scenario }`, optional `timeoutMs` | Runs in an isolated sandbox on synthetic data only. `200` with the report if done within 20 s; otherwise `202` and it carries on. Safe to repeat. |
| `GET /simulations`, `GET /simulations/:runId` | system tester or process manager | | `202` while a run is still going. |

All paths above are under `/api/v1`.

## Security

- **The API listens on `127.0.0.1` only.** To reach it from other machines, put a reverse
  proxy that terminates TLS in front of it, and set `WEB_SECURE_COOKIES=true`. The sign-in
  rate limit counts by connecting address — behind a proxy that is the proxy — so set a
  limit at the proxy too.
- **Passwords** are hashed with scrypt, each with its own salt. **Session and CSRF tokens**
  are stored only as hashes, so a copy of the database cannot be used to sign in.
- **The audit log** records every API request (who, what, the status, and the reason for a
  refusal), and every service's actions and decisions, each decision with its rationale.
  It never holds a password, password hash, session token, CSRF token or request body.
  Entries are signed with `AUDIT_LOG_KEY` and chained, and anchored in the database, so
  editing or removing one is detected.
- **Repairing a damaged audit log** (`repairAuditLog` in [src/audit/storage.js](src/audit/storage.js))
  is a security officer's job done **with the system stopped**; it is deliberately not
  offered over the API, because it rewrites the file the running server appends to.
- **Server errors** never send internal details to the caller; they go to the audit log.

## Demos and tests

Each story has a demo in [src/demo/](src/demo/), run with `node src/demo/<name>.js`
(`run`, `analyse`, `riskAssessment`, `inventory`, `automation`, `audit`, `documents`,
`roi`, `governance`, `simulation`, `dashboard`, `web`). They use temporary folders and
stand-ins for outside services — nothing connects to Microsoft 365, Google, a CRM or any
network beyond this machine.

`npm test` runs every test. The web API's tests are `tests/web-*.test.mjs`; they run over
real HTTP.
