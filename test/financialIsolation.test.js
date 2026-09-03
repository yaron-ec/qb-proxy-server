/* eslint-disable no-undef */
/**
 * Financial Sale Isolation regression tests.
 *
 * Verifies that:
 *   1. The invoices table has a deal_id column with FK to deals(id)
 *   2. The dealFinancials endpoint computes sale-scoped financials (not customer-scoped)
 *   3. The financial backfill only maps invoices when there is exactly ONE deal
 *   4. The qbInvoiceSaleMap module uses crm_sale_id as the ownership key
 *   5. No customer-level aggregation is used for individual sale financials
 *   6. The migration adds an index on invoices.deal_id
 */
'use strict';
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Test 1: invoices table has deal_id FK ──────────────────────────────────
test('Financial isolation: invoices table has deal_id with FK to deals', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '2026-14-crm-remaining-tables.sql'), 'utf8');
  assert.ok(migration.includes('deal_id UUID REFERENCES deals(id)'), 'invoices must have deal_id FK to deals');
  assert.ok(/deal_id.*ON DELETE SET NULL/i.test(migration), 'invoices.deal_id must be ON DELETE SET NULL');
});

// ── Test 2: migration 2026-28 adds index on invoices.deal_id ───────────────
test('Financial isolation: migration 2026-28 adds index on invoices.deal_id', () => {
  const migrationPath = path.join(ROOT, 'db', 'migrations', '2026-28-financial-isolation-and-migration-safety.sql');
  assert.ok(fs.existsSync(migrationPath), 'migration 2026-28 must exist');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  assert.ok(migration.includes('invoices_deal_id_idx'), 'must add invoices_deal_id_idx index');
  assert.ok(/CREATE INDEX IF NOT EXISTS invoices_deal_id_idx ON invoices \(deal_id\)/.test(migration),
    'must create index on invoices.deal_id');
});

// ── Test 3: dealFinancials uses sale-scoped query (not customer-scoped) ────
test('Financial isolation: dealFinancials uses getInvoicesForSale (sale-scoped)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'dealFinancials.js'), 'utf8');
  assert.ok(src.includes('getInvoicesForSale'), 'must use getInvoicesForSale');
  assert.ok(src.includes('computeSaleFinancials'), 'must use computeSaleFinancials');
  // Must NOT use customer-level aggregation
  assert.ok(!src.includes('qb_customer_id') || src.includes('qb_customer_id') === false,
    'must not aggregate by customer');
});

// ── Test 4: qbInvoiceSaleMap uses crm_sale_id as ownership key ─────────────
test('Financial isolation: qbInvoiceSaleMap uses crm_sale_id as ownership key', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'qbInvoiceSaleMap.js'), 'utf8');
  assert.ok(src.includes('crm_sale_id'), 'must use crm_sale_id');
  assert.ok(src.includes('ON CONFLICT (qb_invoice_id) DO NOTHING'), 'must never reassign existing mapping');
  assert.ok(src.includes('getInvoicesForSale'), 'must have getInvoicesForSale');
  assert.ok(src.includes('computeSaleFinancials'), 'must have computeSaleFinancials');
});

// ── Test 5: computeSaleFinancials is sale-scoped (not customer-scoped) ────
test('Financial isolation: computeSaleFinancials only uses sale-scoped invoices', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'qbInvoiceSaleMap.js'), 'utf8');
  // getInvoicesForSale must filter by crm_sale_id
  assert.ok(/getInvoicesForSale[\s\S]*?WHERE m\.crm_sale_id = \$1/.test(src),
    'getInvoicesForSale must filter by crm_sale_id');
  // Must exclude voided invoices
  assert.ok(/COALESCE\(m\.voided, FALSE\) = FALSE/.test(src),
    'must exclude voided invoices from sale financials');
  assert.ok(/COALESCE\(c\.voided, FALSE\) = FALSE/.test(src),
    'must exclude voided cache invoices from sale financials');
});

// ── Test 6: financial backfill only maps when deal_count === 1 ─────────────
test('Financial isolation: backfill only maps invoices with exactly 1 deal', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'financialBackfill.js'), 'utf8');
  assert.ok(src.includes('deal_count'), 'must check deal_count');
  assert.ok(/Number\(i\.deal_count\) === 1/.test(src), 'must only auto-map when deal_count === 1');
  assert.ok(src.includes('ambiguous'), 'must report ambiguous records');
  assert.ok(!/deal_count.*>.*1.*auto/.test(src), 'must NOT auto-map ambiguous records');
});

// ── Test 7: saleInvoices /map requires crm_sale_id ─────────────────────────
test('Financial isolation: saleInvoices /map requires crm_sale_id', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'saleInvoices.js'), 'utf8');
  assert.ok(src.includes('crm_sale_id is required'), 'must require crm_sale_id');
  assert.ok(src.includes('ON CONFLICT DO NOTHING'), 'must be idempotent (never reassign)');
});

// ── Test 8: leadQB returns invoices with deal_id for sale grouping ─────────
test('Financial isolation: leadQB returns invoices with deal_id', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leadQB.js'), 'utf8');
  assert.ok(src.includes('deal_id'), 'must return deal_id on CRM invoices');
  assert.ok(src.includes('crm_sale_id'), 'must return crm_sale_id on QB invoices');
});

// ── Test 9: QB executive metrics is sale-scoped ────────────────────────────
test('Financial isolation: QB executive metrics uses sale-scoped data', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'qbExecutiveMetrics.js'), 'utf8');
  assert.ok(src.includes('crm_sale_id'), 'must use crm_sale_id for sale-scoped revenue');
  assert.ok(src.includes('qb_invoice_sale_map'), 'must join qb_invoice_sale_map');
  assert.ok(!src.includes('base44.asServiceRole'), 'must not use Base44');
  assert.ok(!src.includes('@base44/sdk'), 'must not import @base44/sdk');
});

// ── Test 10: No customer-level aggregation in any financial route ──────────
test('Financial isolation: no customer-level aggregation in financial routes', () => {
  const files = ['dealFinancials.js', 'saleInvoices.js', 'financialBackfill.js', 'qbExecutiveMetrics.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8');
    // No SUM/total aggregation by customer without sale_id filter
    assert.ok(!/GROUP BY.*qb_customer_id/.test(src), `${f} must not group by customer without sale scope`);
  }
});