'use strict';
/**
 * Non-destructive schema compatibility test (READ-ONLY).
 * Verifies required tables exist via information_schema. Does NOT create,
 * alter, or drop any table. Safe to run against production.
 *
 * Requires DATABASE_URL (Railway Postgres). Run: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/client');

const REQUIRED_TABLES = [
  'email_send_claims',
  'email_send_logs',
  'reminder_claims',
  'reminder_runs',
  'reminder_activity_queue'
];

test('all email-service + reminder tables exist (read-only information_schema)', async () => {
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES]
  );
  const found = new Set(rows.map(r => r.table_name));
  const missing = REQUIRED_TABLES.filter(t => !found.has(t));
  assert.deepEqual(missing, [], `missing required tables: ${missing.join(', ')}`);
});
