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
});

let _schemaEnsured = false;

async function ensureSchema() {
  if (_schemaEnsured) return;
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set — Railway Postgres is required for the reminder system');
  }
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  // node-postgres simple-query protocol executes the full multi-statement string.
  await pool.query(schema);
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