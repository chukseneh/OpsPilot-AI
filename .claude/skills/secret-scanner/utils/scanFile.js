'use strict';

const fs = require('fs');
const { SECRET_PATTERNS } = require('./patterns');
const { redact } = require('./redact');

/**
 * Single responsibility: scan ONE file's text against the pattern library
 * and return redacted findings. Never writes, never deletes, never
 * modifies the file it reads — read-only by construction, matching the
 * Skill's allowed-tools restriction one level down in plain code too.
 */

function scanFile(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { file: filePath, error: `Could not read file: ${err.code || err.message}`, findings: [] };
  }

  const lines = contents.split(/\r?\n/);
  const findings = [];

  for (const { label, regex } of SECRET_PATTERNS) {
    lines.forEach((lineText, index) => {
      // Fresh regex instance per line so the shared `g` flag's lastIndex
      // state from patterns.js never leaks between lines or files.
      const localRegex = new RegExp(regex.source, regex.flags);
      let match;
      while ((match = localRegex.exec(lineText)) !== null) {
        const rawMatch = match[0];
        findings.push({
          label,
          lineNumber: index + 1,
          redacted: redact(rawMatch),
        });
        if (!localRegex.global) break;
      }
    });
  }

  return { file: filePath, error: null, findings };
}

module.exports = { scanFile };
