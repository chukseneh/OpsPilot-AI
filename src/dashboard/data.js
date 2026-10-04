// Where the dashboard gets its data: the reports the STORY-002 analysis service
// saved in its result store (records shaped { status, fingerprint, result: { report } }).
// The dashboard only reads — it never runs or changes an analysis.
//
// Failures:
//   - the store cannot be read (unreadable or corrupted file, a read that throws,
//     or one slower than timeoutMs) → DashboardDataError, so the page can say
//     "could not load" instead of crashing or showing a misleading empty list;
//   - a single damaged record (no report in it) is skipped and counted, so one
//     bad entry cannot take the whole dashboard down.
//
// The time limit is enforced around each read. Today's stores read a local file
// synchronously, so it only bites for a store that reads over a network; a
// corrupted file is still caught as a read failure.

export const DEFAULT_TIMEOUT_MS = 5000;

export class DashboardDataError extends Error {
  constructor(message, options) { super(message, options); this.name = 'DashboardDataError'; }
}

const isReport = (r) => r && typeof r === 'object' && typeof r.analysisId === 'string'
  && r.summary && Array.isArray(r.findings) && r.scope;

export function createDashboardData({ store, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!store || typeof store.list !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('createDashboardData needs a result store with list() and get()');
  }

  // Runs one store read under the time limit; any failure becomes DashboardDataError.
  async function read(what, fn) {
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DashboardDataError(`Reading ${what} took longer than ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(fn), timedOut]);
    } catch (err) {
      if (err instanceof DashboardDataError) throw err;
      throw new DashboardDataError(`Could not read ${what}: ${err?.message ?? String(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  // Completed analyses, newest first: { analyses: [summary], skipped: number }.
  async function listAnalyses() {
    const entries = await read('the saved analyses', () => store.list());
    if (!Array.isArray(entries)) throw new DashboardDataError('The saved analyses are not in the expected format');
    const analyses = [];
    let skipped = 0;
    for (const { id, record } of entries) {
      if (record?.status !== 'completed') continue; // missing data / interrupted: no report exists
      const report = record.result?.report;
      if (!isReport(report)) { skipped += 1; continue; }
      analyses.push({
        analysisId: report.analysisId ?? id,
        process: report.process,
        generatedAt: report.generatedAt,
        requestedBy: report.requestedBy?.id ?? 'unknown',
        period: report.scope.period,
        cases: report.scope.cases,
        headline: report.summary.headline,
        counts: {
          bottlenecks: report.summary.bottlenecks,
          duplicates: report.summary.duplicates,
          automationCandidates: report.summary.automationCandidates,
        },
      });
    }
    analyses.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0)
      || (a.analysisId < b.analysisId ? -1 : 1));
    return { analyses, skipped };
  }

  // One completed analysis's full report, or null if there is none by that id.
  async function getAnalysis(analysisId) {
    if (typeof analysisId !== 'string' || !analysisId) return null;
    const record = await read(`analysis ${analysisId}`, () => store.get(analysisId));
    if (record?.status !== 'completed') return null;
    const report = record.result?.report;
    if (!isReport(report)) throw new DashboardDataError(`The saved analysis ${analysisId} is damaged and cannot be shown`);
    return report;
  }

  return { listAnalyses, getAnalysis };
}
