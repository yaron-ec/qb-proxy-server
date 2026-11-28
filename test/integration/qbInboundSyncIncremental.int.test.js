/* eslint-disable no-undef */
'use strict';

/**
 * qbInboundSyncIncremental.int.test.js — REAL-Postgres proof of
 * lib/qbInboundSync.js#syncInvoicesPaymentsIncremental, the new QuickBooks
 * Change-Data-Capture-based incremental sync built during the November 2026
 * "QB API consumption root-cause investigation" (official Intuit usage data
 * showed query/Invoice + query/Payment accounting for over 80% of the
 * 500,786 CorePlus calls in 30 days — traced to the old per-customer,
 * non-incremental loop in syncAllMappedCustomers, called every tick for
 * every mapped customer with zero timestamp filtering).
 *
 * This function replaces that per-tick cost with ONE company-wide CDC call
 * (`GET /cdc?entities=Invoice,Payment&changedSince=...`) while leaving the
 * original full per-customer reconciliation completely unchanged as a
 * once-daily safety net (see server.js's new `qb-full-reconcile-cron`).
 *
 * The QuickBooks HTTP layer is faked via lib/qbTokenManager's injectable
 * require — never a real Intuit call — but db/client, sync_cursors,
 * qb_invoices_cache, qb_payments_cache, qb_payment_allocations,
 * qb_invoice_sale_map, owners, leads, and deals are all real, migrated
 * Postgres tables.
 *
 * Proves:
 *   1. With no prior cursor, the function falls back to the ORIGINAL full
 *      per-customer reconciliation (syncAllMappedCustomers) to establish a
 *      baseline, and persists a cursor afterward.
 *   2. With a fresh cursor, a real CDC response correctly upserts invoices
 *      and payments (with allocations) and auto-maps a matched invoice to
 *      its deal via qb_customer_id -> leads -> deals, exactly like the full
 *      per-customer path does.
 *   3. A CDC "Deleted" status record is marked voided in the real cache
 *      tables via the targeted single-record path (never a full per-
 *      customer diff).
 *   4. Re-running the exact same CDC response a second time is idempotent —
 *      no duplicate rows in any cache/mapping/allocation table.
 *   5. The cursor's watermark advances to the latest MetaData.LastUpdatedTime
 *      actually seen, so the next run's changedSince starts from there.
 *   6. A cursor older than the 30-day CDC lookback cap safely falls back to
 *      a full resync rather than silently missing changes CDC could never
 *      report.
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function freshQbInboundSync() {
  delete require.cache[require.resolve('../../lib/qbInboundSync')];
  return require('../../lib/qbInboundSync');
}

let db;
if (DB_URL) {
  db = require('../../db/client');
}

async function seedLeadWithDeal(stamp, qbCustomerId) {
  const { rows: ownerRows } = await db.query(
    `INSERT INTO owners (email, display_name) VALUES ($1, 'QB Incremental Sync Test Owner') RETURNING id`,
    [`owner-qbincremental-${stamp}@test.example`]
  );
  const ownerId = ownerRows[0].id;
  const { rows: leadRows } = await db.query(
    `INSERT INTO leads (first_name, last_name, email, phone, source, status, qb_customer_id, owner_id)
     VALUES ('Test', 'Customer', $1, '5551234567', 'test', 'new', $2, $3) RETURNING id`,
    [`customer-${stamp}@test.example`, qbCustomerId, ownerId]
  );
  const leadId = leadRows[0].id;
  const { rows: dealRows } = await db.query(
    `INSERT INTO deals (lead_id, name, amount, stage) VALUES ($1, 'Test Deal', 10000, 'Sold / Estimate Approved') RETURNING id`,
    [leadId]
  );
  return { leadId, dealId: dealRows[0].id };
}

function makeCdcResponse(invoices = [], payments = []) {
  return {
    CDCResponse: [
      { QueryResponse: [{ Invoice: invoices }, { Payment: payments }] },
    ],
  };
}

test.beforeEach(async () => {
  if (!DB_URL) return;
  await db.query(`DELETE FROM qb_payment_allocations`);
  await db.query(`DELETE FROM qb_invoice_sale_map`);
  await db.query(`DELETE FROM qb_payments_cache`);
  await db.query(`DELETE FROM qb_invoices_cache`);
  await db.query(`DELETE FROM sync_cursors WHERE integration IN ('quickbooks_inbound_reconcile')`);
  // This file's own fixtures only (owner email prefix is unique to this
  // file) — syncAllMappedCustomers' fallback path scans EVERY lead with a
  // qb_customer_id, so a leftover fixture from a prior run of this exact
  // file (local Postgres persists across invocations) would otherwise be
  // picked up alongside the current test's own seed data.
  await db.query(`DELETE FROM deals WHERE lead_id IN (SELECT id FROM leads WHERE email LIKE 'customer-%@test.example')`);
  await db.query(`DELETE FROM leads WHERE email LIKE 'customer-%@test.example'`);
  await db.query(`DELETE FROM owners WHERE email LIKE 'owner-qbincremental-%@test.example'`);
});

test('no prior cursor: falls back to full per-customer reconciliation and persists a cursor afterward', { skip }, async () => {
  const stamp = crypto.randomUUID();
  const qbCustomerId = `CUST-FALLBACK-${stamp}`;
  const { leadId, dealId } = await seedLeadWithDeal(stamp, qbCustomerId);

  const restoreMgr = stub('../../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      if (url.includes('Invoice')) {
        return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: { Invoice: [
          { Id: 'INV-1', DocNumber: 'D-1', CustomerRef: { value: qbCustomerId }, TotalAmt: 500, Balance: 200, TxnStatus: 'Pending', TxnDate: '2026-11-01' },
        ] } } };
      }
      if (url.includes('Payment')) {
        return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: { Payment: [] } } };
      }
      throw new Error('unexpected QB call: ' + url);
    },
  });
  try {
    const qbInboundSync = freshQbInboundSync();
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'cdc_fallback_full');

    const cursor = await db.query(`SELECT * FROM sync_cursors WHERE integration = 'quickbooks_inbound_reconcile'`);
    assert.strictEqual(cursor.rows.length, 1);
    assert.ok(cursor.rows[0].last_successful_sync_at);

    const mapping = await db.query(`SELECT * FROM qb_invoice_sale_map WHERE qb_invoice_id = 'INV-1'`);
    assert.strictEqual(mapping.rows.length, 1);
    assert.strictEqual(mapping.rows[0].crm_sale_id, dealId);
    assert.strictEqual(mapping.rows[0].crm_lead_id, leadId);
  } finally { restoreMgr(); }
});

test('CDC mode with a fresh cursor: upserts invoice + payment, allocates the payment, and auto-maps the invoice to its deal', { skip }, async () => {
  const stamp = crypto.randomUUID();
  const qbCustomerId = `CUST-CDC-${stamp}`;
  const { leadId, dealId } = await seedLeadWithDeal(stamp, qbCustomerId);

  // Seed a recent (within the 30-day cap) watermark so the function takes
  // the CDC path, not the fallback-to-full path.
  const watermark = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
  await db.query(
    `INSERT INTO sync_cursors (integration, last_cursor, last_updated_timestamp) VALUES ('quickbooks_inbound_reconcile', $1::text, $1::timestamptz)`,
    [watermark]
  );

  const invoiceUpdatedAt = new Date().toISOString();
  const cdcResponse = makeCdcResponse(
    [{ Id: 'INV-100', DocNumber: 'D-100', CustomerRef: { value: qbCustomerId }, TotalAmt: 1000, Balance: 400, TxnStatus: 'Pending', TxnDate: '2026-11-20', MetaData: { LastUpdatedTime: invoiceUpdatedAt } }],
    [{ Id: 'PAY-200', DocNumber: 'P-200', CustomerRef: { value: qbCustomerId }, TotalAmt: 600, UnappliedAmt: 0, TxnDate: '2026-11-21', Line: [{ Amount: 600, LinkedTxn: [{ TxnType: 'Invoice', TxnId: 'INV-100' }] }], MetaData: { LastUpdatedTime: invoiceUpdatedAt } }]
  );

  let sawCdcCall = false;
  const restoreMgr = stub('../../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      assert.ok(url.includes('/cdc?entities='), 'expected exactly one company-wide CDC call, never a per-customer query');
      sawCdcCall = true;
      return { res: { ok: true, status: 200 }, text: '{}', json: cdcResponse };
    },
  });
  try {
    const qbInboundSync = freshQbInboundSync();
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(sawCdcCall, true);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'cdc');
    assert.strictEqual(result.invoices_upserted, 1);
    assert.strictEqual(result.payments_upserted, 1);
    assert.strictEqual(result.allocations, 1);
    assert.strictEqual(result.mapped, 1);

    const invRow = await db.query(`SELECT * FROM qb_invoices_cache WHERE qb_invoice_id = 'INV-100'`);
    assert.strictEqual(invRow.rows.length, 1);
    assert.strictEqual(Number(invRow.rows[0].total_amt), 1000);
    assert.strictEqual(Number(invRow.rows[0].balance), 400);
    assert.strictEqual(invRow.rows[0].voided, false);

    const payRow = await db.query(`SELECT * FROM qb_payments_cache WHERE qb_payment_id = 'PAY-200'`);
    assert.strictEqual(payRow.rows.length, 1);
    assert.strictEqual(Number(payRow.rows[0].total_amt), 600);

    const allocRow = await db.query(`SELECT * FROM qb_payment_allocations WHERE qb_payment_id = 'PAY-200' AND qb_invoice_id = 'INV-100'`);
    assert.strictEqual(allocRow.rows.length, 1);
    assert.strictEqual(Number(allocRow.rows[0].allocation_amt), 600);

    const mapping = await db.query(`SELECT * FROM qb_invoice_sale_map WHERE qb_invoice_id = 'INV-100'`);
    assert.strictEqual(mapping.rows.length, 1);
    assert.strictEqual(mapping.rows[0].crm_sale_id, dealId);
    assert.strictEqual(mapping.rows[0].crm_lead_id, leadId);

    const cursor = await db.query(`SELECT * FROM sync_cursors WHERE integration = 'quickbooks_inbound_reconcile'`);
    assert.strictEqual(cursor.rows.length, 1);
    assert.strictEqual(new Date(cursor.rows[0].last_updated_timestamp).toISOString(), new Date(invoiceUpdatedAt).toISOString());
  } finally { restoreMgr(); }
});

test('a CDC "Deleted" record is marked voided via the targeted single-record path, never a full per-customer diff', { skip }, async () => {
  const stamp = crypto.randomUUID();
  const qbCustomerId = `CUST-DEL-${stamp}`;
  await seedLeadWithDeal(stamp, qbCustomerId);

  // Pre-seed a cached invoice that CDC will now report as Deleted.
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_doc_number, qb_customer_id, total_amt, balance, paid, txn_status, voided, txn_date, last_synced_at)
     VALUES ('INV-DEL-1', 'D-DEL-1', $1, 300, 300, 0, 'Pending', FALSE, '2026-11-10', NOW())`,
    [qbCustomerId]
  );
  await db.query(
    `INSERT INTO qb_payments_cache (qb_payment_id, qb_doc_number, qb_customer_id, total_amt, unapplied_amt, txn_date, method, voided, last_synced_at)
     VALUES ('PAY-DEL-1', 'P-DEL-1', $1, 300, 0, '2026-11-11', 'Check', FALSE, NOW())`,
    [qbCustomerId]
  );

  const watermark = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO sync_cursors (integration, last_cursor, last_updated_timestamp) VALUES ('quickbooks_inbound_reconcile', $1::text, $1::timestamptz)`,
    [watermark]
  );

  const deletedAt = new Date().toISOString();
  const cdcResponse = makeCdcResponse(
    [{ Id: 'INV-DEL-1', status: 'Deleted', MetaData: { LastUpdatedTime: deletedAt } }],
    [{ Id: 'PAY-DEL-1', status: 'Deleted', MetaData: { LastUpdatedTime: deletedAt } }]
  );

  const restoreMgr = stub('../../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async () => ({ res: { ok: true, status: 200 }, text: '{}', json: cdcResponse }),
  });
  try {
    const qbInboundSync = freshQbInboundSync();
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.invoices_deleted, 1);
    assert.strictEqual(result.payments_deleted, 1);
    assert.strictEqual(result.invoices_upserted, 0, 'a Deleted record must never also be upserted as a live invoice');

    const invRow = await db.query(`SELECT voided, total_amt FROM qb_invoices_cache WHERE qb_invoice_id = 'INV-DEL-1'`);
    assert.strictEqual(invRow.rows[0].voided, true);
    assert.strictEqual(Number(invRow.rows[0].total_amt), 300, 'the targeted void path must never touch the pre-existing amount fields');

    const payRow = await db.query(`SELECT voided FROM qb_payments_cache WHERE qb_payment_id = 'PAY-DEL-1'`);
    assert.strictEqual(payRow.rows[0].voided, true);
  } finally { restoreMgr(); }
});

test('re-running the identical CDC response a second time is idempotent — no duplicate rows anywhere', { skip }, async () => {
  const stamp = crypto.randomUUID();
  const qbCustomerId = `CUST-IDEMP-${stamp}`;
  await seedLeadWithDeal(stamp, qbCustomerId);

  const watermark = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO sync_cursors (integration, last_cursor, last_updated_timestamp) VALUES ('quickbooks_inbound_reconcile', $1::text, $1::timestamptz)`,
    [watermark]
  );

  const updatedAt = new Date().toISOString();
  const cdcResponse = makeCdcResponse(
    [{ Id: 'INV-IDEMP-1', DocNumber: 'D-IDEMP-1', CustomerRef: { value: qbCustomerId }, TotalAmt: 900, Balance: 900, TxnStatus: 'Pending', TxnDate: '2026-11-15', MetaData: { LastUpdatedTime: updatedAt } }],
    [{ Id: 'PAY-IDEMP-1', DocNumber: 'P-IDEMP-1', CustomerRef: { value: qbCustomerId }, TotalAmt: 300, UnappliedAmt: 0, TxnDate: '2026-11-16', Line: [{ Amount: 300, LinkedTxn: [{ TxnType: 'Invoice', TxnId: 'INV-IDEMP-1' }] }], MetaData: { LastUpdatedTime: updatedAt } }]
  );

  const restoreMgr = stub('../../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async () => ({ res: { ok: true, status: 200 }, text: '{}', json: cdcResponse }),
  });
  try {
    const qbInboundSync = freshQbInboundSync();
    await qbInboundSync.syncInvoicesPaymentsIncremental();

    // Re-seed the SAME watermark (as if the prior run's cursor save is being
    // raced/replayed) and run again with the identical CDC payload.
    await db.query(`UPDATE sync_cursors SET last_updated_timestamp = $1 WHERE integration = 'quickbooks_inbound_reconcile'`, [watermark]);
    const second = freshQbInboundSync();
    await second.syncInvoicesPaymentsIncremental();

    const invRows = await db.query(`SELECT * FROM qb_invoices_cache WHERE qb_invoice_id = 'INV-IDEMP-1'`);
    assert.strictEqual(invRows.rows.length, 1, 'no duplicate invoice cache row');

    const payRows = await db.query(`SELECT * FROM qb_payments_cache WHERE qb_payment_id = 'PAY-IDEMP-1'`);
    assert.strictEqual(payRows.rows.length, 1, 'no duplicate payment cache row');

    const allocRows = await db.query(`SELECT * FROM qb_payment_allocations WHERE qb_payment_id = 'PAY-IDEMP-1'`);
    assert.strictEqual(allocRows.rows.length, 1, 'no duplicate allocation row (DELETE + INSERT replace, not append)');

    const mapRows = await db.query(`SELECT * FROM qb_invoice_sale_map WHERE qb_invoice_id = 'INV-IDEMP-1'`);
    assert.strictEqual(mapRows.rows.length, 1, 'no duplicate sale-map row (ON CONFLICT DO NOTHING)');
  } finally { restoreMgr(); }
});

test('a cursor older than the 30-day CDC lookback cap falls back to a full resync rather than silently missing changes', { skip }, async () => {
  const stamp = crypto.randomUUID();
  const qbCustomerId = `CUST-STALE-${stamp}`;
  await seedLeadWithDeal(stamp, qbCustomerId);

  const staleWatermark = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(); // 31 days ago
  await db.query(
    `INSERT INTO sync_cursors (integration, last_cursor, last_updated_timestamp) VALUES ('quickbooks_inbound_reconcile', $1::text, $1::timestamptz)`,
    [staleWatermark]
  );

  let sawCdcCall = false;
  const restoreMgr = stub('../../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      if (url.includes('/cdc?entities=')) sawCdcCall = true;
      if (url.includes('Invoice') || url.includes('Payment')) {
        return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
      }
      throw new Error('unexpected QB call: ' + url);
    },
  });
  try {
    const qbInboundSync = freshQbInboundSync();
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(sawCdcCall, false, 'a stale cursor must never attempt a CDC call outside its documented 30-day window');
    assert.strictEqual(result.mode, 'cdc_fallback_full');
  } finally { restoreMgr(); }
});

// ── November 2026 final-acceptance follow-up: real-Postgres proof that a
// PARTIAL fallback (the recovery-event shape — some mapped customers still
// fail while QuickBooks access is intermittently recovering) never
// advances last_successful_sync_at or the watermark. This is exactly the
// case lib/qbRecoveryVerification.js depends on being correct: a false
// last_successful_sync_at here would let a "QuickBooks recovered" email
// fire on a sync that never actually finished catching up. ──────────────
test('a PARTIAL fallback (one customer fails) never advances last_successful_sync_at or the watermark in the real sync_cursors row', { skip }, async () => {
  const stampGood = crypto.randomUUID();
  const stampBad = crypto.randomUUID();
  const qbCustomerGood = `CUST-RECOVER-OK-${stampGood}`;
  const qbCustomerBad = `CUST-RECOVER-FAIL-${stampBad}`;
  await seedLeadWithDeal(stampGood, qbCustomerGood);
  await seedLeadWithDeal(stampBad, qbCustomerBad);

  const restoreMgr = stub('../../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      if (url.includes(qbCustomerBad)) return { res: { ok: false, status: 500 }, text: 'server error', json: {} };
      if (url.includes('Invoice') || url.includes('Payment')) return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
      throw new Error('unexpected QB call: ' + url);
    },
  });
  try {
    const qbInboundSync = freshQbInboundSync();
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.mode, 'cdc_fallback_full');
    assert.strictEqual(result.outcome, 'partial');

    const cursor = await db.query(`SELECT * FROM sync_cursors WHERE integration = 'quickbooks_inbound_reconcile'`);
    assert.strictEqual(cursor.rows.length, 1);
    assert.strictEqual(cursor.rows[0].last_successful_sync_at, null, 'a partial recovery attempt must never be reported as a genuine successful sync');
    assert.strictEqual(cursor.rows[0].last_cursor, null, 'the watermark must not advance either — the failed customer was never actually re-fetched this attempt');
    assert.ok(cursor.rows[0].last_attempted_at, 'the attempt itself is still durably recorded');

    // The next tick retries the SAME fallback (still no usable watermark) —
    // proving the failed customer's data genuinely gets another real chance
    // rather than being silently skipped once "now" was wrongly accepted.
    const restoreMgr2 = stub('../../lib/qbTokenManager', {
      getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
      qbApiRequest: async () => ({ res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } }),
    });
    try {
      const second = freshQbInboundSync();
      const result2 = await second.syncInvoicesPaymentsIncremental();
      assert.strictEqual(result2.mode, 'cdc_fallback_full', 'retried the fallback again, not CDC — there was still no valid watermark to resume from');
      assert.strictEqual(result2.outcome, 'success');
      const cursor2 = await db.query(`SELECT last_successful_sync_at, last_cursor FROM sync_cursors WHERE integration = 'quickbooks_inbound_reconcile'`);
      assert.ok(cursor2.rows[0].last_successful_sync_at, 'now that both customers genuinely succeeded, the watermark and success timestamp both advance');
      assert.ok(cursor2.rows[0].last_cursor);
    } finally { restoreMgr2(); }
  } finally { restoreMgr(); }
});

test('a CDC response at/above the 1000-object truncation threshold falls back to full reconciliation rather than trusting a possibly-incomplete response', { skip }, async () => {
  const stamp = crypto.randomUUID();
  const qbCustomerId = `CUST-TRUNC-${stamp}`;
  await seedLeadWithDeal(stamp, qbCustomerId);

  const watermark = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO sync_cursors (integration, last_cursor, last_updated_timestamp) VALUES ('quickbooks_inbound_reconcile', $1::text, $1::timestamptz)`,
    [watermark]
  );

  const bigInvoiceList = Array.from({ length: 1000 }, (_, i) => ({
    Id: `INV-TRUNC-${i}`, CustomerRef: { value: qbCustomerId }, TotalAmt: 1, Balance: 1,
    MetaData: { LastUpdatedTime: new Date().toISOString() },
  }));
  let fullSyncAttempted = false;
  const restoreMgr = stub('../../lib/qbTokenManager', {
    getValidTokens: async () => ({ access_token: 'x', realm_id: 'R1' }),
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      if (url.includes('/cdc?entities=')) return { res: { ok: true, status: 200 }, text: '{}', json: makeCdcResponse(bigInvoiceList, []) };
      fullSyncAttempted = true;
      return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
    },
  });
  try {
    const qbInboundSync = freshQbInboundSync();
    const result = await qbInboundSync.syncInvoicesPaymentsIncremental();
    assert.strictEqual(result.mode, 'cdc_fallback_full', 'a suspected-truncated 1000-object CDC response is never trusted — falls back to the full per-customer reconciliation instead');
    assert.strictEqual(fullSyncAttempted, true);
    // None of the 1000 synthetic invoices were ever written — confirming the
    // truncated response was genuinely discarded, not partially processed.
    const written = await db.query(`SELECT COUNT(*) AS n FROM qb_invoices_cache WHERE qb_invoice_id LIKE 'INV-TRUNC-%'`);
    assert.strictEqual(Number(written.rows[0].n), 0);
  } finally { restoreMgr(); }
});

test('an overlapping call is skipped (cross-process advisory lock, namespace 1005)', { skip }, async () => {
  const stamp = crypto.randomUUID();
  const qbCustomerId = `CUST-LOCK-${stamp}`;
  await seedLeadWithDeal(stamp, qbCustomerId);

  let releaseFirst;
  const started = new Promise((resolve) => { releaseFirst = resolve; });
  const restoreMgr = stub('../../lib/qbTokenManager', {
    getValidTokens: async () => {
      started && started.then ? null : null;
      return { access_token: 'x', realm_id: 'R1' };
    },
    qbApiRequest: async (_env, buildUrl) => {
      const url = buildUrl({ realm_id: 'R1' });
      if (url.includes('/cdc?entities=')) {
        await new Promise((r) => setTimeout(r, 150));
        return { res: { ok: true, status: 200 }, text: '{}', json: { CDCResponse: [] } };
      }
      return { res: { ok: true, status: 200 }, text: '{}', json: { QueryResponse: {} } };
    },
  });
  try {
    const watermark = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO sync_cursors (integration, last_cursor, last_updated_timestamp) VALUES ('quickbooks_inbound_reconcile', $1::text, $1::timestamptz)`,
      [watermark]
    );
    const a = freshQbInboundSync();
    const [r1, r2] = await Promise.all([
      a.syncInvoicesPaymentsIncremental(),
      a.syncInvoicesPaymentsIncremental(),
    ]);
    const skipped = [r1, r2].filter((r) => r.skipped);
    const ran = [r1, r2].filter((r) => !r.skipped);
    assert.strictEqual(skipped.length, 1, 'exactly one of the two overlapping calls must be skipped');
    assert.strictEqual(ran.length, 1);
    assert.strictEqual(skipped[0].reason, 'already_in_progress');
  } finally { restoreMgr(); }
  void releaseFirst;
});

// ── November 2026 final-acceptance follow-up, item 2: CDC item-level
// failures are durably retried from their own stored payload, with ZERO
// additional QuickBooks API calls, independent of any full reconciliation
// safety net or quota throttle. ─────────────────────────────────────────

test('retryFailedCdcRecords: reprocesses a genuinely stored failed invoice against REAL Postgres — upserts the cache row, maps it to the deal, and marks it resolved', { skip }, async () => {
  const stamp = `${Date.now()}-retry1`;
  const { dealId } = await seedLeadWithDeal(stamp, `CUST-RETRY-${stamp}`);
  const rawInvoice = {
    Id: `INV-RETRY-${stamp}`,
    DocNumber: `DOC-RETRY-${stamp}`,
    CustomerRef: { value: `CUST-RETRY-${stamp}` },
    TotalAmt: 500,
    Balance: 500,
    MetaData: { LastUpdatedTime: new Date().toISOString() },
  };
  await db.query(
    `INSERT INTO qb_cdc_failed_records (entity_type, qb_id, raw_payload, last_error)
     VALUES ('invoice', $1, $2::jsonb, 'simulated transient failure')`,
    [rawInvoice.Id, JSON.stringify(rawInvoice)]
  );

  const qbInboundSync = freshQbInboundSync();
  const result = await qbInboundSync.retryFailedCdcRecords();
  assert.strictEqual(result.attempted, 1);
  assert.strictEqual(result.resolved, 1);
  assert.strictEqual(result.stillFailing, 0);

  const { rows: cacheRows } = await db.query('SELECT * FROM qb_invoices_cache WHERE qb_invoice_id = $1', [rawInvoice.Id]);
  assert.strictEqual(cacheRows.length, 1, 'the retried invoice must land in the real cache table');
  assert.strictEqual(Number(cacheRows[0].total_amt), 500);

  const { rows: mapRows } = await db.query('SELECT * FROM qb_invoice_sale_map WHERE qb_invoice_id = $1', [rawInvoice.Id]);
  assert.strictEqual(mapRows.length, 1);
  assert.strictEqual(mapRows[0].crm_sale_id, dealId);

  const { rows: failedRows } = await db.query('SELECT resolved_at FROM qb_cdc_failed_records WHERE qb_id = $1', [rawInvoice.Id]);
  assert.ok(failedRows[0].resolved_at, 'must be marked resolved after a successful retry');
});

test('retryFailedCdcRecords: a record whose underlying dependency never resolves stays unresolved with incrementing attempts, never silently dropped', { skip }, async () => {
  const stamp = `${Date.now()}-retry2`;
  // Deliberately NO matching lead/deal for this customer — autoMapInvoiceToSale
  // itself never throws for "no lead" (it returns {mapped:false}), so to
  // force a genuine, repeatable failure we give the payload a malformed
  // CustomerRef shape that the real upsert function's SQL will reject.
  const rawInvoice = {
    Id: `INV-RETRY-FAIL-${stamp}`,
    DocNumber: null,
    CustomerRef: { value: `CUST-NONE-${stamp}` },
    TotalAmt: 'not-a-number-and-also-missing-required-fields',
    MetaData: {},
  };
  await db.query(
    `INSERT INTO qb_cdc_failed_records (entity_type, qb_id, raw_payload, last_error, attempts)
     VALUES ('invoice', $1, $2::jsonb, 'simulated transient failure', 1)`,
    [rawInvoice.Id, JSON.stringify(rawInvoice)]
  );

  // Force a genuine failure deterministically by stubbing the upsert to
  // throw — MUST happen before freshQbInboundSync(), since qbInboundSync.js
  // destructures upsertInvoiceCacheFromQb out of qbInvoiceSaleMap at its
  // own require-time (a later stub would never be picked up).
  const restoreSaleMap = stub('../../lib/qbInvoiceSaleMap', {
    upsertInvoiceCacheFromQb: async () => { throw new Error('still broken'); },
    upsertMapping: async () => {},
  });
  const qbInboundSync = freshQbInboundSync();
  try {
    const result = await qbInboundSync.retryFailedCdcRecords();
    assert.strictEqual(result.resolved, 0);
    assert.strictEqual(result.stillFailing, 1);
  } finally { restoreSaleMap(); }

  const { rows: failedRows } = await db.query('SELECT resolved_at, attempts, last_error FROM qb_cdc_failed_records WHERE qb_id = $1', [rawInvoice.Id]);
  assert.strictEqual(failedRows[0].resolved_at, null, 'never silently resolved without a genuine success');
  assert.strictEqual(Number(failedRows[0].attempts), 2, 'attempts increments rather than the row being dropped');
  assert.match(failedRows[0].last_error, /still broken/);
});
