/* eslint-disable no-undef */
'use strict';

/**
 * qbCacheStaleOverwriteGuard.int.test.js — real-Postgres proof of the
 * November 2026 final-acceptance follow-up fix: "verify that older failed
 * CDC payloads cannot overwrite newer successfully synchronized financial
 * records."
 *
 * Root cause confirmed by direct code read: lib/qbInvoiceSaleMap.js
 * #upsertInvoiceCache and lib/qbInboundSync.js#upsertPaymentWithAllocations
 * both did a BLIND `ON CONFLICT DO UPDATE` with no comparison of which
 * version of the record was newer — safe for the ordinary in-order sync
 * path, but lib/qbInboundSync.js#retryFailedCdcRecords reprocesses a
 * STORED, potentially-stale raw payload (captured at the moment a CDC item
 * failed); if a newer, correct sync for the same invoice/payment already
 * landed in the meantime, a later retry of the old payload would silently
 * overwrite the newer, correct financial data with the older one.
 *
 * Fix (db/migrations/2026-85-qb-cache-last-updated-time-guard.sql): both
 * cache tables gained a qb_last_updated_time column (QuickBooks' own
 * MetaData.LastUpdatedTime), and both upsert functions now gate their
 * ON CONFLICT DO UPDATE on it — an older incoming write is a safe no-op
 * that leaves the newer, correct row completely untouched.
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, map, inbound;
const RUN = `qbguard${Date.now().toString(36)}`;

test.before(async () => {
  if (skip) return;
  db = require('../../db/client');
  map = require('../../lib/qbInvoiceSaleMap');
  inbound = require('../../lib/qbInboundSync');
});

test.after(async () => {
  if (skip) return;
  await db.query('DELETE FROM qb_payment_allocations WHERE qb_payment_id LIKE $1', [`${RUN}%`]);
  await db.query('DELETE FROM qb_payments_cache WHERE qb_payment_id LIKE $1', [`${RUN}%`]);
  await db.query('DELETE FROM qb_invoices_cache WHERE qb_invoice_id LIKE $1', [`${RUN}%`]);
  await db.pool.end();
});

test('upsertInvoiceCache: an OLDER qb_last_updated_time is a safe no-op — the newer, correct row is left untouched', { skip }, async () => {
  const invId = `${RUN}-inv-1`;
  const newer = await map.upsertInvoiceCacheFromQb({ query: db.query }, {
    Id: invId, CustomerRef: { value: 'CUST-X' }, TotalAmt: 5000, Balance: 1000, TxnStatus: 'Open',
    MetaData: { LastUpdatedTime: '2026-11-20T12:00:00.000-08:00' },
  });
  assert.strictEqual(newer.applied, true, 'first write (fresh insert) must always apply');

  // Simulate retryFailedCdcRecords() reprocessing an OLDER stored payload —
  // same invoice, a stale total/balance from BEFORE the real update above.
  const stale = await map.upsertInvoiceCacheFromQb({ query: db.query }, {
    Id: invId, CustomerRef: { value: 'CUST-X' }, TotalAmt: 9999, Balance: 9999, TxnStatus: 'Open',
    MetaData: { LastUpdatedTime: '2026-11-19T12:00:00.000-08:00' }, // one day OLDER
  });
  assert.strictEqual(stale.applied, false, 'a write with an older qb_last_updated_time must be rejected (safe no-op)');

  const { rows } = await db.query('SELECT total_amt, balance FROM qb_invoices_cache WHERE qb_invoice_id = $1', [invId]);
  assert.strictEqual(Number(rows[0].total_amt), 5000, 'the newer, correct total_amt must be untouched by the stale retry');
  assert.strictEqual(Number(rows[0].balance), 1000, 'the newer, correct balance must be untouched by the stale retry');
});

test('upsertInvoiceCache: a NEWER qb_last_updated_time correctly overwrites an older cached row', { skip }, async () => {
  const invId = `${RUN}-inv-2`;
  await map.upsertInvoiceCacheFromQb({ query: db.query }, {
    Id: invId, CustomerRef: { value: 'CUST-X' }, TotalAmt: 1000, Balance: 1000, TxnStatus: 'Open',
    MetaData: { LastUpdatedTime: '2026-11-19T12:00:00.000-08:00' },
  });
  const r = await map.upsertInvoiceCacheFromQb({ query: db.query }, {
    Id: invId, CustomerRef: { value: 'CUST-X' }, TotalAmt: 1000, Balance: 0, TxnStatus: 'Paid',
    MetaData: { LastUpdatedTime: '2026-11-20T12:00:00.000-08:00' }, // newer — a real payment applied
  });
  assert.strictEqual(r.applied, true, 'a genuinely newer write must apply');
  const { rows } = await db.query('SELECT balance, txn_status FROM qb_invoices_cache WHERE qb_invoice_id = $1', [invId]);
  assert.strictEqual(Number(rows[0].balance), 0);
  assert.strictEqual(rows[0].txn_status, 'Paid');
});

test('upsertInvoiceCache: a caller that supplies no qb_last_updated_time (e.g. routes/saleInvoices.js manual entry) is never blocked', { skip }, async () => {
  const invId = `${RUN}-inv-3`;
  await map.upsertInvoiceCache({ query: db.query }, {
    qb_invoice_id: invId, qb_customer_id: 'CUST-X', total_amt: 100, balance: 100, paid: 0, txn_status: 'Open',
  });
  const r2 = await map.upsertInvoiceCache({ query: db.query }, {
    qb_invoice_id: invId, qb_customer_id: 'CUST-X', total_amt: 200, balance: 200, paid: 0, txn_status: 'Open',
  });
  assert.strictEqual(r2.applied, true, 'omitting qb_last_updated_time on both sides must never block a legitimate write');
  const { rows } = await db.query('SELECT total_amt FROM qb_invoices_cache WHERE qb_invoice_id = $1', [invId]);
  assert.strictEqual(Number(rows[0].total_amt), 200);
});

test('upsertPaymentWithAllocations: an OLDER stale retry never rewrites allocations either', { skip }, async () => {
  const payId = `${RUN}-pay-1`;
  const invId = `${RUN}-inv-4`;
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_customer_id, total_amt, balance, paid) VALUES ($1,'CUST-Y',500,500,0)`,
    [invId]
  );

  await inbound.upsertPaymentWithAllocations({
    Id: payId, TotalAmt: 500, UnappliedAmt: 0,
    MetaData: { LastUpdatedTime: '2026-11-20T12:00:00.000-08:00' },
    Line: [{ Amount: 500, LinkedTxn: [{ TxnType: 'Invoice', TxnId: invId }] }],
  }, 'CUST-Y');

  const { rows: before } = await db.query('SELECT allocation_amt FROM qb_payment_allocations WHERE qb_payment_id = $1', [payId]);
  assert.strictEqual(before.length, 1);
  assert.strictEqual(Number(before[0].allocation_amt), 500);

  // Stale retry: an OLDER payload claiming a different (wrong) allocation.
  const allocCount = await inbound.upsertPaymentWithAllocations({
    Id: payId, TotalAmt: 999, UnappliedAmt: 999,
    MetaData: { LastUpdatedTime: '2026-11-19T12:00:00.000-08:00' }, // older
    Line: [{ Amount: 999, LinkedTxn: [{ TxnType: 'Invoice', TxnId: invId }] }],
  }, 'CUST-Y');
  assert.strictEqual(allocCount, 0, 'a stale retry must report zero allocations processed, never rewrite them');

  const { rows: after } = await db.query('SELECT allocation_amt FROM qb_payment_allocations WHERE qb_payment_id = $1', [payId]);
  assert.strictEqual(after.length, 1, 'the real allocation row must still exist, untouched');
  assert.strictEqual(Number(after[0].allocation_amt), 500, 'the real allocation amount must be unchanged by the stale retry');

  const { rows: payRow } = await db.query('SELECT total_amt FROM qb_payments_cache WHERE qb_payment_id = $1', [payId]);
  assert.strictEqual(Number(payRow[0].total_amt), 500, 'the payment row itself must also be unchanged by the stale retry');
});

test('retryFailedCdcRecords: a stale failed-record retry resolves as a safe no-op without regressing a newer row', { skip }, async () => {
  const invId = `${RUN}-inv-5`;
  // The real, newer sync already landed correctly.
  await map.upsertInvoiceCacheFromQb({ query: db.query }, {
    Id: invId, CustomerRef: { value: 'CUST-Z' }, TotalAmt: 3000, Balance: 0, TxnStatus: 'Paid',
    MetaData: { LastUpdatedTime: '2026-11-20T12:00:00.000-08:00' },
  });

  // A stale, older payload sits in qb_cdc_failed_records from an earlier
  // failed attempt (e.g. a transient DB error at the time, before the
  // newer sync above ever happened).
  await inbound.recordCdcItemFailure('invoice', invId, {
    Id: invId, CustomerRef: { value: 'CUST-Z' }, TotalAmt: 3000, Balance: 3000, TxnStatus: 'Open',
    MetaData: { LastUpdatedTime: '2026-11-18T12:00:00.000-08:00' }, // two days OLDER
  }, 'transient error at the time');

  const result = await inbound.retryFailedCdcRecords({ limit: 50 });
  const thisOne = result.errors.find((e) => e.qb_id === invId);
  assert.strictEqual(thisOne, undefined, 'the stale retry must not be reported as a genuine failure');
  assert.ok(result.resolved >= 1, 'the stale record must be marked resolved (permanently superseded, not stuck retrying forever)');

  const { rows } = await db.query('SELECT balance, txn_status FROM qb_invoices_cache WHERE qb_invoice_id = $1', [invId]);
  assert.strictEqual(Number(rows[0].balance), 0, 'the newer, correct balance must survive the stale retry');
  assert.strictEqual(rows[0].txn_status, 'Paid', 'the newer, correct status must survive the stale retry');

  const { rows: failedRow } = await db.query('SELECT resolved_at FROM qb_cdc_failed_records WHERE entity_type = $1 AND qb_id = $2', ['invoice', invId]);
  assert.ok(failedRow[0].resolved_at, 'the failed-record row itself must be marked resolved');
});
