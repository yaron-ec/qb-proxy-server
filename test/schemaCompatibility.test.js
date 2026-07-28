'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/client');
const REQUIRED = ['email_send_claims','email_send_logs','reminder_claims','reminder_runs','reminder_activity_queue'];
test('required email + reminder tables exist (READ-ONLY information_schema)', async () => {
  const { rows } = await db.query('SELECT table_name FROM information_schema.tables WHERE table_schema=\'public\' AND table_name = ANY($1::text[])', [REQUIRED]);
  const found = new Set(rows.map(r => r.table_name));
  const missing = REQUIRED.filter(t => !found.has(t));
  assert.deepEqual(missing, [], 'missing tables: '+missing.join(', '));
});
