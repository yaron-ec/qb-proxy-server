#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * Sale-Level Financial Isolation — Dry-Run Validator (REAL PostgreSQL)
 *
 * Validates the 2026-10-qb-invoice-sale-map migration and the sale-scoped
 * financial model against a REAL, isolated, NON-PRODUCTION PostgreSQL instance
 * (Railway project: nurturing-success ONLY).
 *
 * Tests A–J:
 *   A. 1 Lead + 1 Sale + 1 invoice + 1 payment → paid, balance 0, status paid
 *   B. 1 Lead + 3 Sales (different amounts) + 1 invoice each → independent
 *   C. 2 Sales with IDENTICAL amounts, invoice on one only → no amount-based ownership
 *   D. 1 Sale + 3 invoices → invoiced/paid aggregate per sale
 *   E. Partial payment on only one Sale (of 3) → only that Sale paid>0  (Joann case)
 *   F. One Sale fully paid, another Sale under same Lead unpaid → no leak
 *   G. Voided invoice mapped to a Sale → excluded from invoiced/paid
 *   H. Legacy invoice with no crm_sale_id → UNMAPPED, contributes to no Sale
 *   I. Duplicate mapping upsert → idempotent, no reassign
 *   J. Deal field cross-contamination guard → lead field changes do NOT overwrite
 *      any Deal's amount/project_type/sold_date (pure-JS guard logic test)
 *
 * SAFETY:
 *   - Requires TEST_DATABASE_URL. Refuses without it.
 *   - NEVER falls back to DATABASE_URL or any production variable.
 *   - Aborts if TEST_DATABASE_URL matches DATABASE_URL or looks production-only.
 *   - Refuses if the URL references disciplined-heart.
 *   - Runs the ENTIRE dry run inside a single transaction and ROLLBACKs.
 *     Zero persistent changes. Test DB left pristine and reusable.
 *
 * USAGE (from src/proxy-server/):
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/testdb \
 *     node scripts/dryRunSaleFinancials.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const map = require('../lib/qbInvoiceSaleMap');

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error('FATAL: TEST_DATABASE_URL not set. Refusing to run.');
  console.error('       Requires an isolated NON-PRODUCTION PostgreSQL instance.');
  process.exit(2);
}
const PROD_DB = process.env.DATABASE_URL || '';
function normalizeUrl(u) { return String(u || '').replace(/\?.*$/, '').trim().toLowerCase(); }
if (PROD_DB && normalizeUrl(TEST_DB) === normalizeUrl(PROD_DB)) {
  console.error('FATAL: TEST_DATABASE_URL matches DATABASE_URL (production). Refusing.');
  process.exit(2);
}
if (/disciplined-heart/i.test(TEST_DB)) {
  console.error('FATAL: TEST_DATABASE_URL references disciplined-heart. Refusing.');
  process.exit(2);
}
if (/prod|production/i.test(TEST_DB) && !/test|staging|dev|dry|sandbox|nurturing/i.test(TEST_DB)) {
  console.error('FATAL: TEST_DATABASE_URL appears to reference a production database.');
  process.exit(2);
}

let pg;
try { pg = require('pg'); } catch (e) {
  console.error('FATAL: `pg` not installed. Run from src/proxy-server/ directory.');
  process.exit(2);
}

