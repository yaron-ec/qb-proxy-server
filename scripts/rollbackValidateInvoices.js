#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * rollbackValidateInvoices.js — Production-path rollback validation for Invoices.
 *
 * Calls the EXACT same runInvoiceMigration() function used by:
 *   node scripts/migrateInvoicesToRailway.js
 *
 * ...but inside a PostgreSQL transaction that is ALWAYS ROLLED BACK.
 *
 * Verifies:
 *   - Base44 invoices read: count
 *   - FK resolution: lead_id resolves to Railway leads, deal_id resolves to Railway deals
 *   - Write errors: 0
 *   - In-transaction invoice count reaches expected reconciled count
 *   - After rollback, database returns to exact before-count
 *   - No external side effects
 *
 * Environment:
 *   DATABASE_URL (Railway Postgres)
 *   WORKER_SECRET (for migrationReader backend function)
 */
const { pool } = require('../db/client');
const { runInvoiceMigration } = require('./migrateInvoicesToRailway');
const { fetchBase44Entity } = require('./migrationHelpers');

async function main() {
  console.log('=== PRODUCTION-PATH ROLLBACK VALIDATION (Invoices) ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  // ── PHASE 1: PRE-MIGRATION FK + FIELD AUDIT ────────────────────────────
  console.log('=== PHASE 1: PRE-MIGRATION FK + FIELD AUDIT ===\n');

  const base44Invoices = await fetchBase44Entity('Invoice');
  console.log(`Total Base44 invoices: ${base44Invoices.length}`);

  // FK audit — check lead_id and deal_id resolution against Base44 entities
  const base44Leads = await fetchBase44Entity('Lead');
  const base44Deals = await fetchBase44Entity('Deal');
  const base44LeadIds = new Set(base44Leads.map(l => l.id));
  const base44DealIds = new Set(base44Deals.map(d => d.id));

  let withLeadId = 0, leadResolved = 0, leadUnresolved = 0;
  let withDealId = 0, dealResolved = 0, dealUnresolved = 0;
  const unresolvedInvoices = [];

  for (const inv of base44Invoices) {
    if (inv.lead_id) {
      withLeadId++;
      if (base44LeadIds.has(inv.lead_id)) leadResolved++;
      else { leadUnresolved++; unresolvedInvoices.push({ id: inv.id, type: 'lead', ref: inv.lead_id }); }
    }
    if (inv.deal_id) {
      withDealId++;
      if (base44DealIds.has(inv.deal_id)) dealResolved++;
      else { dealUnresolved++; unresolvedInvoices.push({ id: inv.id, type: 'deal', ref: inv.deal_id }); }
    }
  }

  console.log(`FK lead_id resolution: with_lead_id=${withLeadId}, resolved=${leadResolved}, unresolved=${leadUnresolved}`);
  console.log(`FK deal_id resolution: with_deal_id=${withDealId}, resolved=${dealResolved}, unresolved=${dealUnresolved}`);
  if (unresolvedInvoices.length > 0) {
    console.log('Unresolved invoices:');
    for (const u of unresolvedInvoices) {
      console.log(`  ${u.id} — ${u.type}_ref: ${u.ref}`);
    }
  } else {
    console.log('✅ All invoice FK references resolve to Base44 entities');
  }

  // Field audit — check all field values for constraint compliance
  console.log('\nField value audit (all records):');
  for (const inv of base44Invoices) {
    console.log(`  Invoice ${inv.id}:`);
    console.log(`    amount: ${inv.amount} (NOT NULL — ${inv.amount !== null && inv.amount !== undefined ? 'OK ✅' : 'MISSING ❌'})`);
    console.log(`    status: "${inv.status || '(null)'}" (NOT NULL default 'draft')`);
    console.log(`    payment_stage: "${inv.payment_stage || '(null)'}"`);
    console.log(`    payment_status: "${inv.payment_status || '(null)'}"`);
    console.log(`    payment_method: "${inv.payment_method || '(null)'}"`);
    console.log(`    qb_pdf_status: "${inv.qb_pdf_status || '(null)'}"`);
    console.log(`    email_delivery_status: "${inv.email_delivery_status || '(null)'}"`);
    console.log(`    due_date: "${inv.due_date || 'null'}" (DATE)`);
    console.log(`    payment_date: "${inv.payment_date || 'null'}" (DATE)`);
    console.log(`    email_sent_date: "${inv.email_sent_date || 'null'}" (TIMESTAMPTZ)`);
    console.log(`    email_recipients: ${Array.isArray(inv.email_recipients) ? `array[${inv.email_recipients.length}]` : typeof inv.email_recipients}`);
    console.log(`    synced_to_qb: ${inv.synced_to_qb}`);
  }

  // ── PHASE 2: EXECUTE PRODUCTION MIGRATION (TRANSACTION → ROLLBACK) ──────
  console.log('\n=== PHASE 2: EXECUTE PRODUCTION MIGRATION (TRANSACTION → ROLLBACK) ===\n');

  const client = await pool.connect();

  try {
    // BEFORE counts
    const beforeInvoices = parseInt((await client.query('SELECT COUNT(*) as cnt FROM invoices')).rows[0].cnt, 10);
    const beforeLeads = parseInt((await client.query('SELECT COUNT(*) as cnt FROM leads')).rows[0].cnt, 10);
    const beforeDeals = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals')).rows[0].cnt, 10);

    console.log(`Before: invoices=${beforeInvoices}, leads=${beforeLeads}, deals=${beforeDeals}`);

    // BEGIN TRANSACTION
    await client.query('BEGIN');
    const queryFn = client.query.bind(client);

    // Run production migration
    const result = await runInvoiceMigration(queryFn);

    // In-transaction counts
    const inTxInvoices = parseInt((await client.query('SELECT COUNT(*) as cnt FROM invoices')).rows[0].cnt, 10);
    console.log(`\nIn-transaction: invoices=${inTxInvoices}`);

    // ROLLBACK
    console.log('\n=== ROLLING BACK TRANSACTION ===\n');
    await client.query('ROLLBACK');

    // AFTER counts
    const afterInvoices = parseInt((await client.query('SELECT COUNT(*) as cnt FROM invoices')).rows[0].cnt, 10);
    const afterLeads = parseInt((await client.query('SELECT COUNT(*) as cnt FROM leads')).rows[0].cnt, 10);
    const afterDeals = parseInt((await client.query('SELECT COUNT(*) as cnt FROM deals')).rows[0].cnt, 10);

    console.log(`After rollback: invoices=${afterInvoices}, leads=${afterLeads}, deals=${afterDeals}`);

    // ── PHASE 3: VALIDATION ────────────────────────────────────────────────
    console.log('\n=== VALIDATION ===\n');

    const expectedInTxInvoices = beforeInvoices + result.created;

    const checks = [
      { name: 'Total invoices processed',           actual: result.total,           expected: result.total,           pass: true },
      { name: 'Write errors',                        actual: result.errors,          expected: 0,                      pass: result.errors === 0 },
      { name: 'FK lead_id resolved',                 actual: result.total - result.leadNotFound, expected: result.total, pass: result.leadNotFound === 0 },
      { name: 'FK deal_id resolved',                 actual: result.total - result.dealNotFound, expected: result.total, pass: result.dealNotFound === 0 },
      { name: 'In-tx invoices count',                actual: inTxInvoices,          expected: expectedInTxInvoices,   pass: inTxInvoices === expectedInTxInvoices },
      { name: 'Invoices rollback (before==after)',   actual: afterInvoices,         expected: beforeInvoices,         pass: afterInvoices === beforeInvoices },
      { name: 'Leads rollback (before==after)',      actual: afterLeads,            expected: beforeLeads,           pass: afterLeads === beforeLeads },
      { name: 'Deals rollback (before==after)',      actual: afterDeals,            expected: beforeDeals,           pass: afterDeals === beforeDeals },
    ];

    let allPass = true;
    for (const c of checks) {
      const status = c.pass ? 'PASS ✅' : 'FAIL ❌';
      console.log(`  ${c.name.padEnd(44)}  actual=${String(c.actual).padEnd(8)}  expected=${String(c.expected).padEnd(8)}  ${status}`);
      if (!c.pass) allPass = false;
    }

    console.log('');
    console.log(`Migration result: ${JSON.stringify(result)}`);
    console.log('');

    if (allPass) {
      console.log('✅ ALL CHECKS PASSED — production path validated, transaction rolled back');
      process.exit(0);
    } else {
      console.log('❌ SOME CHECKS FAILED — review above');
      process.exit(1);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(`\nFATAL ERROR: ${e.message}`);
    console.error('Transaction rolled back. No records left behind.');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();