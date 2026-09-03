#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * db/migrate.js — dedicated schema migration entry point with safety guarantees.
 *
 * SAFETY ARCHITECTURE:
 *   1. pg_advisory_lock — prevents concurrent migration runs across multiple
 *      deploy replicas. If another process is already migrating, this waits
 *      for the lock, then checks schema_migrations and skips already-applied
 *      files. The lock is automatically released on process exit.
 *   2. schema_migrations table — tracks which files have been applied. A file
 *      is only executed if it has NOT been recorded. This prevents destructive
 *      re-execution of already-applied migrations.
 *   3. Failed migration prevents startup — any SQL error causes exit(1), which
 *      the Dockerfile CMD chain respects (node db/migrate.js && node server.js).
 *   4. Each migration file runs in its own implicit transaction. PostgreSQL
 *      automatically rolls back the failing file on error. Files that already
 *      have a schema_migrations row are skipped entirely (no re-execution).
 *
 * The Dockerfile runs this automatically before starting the server:
 *   CMD ["sh", "-c", "node db/migrate.js && node server.js"]
 *
 * Exit: 0 = all migrations applied; 1 = failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./client');

// Stable advisory lock key for schema migrations. Must be the same across all
// replicas so concurrent deploys serialize. This is a signed 32-bit int derived
// from a fixed string.
const ADVISORY_LOCK_KEY = 0x4d494752; // 'MIGR' as int32

async function runMigrations() {
  const client = await db.pool.connect();
  try {
    // 1. Acquire advisory lock — serializes concurrent migration runs
    await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);
    console.log('[migrate] advisory lock acquired');

    // 2. Ensure base schema (email_send_claims, email_send_logs, users, refresh_tokens)
    await db.ensureSchema();
    console.log('[migrate] base schema ensured');

    // 3. Ensure schema_migrations table exists (bootstrap — this CREATE is
    //    itself idempotent and runs before any file is checked)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename     TEXT PRIMARY KEY,
        applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        checksum     TEXT
      )
    `);

    // 4. Read all migration files in filename order
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    let applied = 0;
    let skipped = 0;

    for (const f of files) {
      // Check if this migration has already been applied
      const { rows } = await client.query('SELECT filename FROM schema_migrations WHERE filename = $1', [f]);
      if (rows.length > 0) {
        skipped++;
        continue;
      }

      // Read and execute the migration file
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex').substring(0, 16);

      console.log('[migrate] applying migration:', f);
      await client.query(sql); // runs in its own implicit transaction

      // Record that this migration has been applied
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING', [f, checksum]);
      applied++;
      console.log('[migrate] applied migration:', f);
    }

    console.log(`[migrate] done — ${applied} applied, ${skipped} skipped (${files.length} total)`);
  } finally {
    // Release advisory lock — always, even on error
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
      console.log('[migrate] advisory lock released');
    } catch (e) {
      // Best-effort — process exit will release anyway
    }
    client.release();
  }
}

runMigrations()
  .then(() => db.pool.end())
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[migrate] FAILED:', e.message);
    db.pool.end().finally(() => process.exit(1));
  });