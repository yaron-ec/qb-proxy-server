/* eslint-disable no-undef */
'use strict';
/**
 * auditQbIdentity.js — Comprehensive audit of QuickBooks customer identity
 * in the Railway database.
 *
 * READ-ONLY. No writes.
 *
 * Checks:
 *   1. Full leads table schema (all columns, especially qb_customer_id)
 *   2. qb_invoice_sale_map entries for QB customers 49, 58, 59, 61, 62
 *   3. handoff_estimates for the 5 key leads (Michael, Hannah, David, Desire)
 *   4. Whether any Railway leads already have qb_customer_id populated
 *   5. qb_invoices_cache entries for QB customers 49, 58, 59, 61, 62
 *   6. All existing migrations that reference qb_customer_id
 */
const { query } = require('../db/client');

async function runAudit() {
  const report = {
    timestamp: new Date().toISOString(),
    sections: {},
  };

  // ── 1. Full leads table schema ──────────────────────────────────────────
  try {
    const { rows: cols } = await query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'leads'
      ORDER BY ordinal_position
    `);
    report.sections.leadsSchema = cols;
    report.sections.leadsHasQbCustomerId = cols.some(c => c.column_name === 'qb_customer_id');
  } catch (e) {
    report.sections.leadsSchemaError = e.message;
  }

  // ── 2. Check if any Railway leads have qb_customer_id populated ──────────
  if (report.sections.leadsHasQbCustomerId) {
    try {
      const { rows } = await query(`
        SELECT COUNT(*) as total,
               COUNT(qb_customer_id) as with_qb_customer_id
        FROM leads
      `);
      report.sections.leadsQbCustomerIdCount = rows[0];

      const { rows: sample } = await query(`
        SELECT external_ref, first_name, last_name, qb_customer_id
        FROM leads
        WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''
        LIMIT 20
      `);
      report.sections.leadsQbCustomerIdSample = sample;
    } catch (e) {
      report.sections.leadsQbCustomerIdError = e.message;
    }
  }

  // ── 3. qb_invoice_sale_map entries for key QB customers ──────────────────
  try {
    const { rows } = await query(`
      SELECT qb_customer_id, COUNT(*) as cnt,
             array_agg(DISTINCT crm_lead_id) as lead_ids,
             array_agg(DISTINCT crm_sale_id) as sale_ids
      FROM qb_invoice_sale_map
      WHERE qb_customer_id IN ('49', '58', '59', '61', '62', '60')
      GROUP BY qb_customer_id
      ORDER BY qb_customer_id
    `);
    report.sections.qbInvoiceSaleMapByKeyCustomers = rows;
  } catch (e) {
    report.sections.qbInvoiceSaleMapError = e.message;
  }

  // ── 4. qb_invoices_cache entries for key QB customers ────────────────────
  try {
    const { rows } = await query(`
      SELECT qb_customer_id, COUNT(*) as cnt,
             array_agg(DISTINCT qb_invoice_id) as invoice_ids
      FROM qb_invoices_cache
      WHERE qb_customer_id IN ('49', '58', '59', '61', '62', '60')
      GROUP BY qb_customer_id
      ORDER BY qb_customer_id
    `);
    report.sections.qbInvoicesCacheByKeyCustomers = rows;
  } catch (e) {
    report.sections.qbInvoicesCacheError = e.message;
  }

  // ── 5. Railway leads by external_ref for the 5 key leads ────────────────
  const keyLeadRefs = [
    { external_ref: '69f937ee6a0dbf5bfc7ae49b', name: 'Michael Caughey', expected_qb: '49' },
    { external_ref: '69f937cd99ff3ef2652dc88e', name: 'Hannah Peaslee', expected_qb: '61' },
    { external_ref: '69fac331a97f1babcf4a5375', name: 'David Fargo', expected_qb: '59' },
    { external_ref: '69fac33595ee04a5e0fca791', name: 'Desire Jones', expected_qb: '58' },
  ];

  try {
    const refs = keyLeadRefs.map(r => r.external_ref);
    const { rows } = await query(`
      SELECT id, external_ref, first_name, last_name, email, phone,
             ${report.sections.leadsHasQbCustomerId ? 'qb_customer_id' : 'NULL as qb_customer_id'},
             status, owner_id
      FROM leads
      WHERE external_ref = ANY($1)
    `, [refs]);
    report.sections.keyLeadsInRailway = rows.map(r => {
      const expected = keyLeadRefs.find(k => k.external_ref === r.external_ref);
      return { ...r, expected_qb_customer_id: expected?.expected_qb, name_label: expected?.name };
    });
  } catch (e) {
    report.sections.keyLeadsError = e.message;
  }

  // ── 6. handoff_estimates for key leads ──────────────────────────────────
  try {
    // Get lead IDs for key leads
    const refs = keyLeadRefs.map(r => r.external_ref);
    const { rows: leadRows } = await query(`
      SELECT id, external_ref FROM leads WHERE external_ref = ANY($1)
    `, [refs]);
    const leadIds = leadRows.map(r => r.id);

    if (leadIds.length > 0) {
      const { rows } = await query(`
        SELECT lead_id, qb_estimate_id, qb_estimate_number, customer_name,
               estimate_amount, estimate_status, match_status, match_method
        FROM handoff_estimates
        WHERE lead_id = ANY($1)
        ORDER BY created_at DESC
        LIMIT 50
      `, [leadIds]);
      report.sections.handoffEstimatesForKeyLeads = rows;
    } else {
      report.sections.handoffEstimatesForKeyLeads = [];
    }
  } catch (e) {
    report.sections.handoffEstimatesError = e.message;
  }

  // ── 7. All Railway leads count ───────────────────────────────────────────
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM leads');
    report.sections.totalRailwayLeads = parseInt(rows[0].cnt, 10);
  } catch (e) {
    report.sections.totalRailwayLeadsError = e.message;
  }

  // ── 8. Existing migrations referencing qb_customer_id ────────────────────
  try {
    const fs = require('fs');
    const path = require('path');
    const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir) : [];
    const qbMigrations = [];
    for (const f of files) {
      if (!f.endsWith('.sql')) continue;
      const content = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      if (content.includes('qb_customer_id')) {
        qbMigrations.push(f);
      }
    }
    report.sections.migrationsReferencingQbCustomerId = qbMigrations;
  } catch (e) {
    report.sections.migrationsError = e.message;
  }

  // ── 9. Summary ──────────────────────────────────────────────────────────
  report.sections.summary = {
    leadsTableExists: !!report.sections.leadsSchema,
    leadsHasQbCustomerId: report.sections.leadsHasQbCustomerId || false,
    totalRailwayLeads: report.sections.totalRailwayLeads || 0,
    keyLeadsFoundInRailway: (report.sections.keyLeadsInRailway || []).length,
    handoffEstimatesForKeyLeads: (report.sections.handoffEstimatesForKeyLeads || []).length,
    qbInvoiceSaleMapEntries: (report.sections.qbInvoiceSaleMapByKeyCustomers || []).length,
    qbInvoicesCacheEntries: (report.sections.qbInvoicesCacheByKeyCustomers || []).length,
    migrationsReferencingQbCustomerId: (report.sections.migrationsReferencingQbCustomerId || []).length,
  };

  console.log(JSON.stringify(report, null, 2));
}

runAudit().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});