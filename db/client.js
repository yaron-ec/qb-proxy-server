/* eslint-disable no-undef */
/**
 * Railway PostgreSQL client + idempotent schema bootstrap.
 *
 * Env: DATABASE_URL (provided by Railway Postgres).
 *      DATABASE_SSL=false to disable SSL (default: SSL on, rejectUnauthorized false).
 *
 * Base schema (db/schema.sql) — WHO runs the DDL:
 *   db/migrate.js (deploy time, under its migration advisory lock) is the ONE
 *   place that executes schema.sql: applyBaseSchema() runs it and records its
 *   checksum in schema_migrations ('__base_schema__').
 *
 *   ensureSchema() — called lazily by request handlers and by every worker run
 *   (the reminder worker is a 15-minute cron that starts a fresh process each tick)
 *   — only VERIFIES that checksum with a plain SELECT. It executes DDL only if
 *   the recorded checksum is missing/stale (a fresh dev/test database, or a
 *   worker deployed with a newer schema.sql before the API migrated), and then
 *   only under the same migration advisory lock with a bounded lock_timeout.
 *
 *   Why: schema.sql is 60+ ALTER TABLE / CREATE INDEX statements. ALTER TABLE
 *   takes an AccessExclusiveLock even when "IF NOT EXISTS" makes it a no-op, so
 *   re-running it at runtime (every cron tick, every process's first request)
 *   interleaved table locks with live intake transactions. That produced a real
 *   lock-order deadlock (see test/integration/leadIntakeConcurrency.int.test.js):
 *   the DDL session held reminder_leads and wanted owners, while a lead-capture
 *   transaction held owners (owner resolution) and wanted reminder_leads (the
 *   reminder projection) → "deadlock detected" → "Submission failed".
 *
 * All operational state for the reminder system lives here — Base44 is never
 * used for any of it.
 */
'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_MAX || '5', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const SET_DEFAULT_STATEMENT_TIMEOUT = "SET statement_timeout = '10s'";
pool.on('connect', (client) => {
  client.query(SET_DEFAULT_STATEMENT_TIMEOUT).catch(() => {});
  client.query("SET idle_in_transaction_session_timeout = '30s'").catch(() => {});
});

pool.on('error', (err, client) => {
  console.error('[db] pool error:', err.message);
});

// Same key db/migrate.js holds while migrating — schema DDL is never run by two
// sessions at once, and never concurrently with a migration.
const MIGRATION_LOCK_KEY = 0x4d494752; // 'MIGR' as int32
const BASE_SCHEMA_MARKER = '__base_schema__';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let _schemaSql = null;
function baseSchema() {
  if (!_schemaSql) {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    _schemaSql = { sql, checksum: crypto.createHash('sha256').update(sql).digest('hex').substring(0, 16) };
  }
  return _schemaSql;
}

/** Is the current schema.sql already applied (checksum recorded)? Plain SELECT, no DDL locks. */
async function baseSchemaCurrent(q) {
  try {
    const r = await q('SELECT checksum FROM schema_migrations WHERE filename = $1', [BASE_SCHEMA_MARKER]);
    return !!(r.rows[0] && r.rows[0].checksum === baseSchema().checksum);
  } catch (e) {
    if (e.code === '42P01') return false; // schema_migrations not created yet (fresh database)
    throw e;
  }
}

/**
 * Execute db/schema.sql on `client` and record its checksum. The caller MUST
 * hold the migration advisory lock (db/migrate.js does; ensureSchema below
 * takes it). Skips the DDL entirely when the recorded checksum already matches
 * (every statement is IF NOT EXISTS / idempotent, so re-running an unchanged
 * file is a pure no-op apart from the table locks it would take).
 */
async function applyBaseSchema(client, { force = false } = {}) {
  const { sql, checksum } = baseSchema();
  if (!force && await baseSchemaCurrent((t, p) => client.query(t, p))) return { applied: false };
  // statement_timeout 0: CREATE INDEX / CREATE EXTENSION on a large table must
  // not be killed by the pool's 10s default on a first run. Restored after, so
  // the pooled connection never leaks an unlimited timeout to later queries.
  await client.query('SET statement_timeout = 0');
  try {
    // node-postgres simple-query protocol executes the full multi-statement string.
    await client.query(sql);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename     TEXT PRIMARY KEY,
        applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum     TEXT
      )`);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
       ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = NOW()`,
      [BASE_SCHEMA_MARKER, checksum]);
  } finally {
    await client.query(SET_DEFAULT_STATEMENT_TIMEOUT).catch(() => {});
  }
  // Truthfully list every table ensured — derived from schema.sql so the log
  // can never drift from the actual schema source of truth.
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  console.log(`[db] base schema applied (${tables.join(', ')})`);
  return { applied: true };
}

let _schemaEnsured = false;
let _ensuring = null;

/**
 * Runtime schema check (once per process; concurrent callers share one
 * promise). Normally a single SELECT. Only when the base schema was never
 * recorded / changed does it apply it — under the migration advisory lock, with
 * lock_timeout so a runtime DDL can never sit in the lock queue behind (and in
 * front of) live traffic.
 */
async function ensureSchema() {
  if (_schemaEnsured) return;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set — Railway Postgres is required for the reminder system');
  }
  if (!_ensuring) {
    _ensuring = (async () => {
      if (await baseSchemaCurrent(query)) return;
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        try {
          await client.query("SET lock_timeout = '5s'");
          await applyBaseSchema(client);
        } finally {
          await client.query('RESET lock_timeout').catch(() => {});
          await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
        }
      } finally {
        client.release();
      }
    })();
  }
  try {
    await _ensuring;
    _schemaEnsured = true;
  } finally {
    _ensuring = null;
  }
}

/**
 * Add columns that may be missing, WITHOUT taking a table lock when they
 * already exist (the normal case). `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
 * takes an AccessExclusiveLock even when the column exists, which queues behind
 * every open transaction on the table and blocks everything behind it — so the
 * catalog is checked first and ALTER only runs for genuinely missing columns.
 * @param {string} table
 * @param {Array<[string, string]>} columns  [name, type-and-default SQL]
 */
async function ensureColumns(table, columns) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`, [table]);
  const have = new Set(r.rows.map(x => x.column_name));
  for (const [name, type] of columns) {
    if (have.has(name)) continue;
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, ensureSchema, applyBaseSchema, ensureColumns, query, MIGRATION_LOCK_KEY };
