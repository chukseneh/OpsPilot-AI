'use strict';

// deadLetter.js — the parking lot for orders that could not be sent.
//
// WHY: losing the work is the one outcome that is never acceptable. Parking an
// order here WITH the reason it failed is how it gets fixed on purpose later
// (see `node desk.js replay`).
//
// Format: data/dead-letter.jsonl, one JSON object per line:
//   { orderId, errorName, detail, correlationId, [gateScore, lostPoints], deadLetteredAt }
// At most one entry per orderId (upsert): re-failing an order refreshes its
// entry instead of stacking duplicates, so replay never sends it twice.
//
// Handled: missing file (= empty), atomic rewrite via temp file + rename so a
// crash cannot leave a half-written file. NOT handled: concurrent writers
// (the desk is a single-operator CLI). A corrupt line THROWS rather than being
// skipped — silently dropping a parked order would be exactly the loss this
// file exists to prevent.

const fs = require('fs');
const path = require('path');

function corrupt(filePath, lineNumber, cause) {
  const err = new Error(`${filePath} line ${lineNumber} is not valid JSON (${cause.message})`);
  err.name = 'DeadLetterCorrupt';
  return err;
}

function readAll(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line !== '')
    .map(({ line, n }) => {
      try {
        return JSON.parse(line);
      } catch (cause) {
        throw corrupt(filePath, n, cause);
      }
    });
}

function writeAll(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  fs.renameSync(tmp, filePath);
}

// Park an order (or refresh its entry if it is already parked).
function add(filePath, { orderId, ...fields }) {
  const entry = { orderId: String(orderId), ...fields, deadLetteredAt: new Date().toISOString() };
  const entries = readAll(filePath).filter((e) => e.orderId !== entry.orderId);
  entries.push(entry);
  writeAll(filePath, entries);
  return entry;
}

function remove(filePath, orderId) {
  writeAll(filePath, readAll(filePath).filter((e) => e.orderId !== String(orderId)));
}

module.exports = { readAll, add, remove };
