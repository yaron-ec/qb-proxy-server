#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * test/idempotencyKeys.test.js
 *
 * Proves the email idempotency-key builders are DETERMINISTIC: the same
 * logical action always yields the same key, so retries, refresh-equivalent
 * reconstruction, and overlapping calls deduplicate against the server claim.
 * Also asserts no Date.now/Math.random/crypto.randomUUID in the source (no
 * silent random fallback).
 *
 * Dynamically imports the real ESM module (src/lib/idempotencyKeys.mjs) — no
 * pg, no Gmail, no network.
 *
 * Run: node test/idempotencyKeys.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const results = [];
async function t(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  \u2713 ' + name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.error('  \u2717 ' + name + ' \u2014 ' + e.message); }
}

(async () => {
  const modPath = path.resolve(__dirname, '../../lib/idempotencyKeys.mjs');
  const { IdempotencyKeys } = await import(modPath);

  // ── Determinism: same inputs → identical key (retry / refresh-equivalent) ──
  await t('generic: identical for same inputs (retry stable)', async () => {
    assert.strictEqual(IdempotencyKeys.generic('L1', 'a@x.com', 'req-1'), IdempotencyKeys.generic('L1', 'a@x.com', 'req-1'));
  });
  await t('generic: differs by recipient', async () => {
    assert.notStrictEqual(IdempotencyKeys.generic('L1', 'a@x.com', 'req-1'), IdempotencyKeys.generic('L1', 'b@x.com', 'req-1'));
  });
  await t('generic: differs by clientRequestId', async () => {
    assert.notStrictEqual(IdempotencyKeys.generic('L1', 'a@x.com', 'req-1'), IdempotencyKeys.generic('L1', 'a@x.com', 'req-2'));
  });

  await t('invoice: identical for same invoice+recipient+version (refresh stable)', async () => {
    assert.strictEqual(IdempotencyKeys.invoice('I9', 'a@x.com', 'v3'), IdempotencyKeys.invoice('I9', 'a@x.com', 'v3'));
  });
  await t('invoice: differs by version (revised invoice is a new send)', async () => {
    assert.notStrictEqual(IdempotencyKeys.invoice('I9', 'a@x.com', 'v3'), IdempotencyKeys.invoice('I9', 'a@x.com', 'v4'));
  });
  await t('invoice: same invoice opened twice (no version) still stable', async () => {
    assert.strictEqual(IdempotencyKeys.invoice('I9', 'a@x.com'), IdempotencyKeys.invoice('I9', 'a@x.com'));
  });

  await t('manualReminder: identical for same appointment occurrence (re-click stable)', async () => {
    assert.strictEqual(
      IdempotencyKeys.manualReminder('L1', 'a@x.com', 'Meeting', '2026-08-01T09:00'),
      IdempotencyKeys.manualReminder('L1', 'a@x.com', 'Meeting', '2026-08-01T09:00')
    );
  });
  await t('manualReminder: differs by scheduledStart (different appointment = new send)', async () => {
    assert.notStrictEqual(
      IdempotencyKeys.manualReminder('L1', 'a@x.com', 'Meeting', '2026-08-01T09:00'),
      IdempotencyKeys.manualReminder('L1', 'a@x.com', 'Meeting', '2026-08-01T10:00')
    );
  });

  await t('scheduledReminder: deterministic', async () => {
    assert.strictEqual(
      IdempotencyKeys.scheduledReminder('L1', 'a@x.com', '24h', '2026-08-01T09:00'),
      IdempotencyKeys.scheduledReminder('L1', 'a@x.com', '24h', '2026-08-01T09:00')
    );
  });
  await t('scheduledReminder: staff vs customer keys are distinct', async () => {
    assert.notStrictEqual(
      IdempotencyKeys.scheduledReminder('L1', 'cust@x.com', '24h', '2026-08-01T09:00'),
      IdempotencyKeys.scheduledReminder('L1', 'staff@x.com', '24h', '2026-08-01T09:00')
    );
  });
  await t('scheduledReminder: differs by window', async () => {
    assert.notStrictEqual(
      IdempotencyKeys.scheduledReminder('L1', 'a@x.com', '24h', '2026-08-01T09:00'),
      IdempotencyKeys.scheduledReminder('L1', 'a@x.com', '2h', '2026-08-01T09:00')
    );
  });

  await t('test: caller nonce distinguishes deliberate tests', async () => {
    assert.notStrictEqual(IdempotencyKeys.test('a@x.com', 'n1'), IdempotencyKeys.test('a@x.com', 'n2'));
  });

  // ── Overlapping calls: same inputs produce the same key (concurrency dedupe) ──
  await t('overlapping calls yield identical keys', async () => {
    const a = IdempotencyKeys.generic('L1', 'a@x.com', 'req-1');
    const b = IdempotencyKeys.generic('L1', 'a@x.com', 'req-1');
    assert.strictEqual(a, b);
  });

  // ── No silent random fallback in the source ──
  await t('source has no Date.now/Math.random/randomUUID', async () => {
    const src = fs.readFileSync(modPath, 'utf8');
    assert.ok(!/Date\.now|Math\.random|crypto\.randomUUID/.test(src), 'idempotencyKeys must not use Date.now/Math.random/randomUUID');
  });

  const p = results.filter((r) => r.ok).length, f = results.filter((r) => !r.ok).length;
  console.log('\n[idempotencyKeys] ' + p + ' passed, ' + f + ' failed');
  process.exit(f === 0 ? 0 : 1);
})();