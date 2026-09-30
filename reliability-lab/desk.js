'use strict';

// desk.js — the order desk.
//   node desk.js confirm <orderId>   ask the vendor, gate the answer, then "send"
//   node desk.js replay              re-run every dead-lettered order
//
// Layering, outside in:  breaker( retry( withTimeout( vendor ) ) )
//   - the breaker sees the whole operation as ONE success/failure
//   - retry re-tries only TimeoutError / UpstreamUnavailable
//   - each attempt gets its own 2 s deadline
// Then, on the way out:
//   - UpstreamUnavailable / BreakerOpen -> send the plain fallback template
//   - the QUALITY GATE judges whatever is about to be sent (vendor message or
//     fallback). Below 70 the send is refused with QualityGateRejected and the
//     order is parked — a wrong message is never sent under any name.
//   - anything that could not be sent at all -> data/dead-letter.jsonl
//
// Every run carries one correlationId. It identifies the RUN, not the order, so
// it is NOT the idempotency key. It is on every line this desk prints, on the
// sent.log line and on any dead-letter row, so one id follows one order at 2 AM.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const vendor = require('./vendor');
const deadLetter = require('./deadLetter');
const { withTimeout, retry, createBreaker, runOnce, assertQuality } = require('./reliability');

// DESK_DATA_DIR lets check-idempotency.js run against a scratch directory.
const DATA_DIR = process.env.DESK_DATA_DIR || path.join(__dirname, 'data');
const SENT_LOG = path.join(DATA_DIR, 'sent.log');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const BREAKER_FILE = path.join(DATA_DIR, 'breaker.json');
const DEAD_LETTER_FILE = path.join(DATA_DIR, 'dead-letter.jsonl');

const PER_ATTEMPT_TIMEOUT_MS = 2000;
const RETRY_OPTIONS = { attempts: 3, baseDelayMs: 500 };
const BREAKER_OPTIONS = { filePath: BREAKER_FILE, threshold: 3, cooldownMs: 10000 };

// Only these failures get the degraded-but-truthful template. TimeoutError is
// deliberately absent: an order that timed out is parked, not guessed at.
const FALLBACK_ERROR_NAMES = new Set(['UpstreamUnavailable', 'BreakerOpen']);

const breaker = createBreaker(BREAKER_OPTIONS);

// The idempotency key comes from the ORDER, never from the attempt. A fresh
// random ID per run would differ every time, so a second run would never match
// the first run's key and every retry would look like a brand-new order.
function idempotencyKey(orderId) {
  return `order:${orderId}`;
}

function fallbackMessage(orderId) {
  return `Your order ${orderId} is confirmed. Full details will follow shortly.`;
}

function appendSentLine(record) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(SENT_LOG, JSON.stringify(record) + '\n');
  return record;
}

// The one place a customer-visible line is written.
//
// Order of operations inside runOnce matters twice over:
//   1. a stored result short-circuits BEFORE the gate — it was already gated
//      once, and re-gating it could refuse a message we have already sent.
//   2. the gate runs INSIDE the claim, so a refusal releases the claim and the
//      order can be replayed later with a better message.
async function send(orderId, message, { fallback = false, correlationId }) {
  const { result, duplicate } = await runOnce(
    idempotencyKey(orderId),
    () => {
      const assessment = assertQuality(message, orderId);
      const record = {
        orderId,
        message,
        sentAt: new Date().toISOString(),
        correlationId,
        gateScore: assessment.score,
      };
      if (fallback) record.fallback = true;
      return appendSentLine(record);
    },
    { filePath: KEYS_FILE }
  );
  return { record: result, duplicate };
}

// A send() that throws for a non-quality reason (disk full, permissions) is a
// failure to deliver, not a vendor failure. Give it its own name. A gate
// refusal already has the name and the evidence, so it passes through intact.
function asSendFailure(err) {
  if (err.name === 'QualityGateRejected') return err;
  const wrapped = new Error(`Send failed (${err.name}): ${err.message}`);
  wrapped.name = 'SendFailure';
  return wrapped;
}

function park(orderId, err, correlationId) {
  const row = { orderId, errorName: err.name, detail: err.message, correlationId };
  if (err.assessment) {
    row.gateScore = err.assessment.score;
    row.gateThreshold = err.assessment.threshold;
    row.lostPoints = err.assessment.lostPoints;
  }
  deadLetter.add(DEAD_LETTER_FILE, row);
}

function currentBreakerState() {
  try {
    return breaker.getState().state;
  } catch (err) {
    return `unreadable(${err.name})`;
  }
}

