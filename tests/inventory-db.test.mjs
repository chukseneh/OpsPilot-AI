// Inventory database layer (STORY-004). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { openPGlite, migrate, connectPostgres, DatabaseUnavailableError, isTransient } from '../src/inventory/db.js';

const row = (over = {}) => ({
  id: 'ai-x', name: 'X', department: 'Ops', purpose: 'p', owner: 'o', status: 'active',
  data_categories: ['internal'], decision_impact: 'low', human_oversight: 'review', user_facing: false, ...over,
});
const insert = (db, r) => db.query(
  `INSERT INTO ai_systems (id, name, department, purpose, owner, status, data_categories, decision_impact, human_oversight, user_facing)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [r.id, r.name, r.department, r.purpose, r.owner, r.status, r.data_categories, r.decision_impact, r.human_oversight, r.user_facing],
);

test('the table is created, and creating it again is harmless', async () => {
  const db = await openPGlite();
  await migrate(db);
  await insert(db, row());
  await migrate(db);
  const { rows } = await db.query('SELECT id, risk_level, version FROM ai_systems');
  assert.deepEqual(rows, [{ id: 'ai-x', risk_level: 'unassessed', version: 1 }]);
  await db.close();
});

test('the database itself refuses inconsistent data', async () => {
  const db = await openPGlite();
  await migrate(db);
  const refused = [
    row({ status: 'live' }),
    row({ name: '   ' }),
    row({ data_categories: [] }),
    row({ data_categories: ['internal', 'health'] }),
    row({ decision_impact: 'huge' }),
  ];
  for (const r of refused) await assert.rejects(insert(db, r), /violates check constraint/, JSON.stringify(r));
  await insert(db, row());
  await assert.rejects(insert(db, row()), /duplicate key/);
  // A risk level must say which assessment set it.
  await assert.rejects(db.query("UPDATE ai_systems SET risk_level = 'high' WHERE id = 'ai-x'"), /risk_has_source/);
  await db.close();
});

test('a transaction commits together or not at all', async () => {
  const db = await openPGlite();
  await migrate(db);
  await assert.rejects(db.transaction(async (tx) => {
    await insert(tx, row({ id: 'a' }));
    throw new Error('something failed half way');
  }), /half way/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM ai_systems')).rows[0].n, 0);

  await db.transaction(async (tx) => { await insert(tx, row({ id: 'a' })); await insert(tx, row({ id: 'b' })); });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM ai_systems')).rows[0].n, 2);
  await db.close();
});

// ---- Failure path: database connection failure ----

test('an unreachable server fails fast with DatabaseUnavailableError after capped retries, without leaking the password', async () => {
  // Find a port nobody listens on: open one, note it, close it.
  const port = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  // A connection string carrying an obviously fake password, built in code so no
  // credential-shaped literal sits in this public repo.
  const url = new URL(`postgres://127.0.0.1:${port}/opspilot`);
  url.username = 'inventory';
  url.password = 'FAKE-test-password';
  const started = Date.now();
  await assert.rejects(
    connectPostgres({ connectionString: url.href, maxAttempts: 3, retryDelayMs: 10, onPoolError: () => {} }),
    (err) => {
      assert.ok(err instanceof DatabaseUnavailableError);
      assert.match(err.message, /gave up after 3 attempts/);
      assert.match(err.message, /ECONNREFUSED/);
      assert.ok(!err.message.includes('FAKE-test-password'), 'the password is not in the message');
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'no unbounded wait');
});

test('a server that accepts but never answers is timed out', async () => {
  const sockets = [];
  const silent = createServer((s) => sockets.push(s)); // accepts, says nothing
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      connectPostgres({ connectionString: `postgres://u@127.0.0.1:${silent.address().port}/db`, connectTimeoutMs: 100, maxAttempts: 2, retryDelayMs: 10, onPoolError: () => {} }),
      (err) => err instanceof DatabaseUnavailableError && /gave up after 2 attempts/.test(err.message),
    );
  } finally {
    for (const s of sockets) s.destroy();
    silent.close();
  }
});

test('no connection string is refused up front', async () => {
  await assert.rejects(connectPostgres({}), (err) => err instanceof DatabaseUnavailableError && /DATABASE_URL/.test(err.message));
});

test('only errors that can clear on their own are retried', () => {
  assert.equal(isTransient({ code: 'ECONNREFUSED' }), true);
  assert.equal(isTransient({ code: '57P03' }), true);
  assert.equal(isTransient({ code: '08006' }), true);
  assert.equal(isTransient({ message: 'Connection terminated due to connection timeout' }), true);
  assert.equal(isTransient({ code: '28P01', message: 'password authentication failed' }), false);
  assert.equal(isTransient({ code: '3D000', message: 'database "x" does not exist' }), false);
});
