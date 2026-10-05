// The PostgreSQL database behind the AI system inventory (STORY-004, REQ-006).
//
// Everything above this file talks to ONE small interface, so the same SQL runs
// on a real PostgreSQL server and on PGlite (PostgreSQL compiled to run inside
// Node, used by the tests and the demo — no server, no password):
//
//   db = { query(sql, params) → { rows }, exec(sql), transaction(async (tx) => …), close() }
//   tx = { query(sql, params) → { rows } }   — everything in fn commits together or not at all
//
// connectPostgres() is the real-server path. The connection string comes from the
// caller (normally the DATABASE_URL environment variable) and is never logged or
// put into an error message: it usually holds a password. Every connection has an
// explicit connect timeout and every query an explicit time limit; reaching the
// server is retried a capped number of times, and only for errors that can clear
// on their own (refused, reset, timed out, server starting up). A wrong password
// or a missing database is not retried — trying again cannot fix it.
//
// When the database cannot be reached, callers get DatabaseUnavailableError with a
// plain explanation, never a hang. That is the "database connection failure" path.

import { SYSTEM_STATUSES, DATA_CATEGORIES, DECISION_IMPACTS, HUMAN_OVERSIGHT } from '../risk/systemData.js';

export const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'unassessed']);
export const DEFAULTS = Object.freeze({ connectTimeoutMs: 5000, queryTimeoutMs: 10000, maxAttempts: 3, retryDelayMs: 200 });

export class DatabaseUnavailableError extends Error {
  constructor(message, options) { super(message, options); this.name = 'DatabaseUnavailableError'; }
}

// The allowed values come from the same constants the code checks against, so
// the database and the code can never disagree about what a valid status is.
// They are fixed literals in this repo, never user input.
const list = (values) => values.map((v) => `'${v}'`).join(', ');
const nonBlank = (col) => `CHECK (btrim(${col}) <> '')`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_systems (
  id                 text PRIMARY KEY ${nonBlank('id')},
  name               text NOT NULL ${nonBlank('name')},
  department         text NOT NULL ${nonBlank('department')},
  purpose            text NOT NULL ${nonBlank('purpose')},
  owner              text NOT NULL ${nonBlank('owner')},
  status             text NOT NULL CHECK (status IN (${list(SYSTEM_STATUSES)})),
  risk_level         text NOT NULL DEFAULT 'unassessed' CHECK (risk_level IN (${list(RISK_LEVELS)})),
  risk_assessment_id text,
  risk_assessed_at   timestamptz,
  data_categories    text[] NOT NULL CHECK (cardinality(data_categories) > 0 AND data_categories <@ ARRAY[${list(DATA_CATEGORIES)}]::text[]),
  decision_impact    text NOT NULL CHECK (decision_impact IN (${list(DECISION_IMPACTS)})),
  human_oversight    text NOT NULL CHECK (human_oversight IN (${list(HUMAN_OVERSIGHT)})),
  user_facing        boolean NOT NULL,
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- A risk level other than 'unassessed' must say which assessment set it, and when.
  CONSTRAINT risk_has_source CHECK ((risk_level = 'unassessed') = (risk_assessment_id IS NULL)),
  CONSTRAINT risk_source_complete CHECK ((risk_assessment_id IS NULL) = (risk_assessed_at IS NULL))
);
`;

// Creates the table if it is not there. Safe to run on every start.
// Limit: it does not alter a table that already exists in an older shape.
export async function migrate(db) {
  await db.exec(SCHEMA_SQL);
}

// ---------------------------------------------------------------------------
// PGlite: real PostgreSQL inside this process. In memory unless dataDir is given.

export async function openPGlite({ dataDir } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create(dataDir ? { dataDir } : undefined);
  const wrap = (q) => ({ query: async (sql, params = []) => ({ rows: (await q.query(sql, params)).rows }) });
  return {
    kind: 'pglite',
    ...wrap(pg),
    exec: async (sql) => { await pg.exec(sql); },
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}

// ---------------------------------------------------------------------------
// A real PostgreSQL server, through the pg driver.

// Errors that can clear on their own, so trying again is worth it.
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE',
  '57P03', // the server is starting up or shutting down
  '53300', // too many connections
]);
export const isTransient = (err) => TRANSIENT_CODES.has(err?.code)
  || /^08/.test(err?.code ?? '') // SQLSTATE class 08: connection exception
  || /timeout|terminated unexpectedly|Connection terminated/i.test(err?.message ?? '');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// What went wrong, without anything that could carry the connection string.
const describe = (err) => [err?.code, err?.message].filter(Boolean).join(': ').replace(/postgres(ql)?:\/\/\S+/gi, '[connection string]');

export async function connectPostgres({
  connectionString,
  connectTimeoutMs = DEFAULTS.connectTimeoutMs,
  queryTimeoutMs = DEFAULTS.queryTimeoutMs,
  maxAttempts = DEFAULTS.maxAttempts,
  retryDelayMs = DEFAULTS.retryDelayMs,
  onPoolError = (err) => { console.error(`inventory database: idle connection failed (${describe(err)})`); },
} = {}) {
  if (!connectionString) {
    throw new DatabaseUnavailableError('No database connection string was given (set DATABASE_URL).');
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: connectTimeoutMs,
    query_timeout: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
    max: 5,
  });
  // An idle connection dropping (e.g. the server restarted) is reported, not swallowed;
  // without a listener Node would crash the whole process on it.
  pool.on('error', onPoolError);

  const unavailable = (err, what) => new DatabaseUnavailableError(`The inventory database is unavailable (${what}): ${describe(err)}`, { cause: err });

  // Prove the server answers before handing the pool out: retried, capped.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (!isTransient(err) || attempt >= maxAttempts) {
        await pool.end().catch((endErr) => onPoolError(endErr));
        throw unavailable(err, `gave up after ${attempt} attempt${attempt === 1 ? '' : 's'}`);
      }
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }

  // After connecting, a query that loses the server is reported, not retried: the
  // caller decides, because a write may or may not have landed.
  const run = async (q, sql, params) => {
    try {
      return { rows: (await q.query(sql, params)).rows };
    } catch (err) {
      if (isTransient(err)) throw unavailable(err, 'lost the connection');
      throw err;
    }
  };

  return {
    kind: 'postgres',
    query: (sql, params = []) => run(pool, sql, params),
    exec: async (sql) => { await run(pool, sql); },
    async transaction(fn) {
      let client;
      try {
        client = await pool.connect();
      } catch (err) {
        throw unavailable(err, 'could not open a connection');
      }
      let broken; // a connection that failed is thrown away, not reused
      try {
        await run(client, 'BEGIN');
        const result = await fn({ query: (sql, params = []) => run(client, sql, params) });
        await run(client, 'COMMIT');
        return result;
      } catch (err) {
        if (err instanceof DatabaseUnavailableError) broken = err;
        else await client.query('ROLLBACK').catch((rollbackErr) => { broken = rollbackErr; onPoolError(rollbackErr); });
        throw err;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}
