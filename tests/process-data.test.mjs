// Process event log validation (STORY-002). Run with: node --test "tests/*.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateDataset, missingDataNotice } from '../src/analysis/processData.js';

const ev = (caseId, activity, start, end, actor = 'clerk-1') =>
  ({ caseId, activity, actor, startedAt: `2026-09-01T${start}:00Z`, endedAt: `2026-09-01T${end}:00Z` });

const complete = () => ({
  process: 'Invoice approval',
  events: [
    ev('C1', 'Receive', '09:00', '09:05'), ev('C1', 'Approve', '10:00', '10:10'),
    ev('C2', 'Receive', '09:10', '09:15'), ev('C2', 'Approve', '11:00', '11:05'),
    ev('C3', 'Receive', '09:20', '09:30'), ev('C3', 'Approve', '12:00', '12:20'),
  ],
});

test('a complete event log is accepted and normalised', () => {
  const v = validateDataset(complete());
  assert.equal(v.ok, true);
  assert.deepEqual(v.problems, []);
  assert.equal(v.process, 'Invoice approval');
  assert.equal(v.events.length, 6);
  assert.deepEqual(v.events[0], {
    row: 1, caseId: 'C1', activity: 'Receive', actor: 'clerk-1',
    start: Date.parse('2026-09-01T09:00:00Z'), end: Date.parse('2026-09-01T09:05:00Z'),
  });
  assert.equal(missingDataNotice(v), null);
});

test('missing fields are reported with the exact row, case and field, and no events are released', () => {
  const data = complete();
  delete data.events[1].endedAt;
  data.events[3].actor = '  ';
  data.events[4].caseId = null;
  const v = validateDataset(data);

  assert.equal(v.ok, false);
  assert.deepEqual(v.events, [], 'nothing to analyse when data is incomplete');
  assert.deepEqual(v.problems, [
    { scope: 'row', row: 2, caseId: 'C1', field: 'endedAt', problem: 'is missing' },
    { scope: 'row', row: 4, caseId: 'C2', field: 'actor', problem: 'is missing' },
    { scope: 'row', row: 5, caseId: null, field: 'caseId', problem: 'is missing' },
  ]);
});

test('timestamps must be ISO 8601 with a time zone, and must not end before they start', () => {
  const data = complete();
  data.events[0].startedAt = '2026-09-01 09:00'; // no zone: ambiguous
  data.events[2].endedAt = 'yesterday';
  data.events[5].endedAt = '2026-09-01T11:00:00Z'; // before its 12:00 start
  const fields = validateDataset(data).problems.map((p) => `${p.row}:${p.field}:${p.problem}`);
  assert.deepEqual(fields, [
    '1:startedAt:is not an ISO 8601 timestamp with a time zone',
    '3:endedAt:is not an ISO 8601 timestamp with a time zone',
    '6:endedAt:is before startedAt',
  ]);
  assert.equal(validateDataset({ ...complete(), events: [{ ...complete().events[0], startedAt: '2026-09-01T09:00:00+01:00' }] }).problems
    .some((p) => p.field === 'startedAt'), false, 'an explicit offset is fine');
});

test('a data set too small or malformed to analyse is refused with a dataset-level reason', () => {
  assert.match(validateDataset({ process: 'X', events: complete().events.slice(0, 4) }).problems[0].problem, /only 2 complete cases; at least 3/);
  assert.match(validateDataset({ process: 'X', events: [] }).problems[0].problem, /empty/);
  assert.match(validateDataset({ events: complete().events }).problems[0].problem, /process name is missing/);
  assert.match(validateDataset(null).problems[0].problem, /not a process event log/);
  assert.match(validateDataset({ process: 'X' }).problems[0].problem, /list of events is missing/);
  assert.equal(validateDataset({ process: 'X', events: [42] }).problems[0].problem, 'is not an event object');
});

test('the notice tells the user what is missing, grouped, with rows and cases', () => {
  const data = complete();
  for (let i = 0; i < 14; i += 1) data.events.push({ ...ev(`D${i}`, 'Pay', '13:00', '13:05'), endedAt: undefined });
  data.events[0].actor = '';
  const notice = missingDataNotice(validateDataset(data));

  assert.match(notice, /^The analysis was not run because the data is incomplete/);
  assert.match(notice, /- "endedAt" is missing in 14 rows \(rows 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 and 4 more; cases D0, D1/);
  assert.match(notice, /- "actor" is missing in 1 row \(row 1; case C1\)\./);
});
