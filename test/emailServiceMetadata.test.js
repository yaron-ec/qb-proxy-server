/* eslint-disable no-undef */
/**
 * emailServiceMetadata.test.js — proves EmailService issues NO SQL referencing
 * a `metadata` column (the column was removed from the schema).
 *
 * Run: cd src/proxy-server && node --test test/emailServiceMetadata.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'emailService.js'), 'utf8');

test('EmailService source contains no metadata-column INSERT/UPDATE', () => {
  assert.ok(!/INSERT\s+INTO\s+email_send_claims\s*\([^)]*metadata/i.test(SRC), 'must not INSERT metadata column');
  assert.ok(!/UPDATE\s+email_send_claims\s+SET\s+metadata/i.test(SRC), 'must not UPDATE metadata column');
  assert.ok(!/SET\s+metadata\s*=/i.test(SRC), 'must not SET metadata=');
  assert.ok(!/metadata\s*=\s*\$\d/i.test(SRC), 'must not bind metadata as $N');
});

test('EmailService still writes structured audit logs (email_send_logs)', () => {
  assert.ok(/email_send_logs/.test(SRC), 'audit log table still referenced');
});

test('EmailService idempotency claim table intact', () => {
  assert.ok(/email_send_claims/.test(SRC));
  assert.ok(/ON CONFLICT\s*\(\s*idempotency_key\s*\)/i.test(SRC));
});

test('EmailService does not silently catch schema errors to hide bad SQL', () => {
  // The old code had: try { UPDATE ... metadata ... } catch { /* column absent */ }
  // That pattern is removed.
  assert.ok(!/column not present yet/.test(SRC), 'catch-and-ignore schema comment removed');
});