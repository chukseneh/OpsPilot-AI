'use strict';

const { scanFile } = require('./scanFile');

/**
 * Entry point / orchestrator. This is the ONLY file the Skill's procedure
 * calls directly (via Bash: `node utils/runScan.js <file1> <file2> ...`).
 * It does no scanning or redaction logic itself — it just wires
 * scanFile.js across the given paths and prints one JSON report.
 * Never touches process.env, never writes to disk, never deletes anything.
 */

function main(filePaths) {
  if (filePaths.length === 0) {
    process.stderr.write('Usage: node runScan.js <file1> [file2 ...]\n');
    process.exit(2);
  }

  const results = filePaths.map(scanFile);
  const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);

  const report = {
    scannedCount: results.length,
    totalFindings,
    clean: totalFindings === 0,
    results,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(totalFindings > 0 ? 1 : 0);
}

main(process.argv.slice(2));
