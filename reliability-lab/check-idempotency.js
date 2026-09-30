'use strict';

// check-idempotency.js — re-runnable proof that the desk's send is idempotent.
// Run it with:  npm test   (or: node check-idempotency.js)
//
// Deliberately NOT named test-*/*.test.*/*_test: this project's own test runner
// must never mistake it for one of its tests. Plain script, no framework:
// prints what it checked and exits non-zero if any assertion fails.
//
// It runs `confirm 4001` twice with VENDOR_MODE=ok against a scratch data
// directory (DESK_DATA_DIR) — so it is repeatable and never touches data/ —
// and asserts:
//   1. sent.log gained exactly ONE line for order 4001
//   2. the second run reported "duplicate": true (the first did not)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ORDER_ID = '4001';
const DESK = path.join(__dirname, 'desk.js');
const RUN_TIMEOUT_MS = 20000;

function runConfirm(dataDir) {
  const run = spawnSync(process.execPath, [DESK, 'confirm', ORDER_ID], {
    env: { ...process.env, VENDOR_MODE: 'ok', DESK_DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
  });
  const loggedLine = (run.stdout || '').split('\n').find((l) => l.startsWith('Logged: '));
  return {
    exitCode: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    logged: loggedLine ? JSON.parse(loggedLine.slice('Logged: '.length)) : null,
  };
}

function linesForOrder(dataDir) {
  const file = path.join(dataDir, 'sent.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .filter((l) => JSON.parse(l).orderId === ORDER_ID);
}

function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-idempotency-'));
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(message);
  };

  try {
    const first = runConfirm(dataDir);
    const second = runConfirm(dataDir);
    const lines = linesForOrder(dataDir);

    console.log(`run 1: exit=${first.exitCode} duplicate=${first.logged ? Boolean(first.logged.duplicate) : 'n/a'}`);
    console.log(`run 2: exit=${second.exitCode} duplicate=${second.logged ? Boolean(second.logged.duplicate) : 'n/a'}`);
    console.log(`sent.log lines for order ${ORDER_ID}: ${lines.length}`);
    lines.forEach((l) => console.log(`  ${l}`));

    expect(first.exitCode === 0, `run 1 exited ${first.exitCode}, expected 0 (stderr: ${first.stderr.trim()})`);
    expect(second.exitCode === 0, `run 2 exited ${second.exitCode}, expected 0 (stderr: ${second.stderr.trim()})`);
    expect(lines.length === 1, `sent.log has ${lines.length} lines for order ${ORDER_ID}, expected exactly 1`);
    expect(first.logged && first.logged.duplicate !== true, 'run 1 reported duplicate: true, expected it to send');
    expect(second.logged && second.logged.duplicate === true, 'run 2 did not report duplicate: true');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('\nFAIL check-idempotency');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log('\nPASS check-idempotency');
}

main();
