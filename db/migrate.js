#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * db/migrate.js — dedicated schema migration entry point.
 *
 * Runs db/schema.sql (via ensureSchema) then every file in db/migrations/*.sql
 * in filename order. All statements are idempotent (IF NOT EXISTS / ON CONFLICT),
 * so this is safe to re-run.
 *
 * The server does NOT run this automatically. Run BEFORE starting the service:
 *   node db/migrate.js        (or)   npm run migrate
 * Exit: 0 = all migrations applied; 1 = failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./client');

async function runMigrations() {
  await db.ensureSchema();
  console.log('[migrate] base schema ensured');
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await db.query(sql);
    console.log('[migrate] applied migration:', f);
  }
  console.log('[migrate] all migrations applied (' + files.length + ' file(s))');
}

runMigrations()
  .then(() => db.pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[migrate] FAILED:', e.message);
    db.pool.end().finally(() => process.exit(1));
  });
