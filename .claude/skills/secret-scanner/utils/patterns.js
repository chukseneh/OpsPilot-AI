'use strict';

/**
 * Single responsibility: define what a "secret-shaped" string looks like.
 * No file I/O, no scanning logic — just the pattern library, so new patterns
 * can be added here without touching scanFile.js or runScan.js.
 */

const SECRET_PATTERNS = [
  {
    label: 'AWS Access Key ID',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    label: 'Mandrill API Key',
    regex: /\bmd-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    label: 'Generic API key / token assignment',
    regex: /\b(api[_-]?key|apikey|token|secret)\s*[:=]\s*['"]([A-Za-z0-9._-]{16,})['"]/gi,
  },
  {
    label: 'Database connection string with embedded password',
    regex: /\b(postgres|postgresql|mysql|mssql|mongodb):\/\/[^:\s'"]+:[^@\s'"]+@[^\s'"]+/gi,
  },
  {
    label: 'Private key block',
    regex: /-----BEGIN (RSA|EC|OPENSSH|PGP|DSA) PRIVATE KEY-----/g,
  },
  {
    label: 'Bearer token in header/config',
    regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g,
  },
];

module.exports = { SECRET_PATTERNS };
