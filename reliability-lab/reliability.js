'use strict';

// reliability.js — the two protections wrapped around every outbound call:
// a per-attempt deadline (withTimeout) and a capped, backed-off retry (retry).
// withTimeout goes INSIDE, retry goes AROUND it — each attempt gets its own
// fresh deadline.

class TimeoutError extends Error {
  constructor(ms) {
    super(`Timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

// WHY: a call with no deadline is an outage that hasn't finished happening yet.
// Runs one attempt of fn() (a zero-arg function returning a promise) against a
// deadline. If fn has not settled within ms, rejects with a TimeoutError. The
// underlying call is left running — there is no cancel button on a real
// vendor call — but the caller stops waiting on it.
function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(ms));
    }, ms);

    Promise.resolve()
      .then(fn)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

// Only these failures might succeed on a later attempt. A garbage response
// (QualityGateRejected) is deliberately excluded — a wrong answer will be wrong again.
const RETRYABLE_ERROR_NAMES = new Set(['TimeoutError', 'UpstreamUnavailable']);

function isRetryable(err) {
  return Boolean(err) && RETRYABLE_ERROR_NAMES.has(err.name);
}

function delayWithJitter(baseDelayMs, attemptIndex) {
  const backoff = baseDelayMs * Math.pow(2, attemptIndex);
  const jitter = Math.random() * baseDelayMs;
  return backoff + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// WHY: the cap is the difference between a bad night and a bill. The growing
// gap and the jitter stop a thousand clients from retrying in the same second.
// Runs fn() up to `attempts` times. Only retries errors in
// RETRYABLE_ERROR_NAMES, waiting an exponentially growing, jittered gap
// between attempts. onAttempt(attemptNumber, outcome, err), if given, fires
// after every attempt so the caller can log it.
async function retry(fn, { attempts = 3, baseDelayMs = 500, onAttempt } = {}) {
  let lastError;

  for (let i = 0; i < attempts; i++) {
    const attemptNumber = i + 1;
    try {
      const value = await fn();
      if (onAttempt) onAttempt(attemptNumber, 'success', null);
      return value;
    } catch (err) {
      lastError = err;
      if (onAttempt) onAttempt(attemptNumber, 'failure', err);

      const isLastAttempt = attemptNumber === attempts;
      if (isLastAttempt || !isRetryable(err)) {
        throw err;
      }

      await sleep(delayWithJitter(baseDelayMs, i));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Circuit breaker — goes AROUND retry(), never inside it.
//
// WHY outside: a whole operation (all its retries) counts as ONE failure, so
// three exhausted operations trip it. Inside, every retry attempt would be
// judged on its own and a later success would keep resetting the count.
//
// State machine, persisted to a JSON file so it survives separate CLI runs:
//   closed    -> calls flow; 3 consecutive failed operations open it.
//   open      -> calls fail INSTANTLY with BreakerOpen; the vendor is not called.
//   half-open -> after the cooldown ONE probe call is admitted; success closes
//                the breaker, failure re-opens it (cooldown restarts).
// Any failed operation counts: a vendor that answers
// with junk is not a vendor we should keep hammering.
//
// Failure modes handled: concurrent processes (file lock makes "admit exactly
// one probe" atomic); a probe process that dies (probe slot expires after
// probeStaleMs); a lock left by a crash (stale after LOCK_STALE_MS); a corrupt
// state file (warn loudly, start closed). NOT handled: clock changes between
// runs, or a state file on a network filesystem where rename is not atomic.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

class BreakerOpenError extends Error {
  constructor(retryInMs) {
    super(`Circuit breaker is open; vendor not called (next probe in ${Math.max(0, Math.ceil(retryInMs))}ms)`);
    this.name = 'BreakerOpen';
  }
}

const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 5000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Cross-process mutex: O_EXCL create of a lock file. Bounded wait, no infinite spin.
function withFileLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lockPath);
      } catch (_) {
        // lock vanished or was reclaimed by another process between stat and
        // unlink — harmless, the next loop iteration retries the open.
      }
      if (Date.now() > deadline) {
        const timeout = new Error(`Could not acquire breaker lock ${lockPath} within ${LOCK_WAIT_MS}ms`);
        timeout.name = 'LockTimeout';
        throw timeout;
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lockPath);
  }
}

function closedState() {
  return { state: 'closed', consecutiveFailures: 0, openedAt: null, probeStartedAt: null };
}

function createBreaker({ filePath, threshold = 3, cooldownMs = 10000, probeStaleMs = 30000, now = Date.now }) {
  const lockPath = `${filePath}.lock`;

  function readState() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return closedState();
      throw err;
    }
    try {
      return { ...closedState(), ...JSON.parse(raw) };
    } catch (err) {
      console.error(`breaker: ${filePath} is corrupt (${err.name}); starting closed`);
      return closedState();
    }
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, filePath);
  }

  // Decide whether this call may reach the vendor. Throws BreakerOpen if not.
  function admit() {
    return withFileLock(lockPath, () => {
      const s = readState();
      const t = now();
      if (s.state === 'closed') return { probe: false };
      const waitMs =
        s.state === 'open' ? s.openedAt + cooldownMs - t : s.probeStartedAt + probeStaleMs - t;
      if (waitMs > 0) throw new BreakerOpenError(waitMs);
      writeState({ ...s, state: 'half-open', probeStartedAt: t });
      return { probe: true };
    });
  }

  function record(ok, probe) {
    withFileLock(lockPath, () => {
      const s = readState();
      if (ok) return writeState(closedState());
      const failures = s.consecutiveFailures + 1;
      if (probe || failures >= threshold) {
        return writeState({ state: 'open', consecutiveFailures: failures, openedAt: now(), probeStartedAt: null });
      }
      // Already opened by another process while we ran: leave its timestamps alone.
      if (s.state !== 'closed') return undefined;
      return writeState({ ...s, consecutiveFailures: failures });
    });
  }

  // Bookkeeping trouble must never turn a vendor success into a reported failure.
  function safeRecord(ok, probe) {
    try {
      record(ok, probe);
    } catch (err) {
      console.error(`breaker: could not record outcome (${err.name}): ${err.message}`);
    }
  }

  async function run(fn) {
    const { probe } = admit();
    let value;
    try {
      value = await fn();
    } catch (err) {
      safeRecord(false, probe);
      throw err;
    }
    safeRecord(true, probe);
    return value;
  }

  return { run, getState: readState };
}

// ---------------------------------------------------------------------------
// runOnce(key, fn) — idempotency. Same key => the side effect happens once.
//
// WHY claim-first: "check after" leaves a gap where two arrivals both see "not
// sent yet" and both send. Here the key is CLAIMED (durably, under a file lock)
// BEFORE fn runs, so the second arrival can never get past the claim.
//
// Ledger: data/keys.json  { "<key>": { status: 'claimed'|'done', claimedAt, completedAt?, result? } }
//   - no entry            -> claim it, run fn, store its result, status 'done'
//   - status 'done'       -> return the stored result, fn is NOT run (duplicate)
//   - status 'claimed'    -> another arrival is mid-flight: wait briefly for its
//                            result, else fail with KeyInFlight (never double-run)
//
// Failure modes handled:
//   - fn throws: the claim is released so a later retry/replay can run fn again
//     (the side effect did not complete).
//   - process dies between claim and store: the key stays 'claimed', so later
//     calls fail CLOSED with KeyInFlight — a possible missed send is triaged by a
//     human; a possible duplicate send is never risked. Clear the entry by hand
//     in keys.json once you have checked sent.log.
//   - fn succeeded but the result could not be stored: logged loudly, result is
//     still returned; the key stays 'claimed' (fail closed) as above.
//   - corrupt keys.json: throws KeysCorrupt. It is NOT treated as empty —
//     starting empty would silently re-enable every duplicate.
// NOT handled: keys are never expired or garbage-collected.
// ---------------------------------------------------------------------------

const DEFAULT_KEYS_FILE = path.join(__dirname, 'data', 'keys.json');
const CLAIM_WAIT_MS = 2000;
const CLAIM_POLL_MS = 25;

function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

function readKeys(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw namedError('KeysCorrupt', `${filePath} is not valid JSON (${cause.message})`);
  }
}

function writeKeys(filePath, keys) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

// Atomic read-modify-write of the ledger under the file lock.
function updateKeys(filePath, mutate) {
  return withFileLock(`${filePath}.lock`, () => {
    const keys = readKeys(filePath);
    const outcome = mutate(keys);
    if (outcome.write) writeKeys(filePath, keys);
    return outcome.value;
  });
}

function tryClaim(filePath, key) {
  return updateKeys(filePath, (keys) => {
    const entry = keys[key];
    if (!entry) {
      keys[key] = { status: 'claimed', claimedAt: new Date().toISOString() };
      return { write: true, value: { action: 'run' } };
    }
    if (entry.status === 'done') return { write: false, value: { action: 'duplicate', result: entry.result } };
    return { write: false, value: { action: 'wait' } };
  });
}

function release(filePath, key) {
  updateKeys(filePath, (keys) => {
    delete keys[key];
    return { write: true };
  });
}

function complete(filePath, key, result) {
  updateKeys(filePath, (keys) => {
    keys[key] = { ...keys[key], status: 'done', completedAt: new Date().toISOString(), result };
    return { write: true };
  });
}

/**
 * Run fn at most once per key, ever.
 * @returns {Promise<{result: *, duplicate: boolean}>}
 */
async function runOnce(key, fn, { filePath = DEFAULT_KEYS_FILE } = {}) {
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    const claim = tryClaim(filePath, key);
    if (claim.action === 'duplicate') return { result: claim.result, duplicate: true };
    if (claim.action === 'run') break;
    if (Date.now() > deadline) {
      throw namedError('KeyInFlight', `Key "${key}" is claimed but not completed; refusing to run it again`);
    }
    await sleep(CLAIM_POLL_MS);
  }

  let result;
  try {
    result = await fn();
  } catch (err) {
    try {
      release(filePath, key);
    } catch (releaseErr) {
      console.error(`runOnce: could not release claim "${key}" (${releaseErr.name}): ${releaseErr.message}`);
    }
    throw err;
  }

  try {
    complete(filePath, key, result);
  } catch (storeErr) {
    console.error(`runOnce: "${key}" ran but its result was not stored (${storeErr.name}): ${storeErr.message}`);
  }
  return { result, duplicate: false };
}

// ---------------------------------------------------------------------------
// Quality gate — score(message, orderId) -> 0..100, threshold 70.
//
// WHY separate from reliability: retry/breaker/timeout get an answer BACK.
// The gate decides whether that answer is worth putting in front of a customer.
// Different layers, both cheap. A vendor that fails loudly is easy; a vendor
// that answers confidently and wrongly is what this catches.
//
//   +40  the exact order id appears as a WHOLE TOKEN
//   +30  none of the banned phrases appear (case-insensitive)
//   +30  length is 20..300 characters (inclusive)
//
// "Whole token" means: split on whitespace, strip leading/trailing punctuation,
// compare exactly. So "5001." and "(5001)" count, but "5001-WRONG", "15001"
// and "50012" do NOT — which is exactly the confidently-wrong shape we are
// trying to catch. A tolerant substring match would score garbage 100.
// ---------------------------------------------------------------------------

const QUALITY_THRESHOLD = 70;
const BANNED_PHRASES = ['as an ai', 'i cannot', "i'm sorry", 'as a language model'];
const MIN_MESSAGE_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 300;

class QualityGateRejectedError extends Error {
  constructor(orderId, assessment) {
    super(
      `Quality gate rejected the message for order ${orderId}: scored ${assessment.score}/100 ` +
        `(threshold ${assessment.threshold}) — ${assessment.lostPoints.join('; ')}`
    );
    this.name = 'QualityGateRejected';
    this.assessment = assessment;
  }
}

// Strip surrounding punctuation only; anything glued INSIDE the token stays,
// so "5001-WRONG" never reduces to "5001".
function normalizeToken(token) {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function hasOrderIdToken(message, orderId) {
  const target = String(orderId);
  return message.split(/\s+/).some((token) => normalizeToken(token) === target);
}

function findBannedPhrases(message) {
  const lower = message.toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
}

/**
 * Score a candidate message. Pure, no I/O, safe to call anywhere.
 * @returns {{score:number, passed:boolean, threshold:number, checks:Array, lostPoints:string[]}}
 */
function score(message, orderId) {
  const text = typeof message === 'string' ? message : String(message ?? '');

  const idPresent = hasOrderIdToken(text, orderId);
  const banned = findBannedPhrases(text);
  const lengthOk = text.length >= MIN_MESSAGE_LENGTH && text.length <= MAX_MESSAGE_LENGTH;

  const checks = [
    { name: 'order_id_present', points: idPresent ? 40 : 0, max: 40 },
    { name: 'no_banned_phrases', points: banned.length === 0 ? 30 : 0, max: 30 },
    { name: 'length_in_range', points: lengthOk ? 30 : 0, max: 30 },
  ];

  const lostPoints = [];
  if (!idPresent) lostPoints.push(`-40 order id "${orderId}" not present as a whole token`);
  if (banned.length > 0) {
    lostPoints.push(`-30 banned phrase(s): ${banned.map((p) => `"${p}"`).join(', ')}`);
  }
  if (!lengthOk) {
    lostPoints.push(
      `-30 length ${text.length} outside ${MIN_MESSAGE_LENGTH}-${MAX_MESSAGE_LENGTH} characters`
    );
  }

  const total = checks.reduce((sum, check) => sum + check.points, 0);
  return { score: total, passed: total >= QUALITY_THRESHOLD, threshold: QUALITY_THRESHOLD, checks, lostPoints };
}

// Throwing wrapper: use where a failed gate must stop a send.
function assertQuality(message, orderId) {
  const assessment = score(message, orderId);
  if (!assessment.passed) throw new QualityGateRejectedError(orderId, assessment);
  return assessment;
}

module.exports = {
  withTimeout,
  retry,
  isRetryable,
  createBreaker,
  runOnce,
  score,
  assertQuality,
  TimeoutError,
  BreakerOpenError,
  QualityGateRejectedError,
  QUALITY_THRESHOLD,
  RETRYABLE_ERROR_NAMES,
};
