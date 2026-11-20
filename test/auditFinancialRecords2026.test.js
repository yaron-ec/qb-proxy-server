/* eslint-disable no-undef */
'use strict';

/**
 * auditFinancialRecords2026.test.js — regression guard for
 * scripts/auditFinancialRecords2026.js's `invoicePaidAmount` helper.
 *
 * Found and fixed while building/validating this script against a disposable
 * local Postgres + dev backend (not run against production from this
 * environment — see the script's own header): qb_invoices_cache's real
 * numeric columns (total_amt/balance/paid) come back from Postgres as
 * STRINGS via this app's raw-query path, and the column is named `total_amt`
 * (never `total_amount`/`TotalAmt`, which only ever appear on a LIVE
 * QuickBooks API response, not this cached-row shape). The original version
 * gated on `typeof inv.paid === 'number'` (always false for a Postgres
 * numeric string) and fell through to `inv.total_amount ?? inv.TotalAmt`
 * (never matching `total_amt`), silently computing every invoice's paid
 * amount as 0 — which made the script's one meaningful anomaly signal,
 * INVOICE_VS_WATERFALL_MISMATCH, never fire. Reproduced directly: a seeded
 * $4,000 invoice mapped to the wrong deal of a two-deal QB customer (the
 * exact Lalani shape) was silently missed before this fix and correctly
 * flagged after it, verified live against a real dev backend + Postgres
 * instance (see this script's own header for that verification).
 */

const test = require('node:test');
const assert = require('node:assert');
const { invoicePaidAmount } = require('../scripts/auditFinancialRecords2026.js');

test('invoicePaidAmount: real qb_invoices_cache shape (string numerics, total_amt column)', () => {
  assert.strictEqual(
    invoicePaidAmount({ qb_invoice_id: 'x', total_amt: '4000.00', balance: '0.00', paid: '4000.00' }),
    4000
  );
});

test('invoicePaidAmount: a partially-paid invoice (paid < total_amt)', () => {
  assert.strictEqual(
    invoicePaidAmount({ total_amt: '10000.00', balance: '3000.00', paid: '7000.00' }),
    7000
  );
});

test('invoicePaidAmount: falls back to total - balance only when paid is absent', () => {
  assert.strictEqual(
    invoicePaidAmount({ total_amt: '5000.00', balance: '2000.00' }),
    3000
  );
});

test('invoicePaidAmount: never silently treats a real numeric string as zero (the actual bug)', () => {
  // The exact shape that shipped broken: a numeric column value as a string,
  // with no total_amount/TotalAmt alias present at all.
  const before = { total_amount: undefined, TotalAmt: undefined, total_amt: '4000.00', balance: '0.00', paid: '4000.00' };
  assert.notStrictEqual(invoicePaidAmount(before), 0, 'a $4,000 paid invoice must never compute as $0');
  assert.strictEqual(invoicePaidAmount(before), 4000);
});

test('invoicePaidAmount: also accepts a live-QuickBooks-API shape (TotalAmt/Balance, no paid field)', () => {
  assert.strictEqual(
    invoicePaidAmount({ TotalAmt: '1200.00', Balance: '200.00' }),
    1000
  );
});

test('invoicePaidAmount: null/undefined input never throws', () => {
  assert.strictEqual(invoicePaidAmount(null), 0);
  assert.strictEqual(invoicePaidAmount(undefined), 0);
  assert.strictEqual(invoicePaidAmount({}), 0);
});

test('invoicePaidAmount: a genuine $0 paid invoice really is zero (not every zero is the bug)', () => {
  assert.strictEqual(
    invoicePaidAmount({ total_amt: '5000.00', balance: '5000.00', paid: '0.00' }),
    0
  );
});
