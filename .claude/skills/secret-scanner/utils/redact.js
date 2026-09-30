'use strict';

/**
 * Single responsibility: mask a matched secret so it is safe to print.
 * This is the only function in the package allowed to see a raw match and
 * a redacted string side by side — everything downstream only ever
 * receives the redacted output of this function, never the raw value.
 */

function redact(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    return '';
  }
  if (rawValue.length <= 8) {
    return '*'.repeat(rawValue.length);
  }
  const head = rawValue.slice(0, 4);
  const tail = rawValue.slice(-2);
  const maskedLength = Math.max(rawValue.length - 6, 3);
  return `${head}${'*'.repeat(maskedLength)}${tail}`;
}

module.exports = { redact };