// Runs one order through the full path. Never throws for an order-level
// failure; always prints a receipt and returns it.
async function confirm(orderId) {
  const correlationId = randomUUID();
  const log = (line) => console.log(`cid=${correlationId} ${line}`);

  let attempts = 0;
  const onAttempt = (n, outcome, err) => {
    attempts = n;
    log(`attempt=${n} outcome=${outcome}${err ? ` error=${err.name}` : ''}`);
  };

  // Every exit from this function goes through here, so every run ends with
  // exactly one receipt.
  const finish = (status, extra = {}) => {
    const record = extra.record || null;
    const duplicate = Boolean(extra.duplicate);
    const outcome = duplicate ? 'duplicate' : status;
    const errorName = extra.errorName || null;

    let gateScore = null;
    if (record && typeof record.gateScore === 'number') gateScore = record.gateScore;
    if (typeof extra.gateScore === 'number') gateScore = extra.gateScore;

    log(
      `order=${orderId} result=${status} attempts=${attempts}` +
        `${errorName ? ` error=${errorName}` : ''}${duplicate ? ' duplicate=true' : ''}`
    );

    // The Logged: line carries its correlationId INSIDE the JSON. For a
    // duplicate that is the id of the run that actually sent it — which is the
    // run you want to trace back to — while this run's id is on every other line.
    if (record) {
      console.log(`Logged: ${JSON.stringify(duplicate ? { ...record, duplicate: true } : record)}`);
    }

    const receipt = {
      orderId,
      correlationId,
      attempts,
      breakerState: currentBreakerState(),
      gateScore,
      outcome,
      errorName,
    };
    console.log(JSON.stringify(receipt));

    return { status, outcome, attempts, duplicate, errorName, record, correlationId, gateScore, receipt };
  };

  let message;
  try {
    message = await breaker.run(() =>
      retry(() => withTimeout(() => vendor.requestConfirmation(orderId), PER_ATTEMPT_TIMEOUT_MS), {
        ...RETRY_OPTIONS,
        onAttempt,
      })
    );
  } catch (err) {
    if (!FALLBACK_ERROR_NAMES.has(err.name)) {
      park(orderId, err, correlationId);
      return finish('dead-lettered', { errorName: err.name });
    }
    try {
      const sent = await send(orderId, fallbackMessage(orderId), { fallback: true, correlationId });
      return finish('fallback', { record: sent.record, duplicate: sent.duplicate, errorName: err.name });
    } catch (sendErr) {
      const failure = asSendFailure(sendErr);
      park(orderId, failure, correlationId);
      return finish('dead-lettered', {
        errorName: failure.name,
        gateScore: failure.assessment ? failure.assessment.score : null,
      });
    }
  }

  try {
    const sent = await send(orderId, message, { correlationId });
    return finish('sent', { record: sent.record, duplicate: sent.duplicate });
  } catch (sendErr) {
    const failure = asSendFailure(sendErr);
    park(orderId, failure, correlationId);
    return finish('dead-lettered', {
      errorName: failure.name,
      gateScore: failure.assessment ? failure.assessment.score : null,
    });
  }
}

// Re-runs every parked order through the NORMAL path (breaker, retry, gate,
// fallback). An order leaves the dead-letter only once it has actually been
// sent. If it fails again, confirm() has already refreshed its entry.
async function replay() {
  const parked = deadLetter.readAll(DEAD_LETTER_FILE);
  console.log(`replay: ${parked.length} dead-lettered order(s)`);
  let removed = 0;
  for (const { orderId } of parked) {
    console.log(`--- replaying ${orderId}`);
    const result = await confirm(orderId);
    if (result.status !== 'dead-lettered') {
      deadLetter.remove(DEAD_LETTER_FILE, orderId);
      removed += 1;
    }
  }
  const remaining = parked.length - removed;
  console.log(`replay: sent=${removed} still-dead-lettered=${remaining}`);
  return remaining;
}

async function main() {
  const [command, orderId] = process.argv.slice(2);

  try {
    if (command === 'confirm' && orderId) {
      const result = await confirm(orderId);
      // A stuck "slow" attempt leaves a dangling vendor timer behind (there is
      // no cancel button on a real vendor call), so exit explicitly.
      process.exit(result.status === 'dead-lettered' ? 1 : 0);
    } else if (command === 'replay' && !orderId) {
      const remaining = await replay();
      process.exit(remaining > 0 ? 1 : 0);
    } else {
      console.error('Usage: node desk.js confirm <orderId> | node desk.js replay');
      process.exit(2);
    }
  } catch (err) {
    // Infrastructure trouble (unreadable dead-letter, lock timeout): say so loudly.
    console.error(`desk failed: [${err.name}] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { confirm, replay, send };
