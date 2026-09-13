/* eslint-disable no-undef */
/**
 * Railway PostgreSQL client + idempotent schema bootstrap.
 *
 * Env: DATABASE_URL (provided by Railway Postgres).
 *      DATABASE_SSL=false to disable SSL (default: SSL on, rejectUnauthorized false).
 *
 * ensureSchema() runs db/schema.sql once per process. All operational state
 * for the reminder system lives here — Base44 is never used for any of it.
 */
'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_MAX || '5', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', (client) => {
  client.query("SET statement_timeout = '10s'").catch(() => {});
  client.query("SET idle_in_transaction_session_timeout = '30s'").catch(() => {});
});

pool.on('error', (err, client) => {
  console.error('[db] pool error:', err.message);
});

let _schemaEnsured = false;

async function ensureSchema() {
  if (_schemaEnsured) return;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set — Railway Postgres is required for the reminder system');
  }
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  // Use a dedicated client with no statement_timeout for schema execution.
  // The pool's global statement_timeout = 10s (set in pool.on('connect'))
  // would kill CREATE INDEX / CREATE EXTENSION on large tables during the
  // first run. Schema statements use IF NOT EXISTS so they're no-ops on
  // existing tables, but the first run on a large dataset needs no timeout.
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
    // node-postgres simple-query protocol executes the full multi-statement string.
    await client.query(schema);
  } finally {
    client.release();
  }
  _schemaEnsured = true;
  // Truthfully list every table ensured — derived from schema.sql so the log
  // can never drift from the actual schema source of truth.
  const tables = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  console.log(`[db] schema ensured (${tables.join(', ')})`);
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, ensureSchema, query };