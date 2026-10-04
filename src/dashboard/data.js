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

// A record counts as a usable report only if it has EVERY field the pages read.
// Anything less is "damaged": skipped and counted, never passed on to break a page.
const str = (v) => typeof v === 'string';
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const isFinding = (f) => f && typeof f === 'object' && str(f.id) && str(f.type) && str(f.title) && str(f.explanation)
  && (f.exampleCases === undefined || (Array.isArray(f.exampleCases) && f.exampleCases.every((c) => c && str(c.caseId))));
export const isReport = (r) => Boolean(r) && typeof r === 'object'
  && str(r.analysisId) && str(r.process) && str(r.generatedAt) && str(r.requestedBy?.id)
  && num(r.scope?.cases) && num(r.scope?.events) && str(r.scope?.period?.from) && str(r.scope?.period?.to)
  && str(r.summary?.headline) && num(r.summary?.bottlenecks) && num(r.summary?.duplicates) && num(r.summary?.automationCandidates)
  && Array.isArray(r.findings) && r.findings.every(isFinding)
  && Array.isArray(r.method?.rules) && r.method.rules.every(str)
  && Array.isArray(r.limitations) && r.limitations.every(str);

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

  // Completed analyses, newest first:
  //   { analyses: [summary], skipped: number, latestReport: full report of analyses[0] or null }
  // One read of the store: the latest report comes from the same read as the list,
  // so the two can never disagree and nothing is parsed twice.
  // analysisId in each summary is the id the record is STORED under — the id that
  // links and getAnalysis() use — whatever the report itself says.
  async function listAnalyses() {
    const entries = await read('the saved analyses', () => store.list());
    if (!Array.isArray(entries)) throw new DashboardDataError('The saved analyses are not in the expected format');
    const analyses = [];
    const reports = new Map();
    let skipped = 0;
    for (const { id, record } of entries) {
      if (record?.status !== 'completed') continue; // missing data / interrupted: no report exists
      const report = record.result?.report;
      if (!isReport(report)) { skipped += 1; continue; }
      reports.set(id, report);
      analyses.push({
        analysisId: id,
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
    return { analyses, skipped, latestReport: analyses.length ? reports.get(analyses[0].analysisId) : null };
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
