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
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  _schemaEnsured = true;
}
async function query(text, params) { return pool.query(text, params); }
module.exports = { pool, ensureSchema, query };
