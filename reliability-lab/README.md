# reliability-lab

A tiny order desk for reliability drills: `vendor.js` stands in for an outside AI
confirmation service, `desk.js` is the command that asks it for a message and
appends the result to `data/sent.log` — the one side effect a customer would notice.

Run: `node desk.js confirm 1001`

Set the vendor's behavior with the `VENDOR_MODE` env var before running: `ok` (default),
`slow`, `down`, or `garbage`. Example: `VENDOR_MODE=down node desk.js confirm 1001`.

Protections, outside in: circuit breaker (state in `data/breaker.json`, opens after 3 failed
operations, 10 s cooldown, one probe) → retry (3 attempts, only TimeoutError/UpstreamUnavailable)
→ 2 s deadline per attempt. On UpstreamUnavailable/BreakerOpen the desk sends a plain fallback
line marked `"fallback": true`. Whatever is about to be sent — vendor message or fallback —
must clear the quality gate (`score(message, orderId)`, threshold 70) or the send is refused as
QualityGateRejected. Sends are idempotent per order (`data/keys.json`); unsendable orders are parked
in `data/dead-letter.jsonl`, and `node desk.js replay` re-runs them and removes the ones that send.

Every run prints a one-line JSON receipt (orderId, correlationId, attempts, breakerState, gateScore,
outcome, errorName) and tags every line it prints with that run's correlation id. Test: `npm test`.

Zero dependencies. Node.js only, nothing to install.
