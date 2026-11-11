/* eslint-disable no-undef */
'use strict';

/**
 * auditQbEstimateEmailStatus.int.test.js — real-Postgres proof of
 * scripts/auditQbEstimateEmailStatus.js#buildReport: the one-time empirical
 * audit named in lib/estimateSentDetection.js's own header as the concrete
 * next step to resolve, from real production data rather than a guess,
 * whether QuickBooks' own EmailStatus ever actually reads 'EmailSent' for
 * this installation's estimates. Pure read-only — proves it issues no
 * writes and never fabricates a verdict either way.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, buildReport;
const RUN = `aqes${Date.now().toString(36)}`;

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  ({ buildReport } = require(path.join(ROOT, 'scripts/auditQbEstimateEmailStatus')));
  await db.query(`DELETE FROM handoff_estimates WHERE customer_name LIKE $1`, [`${RUN}%`]);
});

test.after(async () => {
  if (skip) return;
  await db.query(`DELETE FROM handoff_estimates WHERE customer_name LIKE $1`, [`${RUN}%`]);
  await db.pool.end();
});

async function seedEstimate({ status, deliveryTime, estimateStatus = 'Pending', syncSource = 'Handoff' }) {
  await db.query(
    `INSERT INTO handoff_estimates (customer_name, estimate_status, qb_estimate_number, qb_estimate_id, qb_email_status, qb_email_delivery_time, sync_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [`${RUN}-customer-${Math.random().toString(36).slice(2, 8)}`, estimateStatus, `EST-${RUN}-${Math.random().toString(36).slice(2, 6)}`, `QBID-${RUN}-${Math.random().toString(36).slice(2, 6)}`, status, deliveryTime, syncSource]
  );
}

test('buildReport counts by qb_email_status and cross-tabs with estimate_status correctly for freshly-seeded rows', { skip }, async () => {
  // This runs against a shared disposable database other test files also
  // write real EmailSent rows into — this test asserts the REPORT'S SHAPE
  // and that our own seeded, non-EmailSent rows are correctly counted,
  // never a global zero (which would be flaky against shared state, same
  // as production itself is never reset between runs either).
  const before = await buildReport({});
  await seedEstimate({ status: 'NotSet' });
  await seedEstimate({ status: 'NeedToSend' });
  await seedEstimate({ status: null });

  const after = await buildReport({});
  assert.strictEqual(after.total_handoff_estimates, before.total_handoff_estimates + 3);
  assert.ok(Array.isArray(after.by_email_status));
  assert.ok(Array.isArray(after.by_email_status_and_estimate_status));
  assert.ok(Array.isArray(after.by_sync_source));
  assert.ok(['NO EVIDENCE YET', 'CONFIRMED'].some((prefix) => after.verdict.startsWith(prefix)));
});

test('buildReport reports CONFIRMED with a real sample row once at least one EmailSent estimate exists', { skip }, async () => {
  const deliveryTime = new Date().toISOString();
  await seedEstimate({ status: 'EmailSent', deliveryTime });

  const report = await buildReport({ sampleLimit: 5 });
  assert.ok(report.email_sent_total >= 1);
  assert.match(report.verdict, /CONFIRMED/);
  assert.ok(report.email_sent_with_delivery_time >= 1);
  assert.ok(report.sample_email_sent_rows.length >= 1);
  assert.ok(report.by_email_status.some((r) => r.qb_email_status === 'EmailSent'));
});

test('buildReport never writes anything — source-level guard, every statement is a SELECT', { skip: skip }, () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/auditQbEstimateEmailStatus.js'), 'utf8');
  const queryCalls = src.match(/pool\.query\(\s*`([^`]*)`/g) || [];
  assert.ok(queryCalls.length > 0, 'expected at least one pool.query call to inspect');
  for (const call of queryCalls) {
    assert.match(call.trim(), /^pool\.query\(\s*`\s*SELECT/i, `non-SELECT statement found: ${call.slice(0, 80)}`);
  }
});