function splitSql(sql) {
  const lines = sql.split('\n').filter((l) => !l.trim().startsWith('--'));
  const clean = lines.join('\n');
  const out = []; let buf = ''; let inDollar = false; let inQuote = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '$' && clean[i + 1] === '$' && !inQuote) { inDollar = !inDollar; buf += '$$'; i++; continue; }
    if (ch === "'" && !inDollar) inQuote = !inQuote;
    buf += ch;
    if (ch === ';' && !inDollar && !inQuote) { const t = buf.trim().replace(/;$/, '').trim(); if (t) out.push(t); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
function preview(s, n = 80) { const c = s.replace(/\s+/g, ' ').trim(); return c.length > n ? c.slice(0, n) + '…' : c; }

// ── Deal cross-contamination guard (mirrors the fixed onLeadUpdatedSyncDeal) ──
// Job-owned fields (amount, project_type, property_address, sold_date) are NEVER
// synced from Lead to an existing Deal. Only identity fields (assigned_rep) sync,
// and only to ALL deals (never an arbitrary deals[0]).
const JOB_OWNED_FIELDS = ['amount', 'project_type', 'property_address', 'sold_date'];
function resolveDealUpdates(lead, deals, changedFields) {
  if (!deals || deals.length === 0) return { updates: {}, targets: [] };
  const updates = {};
  // name (customer-level) — allowed
  if (changedFields.includes('first_name') || changedFields.includes('last_name')) {
    updates.name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
  }
  // assigned_rep (identity) — allowed, applies to all deals
  if (changedFields.includes('assigned_rep')) {
    updates.assigned_rep = lead.assigned_rep ?? null;
  }
  // Job-owned fields — NEVER synced from Lead to Deal
  for (const f of JOB_OWNED_FIELDS) {
    if (changedFields.includes(f)) {
      // explicitly ignored — no update produced
    }
  }
  return { updates, targets: deals.map((d) => d.id) };
}

async function run() {
  const report = {
    timestamp: new Date().toISOString(),
    testDatabaseUrl: TEST_DB.replace(/:[^:@/]+@/, ':***@'),
    migrationFile: 'db/migrations/2026-10-qb-invoice-sale-map.sql',
    pgVersion: null,
    migration: { statements: [], errors: [] },
    tests: {},
    idempotency: null,
    overallPass: false,
    summary: {},
  };

  const pool = new pg.Pool({ connectionString: TEST_DB });
  const client = await pool.connect();
  const db = { query: (t, p) => client.query(t, p) };

  try {
    const v = await client.query('SHOW server_version');
    report.pgVersion = v.rows[0].server_version;

    await client.query('BEGIN');

    // ── Apply migration ──
    const migrationPath = path.join(__dirname, '..', 'db', 'migrations', '2026-10-qb-invoice-sale-map.sql');
    const statements = splitSql(fs.readFileSync(migrationPath, 'utf8'));
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const t0 = performance.now();
      try {
        await client.query(stmt);
        report.migration.statements.push({ index: i + 1, ok: true, ms: +(performance.now() - t0).toFixed(3), preview: preview(stmt) });
      } catch (e) {
        report.migration.statements.push({ index: i + 1, ok: false, ms: +(performance.now() - t0).toFixed(3), preview: preview(stmt), error: e.message });
        report.migration.errors.push({ index: i + 1, error: e.message });
      }
    }

    // ── Helpers ──
    // Real Base44 Lead/Deal IDs are 24-char MongoDB ObjectId hex strings,
    // NOT UUIDs. The migration uses TEXT for crm_*_id to accept them.
    const leadId = '6a7e867f5d54151c702a1691';
    const cust = 'CUST-100';
    const saleA = '6a7ce04c43500beb8e5334aa'; // Exterior Painting 4724
    const saleB = '6a7ce04c43500beb8e5334bb'; // Sidewalk Apoxy 4869
    const saleC = '6a7ce04c43500beb8e5334cc'; // Pavers 16500

    async function seedInvoice(invId, total, paid, opts = {}) {
      await map.upsertInvoiceCache(db, {
        qb_invoice_id: invId, qb_doc_number: opts.doc || ('#' + invId.slice(-4)),
        qb_customer_id: opts.customer || cust,
        total_amt: total, balance: total - paid, paid, txn_status: opts.status || (paid >= total && total > 0 ? 'Paid' : (paid > 0 ? 'Partial' : 'Open')),
        voided: !!opts.voided, txn_date: opts.date || '2026-08-11',
      });
    }
    async function mapInv(invId, saleId, opts = {}) {
      await map.upsertMapping(db, {
        qb_invoice_id: invId, qb_doc_number: opts.doc || ('#' + invId.slice(-4)),
        crm_sale_id: saleId, crm_lead_id: opts.leadId || leadId,
        qb_customer_id: opts.customer || cust, mapping_method: opts.method || 'crm_created',
      });
    }
    function fin(saleTotal, saleId) {
      return map.getInvoicesForSale(db, saleId).then((invs) => map.computeSaleFinancials(saleTotal, invs));
    }

    // ── Test A: 1 Sale, 1 invoice, fully paid ──
    {
      await seedInvoice('INV-A1', 4724, 4724);
      await mapInv('INV-A1', saleA);
      const f = await fin(4724, saleA);
      report.tests.A = {
        scenario: '1 Lead + 1 Sale + 1 invoice fully paid',
        result: f,
        pass: f.invoiced === 4724 && f.paid === 4724 && f.balance === 0 && f.payment_status === 'paid',
      };
    }

    // ── Test B: 3 Sales, 1 invoice each, independent ──
    {
      await seedInvoice('INV-BA', 4724, 0);
      await mapInv('INV-BA', saleA);
      await seedInvoice('INV-BB', 4869, 0);
      await mapInv('INV-BB', saleB);
      await seedInvoice('INV-BC', 16500, 1500);
      await mapInv('INV-BC', saleC);
      const fA = await fin(4724, saleA);
      const fB = await fin(4869, saleB);
      const fC = await fin(16500, saleC);
      report.tests.B = {
        scenario: '1 Lead + 3 Sales (4724/4869/16500), 1 invoice each',
        saleA: fA, saleB: fB, saleC: fC,
        pass: fA.invoiced === 4724 && fA.paid === 0 && fA.payment_status === 'unpaid'
           && fB.invoiced === 4869 && fB.paid === 0 && fB.payment_status === 'unpaid'
           && fC.invoiced === 16500 && fC.paid === 1500 && fC.payment_status === 'partial'
           && fA.balance === 4724 && fB.balance === 4869 && fC.balance === 15000,
      };
    }

    // ── Test C: 2 Sales with IDENTICAL amounts, invoice on one only ──
    {
      const saleX = '6a7ce04c43500beb8e533401'; // 4869
      const saleY = '6a7ce04c43500beb8e533402'; // 4869 (identical)
      await seedInvoice('INV-CX', 4869, 4869);
      await mapInv('INV-CX', saleX);
      // saleY has NO invoice
      const fX = await fin(4869, saleX);
      const fY = await fin(4869, saleY);
      report.tests.C = {
        scenario: '2 Sales identical amount (4869), invoice on Sale X only',
        saleX: fX, saleY: fY,
        pass: fX.invoiced === 4869 && fX.paid === 4869 && fX.payment_status === 'paid'
           && fY.invoiced === 0 && fY.paid === 0 && fY.payment_status === 'unpaid'
           && fY.balance === 4869,
      };
    }

    // ── Test D: 1 Sale (C) with 3 invoices, aggregate ──
    {
      await seedInvoice('INV-DC1', 5000, 0);
      await mapInv('INV-DC1', saleC);
      await seedInvoice('INV-DC2', 5000, 0);
      await mapInv('INV-DC2', saleC);
      await seedInvoice('INV-DC3', 6500, 1500);
      await mapInv('INV-DC3', saleC);
      const fC = await fin(16500, saleC);
      // Note: INV-BC from test B also mapped to saleC; total saleC invoices = BC(16500,1500)+DC1+DC2+DC3
      const allC = await map.getInvoicesForSale(db, saleC);
      const expectedInvoiced = allC.reduce((s, i) => s + Number(i.total_amt), 0);
      const expectedPaid = allC.reduce((s, i) => s + Number(i.paid), 0);
      report.tests.D = {
        scenario: 'Sale C with multiple invoices, all aggregate to C only',
        saleC: fC, invoiceCount: allC.length, expectedInvoiced, expectedPaid,
        pass: fC.invoiced === Math.round(expectedInvoiced * 100) / 100 && fC.paid === 1500 && allC.length >= 4,
      };
    }

    // ── Test E: partial payment on only Sale C (Joann critical) ──
    {
      const fA = await fin(4724, saleA);
      const fB = await fin(4869, saleB);
      const fC = await fin(16500, saleC);
      report.tests.E = {
        scenario: 'Joann critical: A=4724 B=4869 C=16500, $1500 paid only on C',
        saleA: fA, saleB: fB, saleC: fC,
        pass: fA.paid === 0 && fB.paid === 0 && fC.paid >= 1500
           && fA.payment_status === 'unpaid' && fB.payment_status === 'unpaid',
      };
    }

    // ── Test F: Sale A fully paid, Sale B unpaid (same Lead) ──
    {
      // Make a fully-paid invoice for A and confirm B stays unpaid
      await seedInvoice('INV-FA', 4724, 4724);
      await mapInv('INV-FA', saleA);
      const fA = await fin(4724, saleA);
      const fB = await fin(4869, saleB);
      report.tests.F = {
        scenario: 'Sale A fully paid, Sale B (same Lead) unpaid',
        saleA: fA, saleB: fB,
        pass: fA.payment_status === 'paid' && fB.payment_status === 'unpaid' && fB.paid === 0,
      };
    }

    // ── Test G: voided invoice mapped to a Sale → excluded ──
    {
      const saleG = '6a7ce04c43500beb8e533403';
      await seedInvoice('INV-GV', 1000, 1000, { voided: true });
      await mapInv('INV-GV', saleG);
      const invs = await map.getInvoicesForSale(db, saleG);
      const fG = await fin(1000, saleG);
      report.tests.G = {
        scenario: 'Voided invoice mapped to Sale G → excluded from financials',
        invoiceCount: invs.length, saleG: fG,
        pass: invs.length === 0 && fG.invoiced === 0 && fG.paid === 0 && fG.payment_status === 'unpaid',
      };
    }

    // ── Test H: legacy invoice with NO mapping → UNMAPPED, contributes to no Sale ──
    {
      await seedInvoice('INV-LEGACY', 9999, 0);
      // no mapInv call → unmapped
      const resolvers = {
        leadIdForCustomer: (c) => (c === cust ? leadId : null),
        dealCountForLead: () => 3, // multi-deal lead → AMBIGUOUS for any mapped; legacy is UNMAPPED
      };
      const classified = await map.classifyExisting(db, resolvers);
      const legacy = classified.find((r) => r.qb_invoice_id === 'INV-LEGACY');
      // Assert it contributes to no sale: getInvoicesForSale for A/B/C must not include it
      const fA = await fin(4724, saleA);
      report.tests.H = {
        scenario: 'Legacy invoice with no crm_sale_id → UNMAPPED, no Sale contribution',
        legacyClassification: legacy ? legacy.classification : 'NOT_FOUND',
        saleA: fA,
        pass: legacy && legacy.classification === 'UNMAPPED' && fA.invoiced < 9999,
      };
    }

    // ── Test I: duplicate mapping upsert → idempotent, no reassign ──
    {
      await seedInvoice('INV-IDEM', 3000, 0);
      await mapInv('INV-IDEM', saleA, { doc: '#IDEM' });
      // Attempt to reassign to saleB — must NOT take effect
      await map.upsertMapping(db, {
        qb_invoice_id: 'INV-IDEM', qb_doc_number: '#IDEM', crm_sale_id: saleB,
        crm_lead_id: leadId, qb_customer_id: cust, mapping_method: 'crm_created',
      });
      const m = await map.getMappingByInvoiceId(db, 'INV-IDEM');
      const fA = await fin(4724, saleA);
      const fB = await fin(4869, saleB);
      report.tests.I = {
        scenario: 'Duplicate upsert with different crm_sale_id → original retained',
        mappingCrmSaleId: m ? m.crm_sale_id : null,
        saleA: fA, saleB: fB,
        pass: m && m.crm_sale_id === saleA && fA.invoiced >= 3000 && fB.invoiced === 0,
      };
    }

    // ── Test J: Deal field cross-contamination guard (pure JS) ──
    {
      const lead = { first_name: 'Joann', last_name: 'Gregg', assigned_rep: 'Yaron', estimated_value: 999999, project_type: 'BOGUS', property_address: '999 Changed', sold_date: '2099-01-01' };
      const deals = [
        { id: saleA, amount: 4724, project_type: 'Exterior Painting', sold_date: '2026-08-11' },
        { id: saleB, amount: 4869, project_type: 'Sidewalk Apoxy', sold_date: '2026-08-03' },
        { id: saleC, amount: 16500, project_type: 'Pavers', sold_date: '2026-07-29' },
      ];
      const changed = ['estimated_value', 'project_type', 'property_address', 'sold_date'];
      const { updates, targets } = resolveDealUpdates(lead, deals, changed);
      const touchesJobOwned = JOB_OWNED_FIELDS.some((f) => Object.keys(updates).includes(f));
      // Second pass: changing assigned_rep should update all deals' assigned_rep but NOT job-owned fields
      const { updates: u2 } = resolveDealUpdates(lead, deals, ['assigned_rep']);
      const touchesJobOwned2 = JOB_OWNED_FIELDS.some((f) => Object.keys(u2).includes(f));
      report.tests.J = {
        scenario: 'Lead field changes do NOT overwrite Deal job-owned fields',
        updatesFromJobOwnedChange: updates,
        targetsCount: targets.length,
        updatesFromRepChange: u2,
        pass: !touchesJobOwned && !touchesJobOwned2 && Object.keys(updates).every((k) => !JOB_OWNED_FIELDS.includes(k))
           && u2.assigned_rep === 'Yaron' && Object.keys(u2).every((k) => !JOB_OWNED_FIELDS.includes(k)),
      };
    }

    // ── Idempotency: re-run migration, expect zero errors ──
    let idemErrors = 0; const idemDetails = [];
    for (const stmt of statements) {
      try { await client.query(stmt); } catch (e) { idemErrors++; idemDetails.push({ preview: preview(stmt), error: e.message }); }
    }
    report.idempotency = { ok: idemErrors === 0, errorsOnRerun: idemErrors, details: idemDetails };

    await client.query('ROLLBACK');
    report.summary.rollback = 'success — zero persistent changes';

    const testPasses = Object.values(report.tests).map((t) => t.pass);
    report.overallPass = !!(
      report.migration.errors.length === 0 &&
      report.idempotency.ok &&
      report.idempotency.errorsOnRerun === 0 &&
      testPasses.every(Boolean) &&
      report.summary.rollback === 'success — zero persistent changes'
    );
    report.summary.testsPassed = testPasses.filter(Boolean).length;
    report.summary.testsTotal = testPasses.length;
  } catch (e) {
    report.migration.errors.push({ fatal: true, error: e.message, stack: e.stack });
    try { await client.query('ROLLBACK'); } catch (_) {}
  } finally {
    client.release();
    await pool.end();
  }
  return report;
}

run()
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.overallPass ? 0 : 1); })
  .catch((e) => { console.error('DRY RUN CRASH:', e); process.exit(1); });