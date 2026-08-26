/* eslint-disable no-undef */
'use strict';
/**
 * migrateInvoicesToRailway.js — Idempotent invoice migration from Base44 to Railway.
 *
 * PREREQUISITE: migrateLeadsToRailway.js AND migrateDealsToRailway.js.
 * (invoices.lead_id FK → leads, invoices.deal_id FK → deals)
 *
 * Railway invoices table has NO CHECK constraints on any column — all text
 * fields accept any value. The Base44 enum defaults (status='draft',
 * payment_status='unpaid', etc.) are preserved via null-coalescing, but
 * since Base44 enforces these enums, null/empty should never occur.
 *
 * IDEMPOTENT: ON CONFLICT (external_ref) DO UPDATE.
 */
const { query: defaultQuery } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, buildDealIdCache, hasBase44Creds } = require('./migrationHelpers');

async function runInvoiceMigration(queryFn = defaultQuery) {
  console.log('[migrate-invoices] Starting invoice migration...');

  const [leadIdCache, dealIdCache] = await Promise.all([
    buildLeadIdCache(queryFn),
    buildDealIdCache(queryFn),
  ]);
  console.log(`[migrate-invoices] Loaded ${Object.keys(leadIdCache).length} lead, ${Object.keys(dealIdCache).length} deal mappings`);

  const base44Invoices = await fetchBase44Entity('Invoice');
  console.log(`[migrate-invoices] Fetched ${base44Invoices.length} invoices from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, leadNotFound = 0, dealNotFound = 0;
  for (let i = 0; i < base44Invoices.length; i++) {
    const inv = base44Invoices[i];
    try {
      const externalRef = inv.id;
      if (!externalRef) { skipped++; continue; }
      const railwayLeadId = inv.lead_id ? (leadIdCache[String(inv.lead_id)] || null) : null;
      const railwayDealId = inv.deal_id ? (dealIdCache[String(inv.deal_id)] || null) : null;
      if (inv.lead_id && !railwayLeadId) leadNotFound++;
      if (inv.deal_id && !railwayDealId) dealNotFound++;

      const num = (v) => (v !== null && v !== undefined && !isNaN(Number(v))) ? Number(v) : 0;
      const emailRecipients = Array.isArray(inv.email_recipients) ? JSON.stringify(inv.email_recipients) : '[]';

      const { rows } = await queryFn(`
        INSERT INTO invoices (
          external_ref, lead_id, deal_id, invoice_number, amount, description,
          payment_stage, due_date, status, qb_invoice_id, qb_invoice_number,
          qb_status, qb_invoice_url, qb_pdf_url, qb_pdf_status, qb_pdf_generated_at,
          qb_pdf_retry_count, payment_received, payment_status, payment_method,
          payment_date, notes, synced_to_qb, qb_sync_error, qb_last_sync_at,
          email_sent_date, email_recipients, email_delivery_status, email_error, email_resend_count
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
        )
        ON CONFLICT (external_ref) DO UPDATE SET
          lead_id = COALESCE(EXCLUDED.lead_id, invoices.lead_id),
          deal_id = COALESCE(EXCLUDED.deal_id, invoices.deal_id),
          invoice_number = COALESCE(EXCLUDED.invoice_number, invoices.invoice_number),
          amount = EXCLUDED.amount,
          description = COALESCE(EXCLUDED.description, invoices.description),
          payment_stage = EXCLUDED.payment_stage,
          due_date = COALESCE(EXCLUDED.due_date, invoices.due_date),
          status = EXCLUDED.status,
          qb_invoice_id = COALESCE(EXCLUDED.qb_invoice_id, invoices.qb_invoice_id),
          qb_invoice_number = COALESCE(EXCLUDED.qb_invoice_number, invoices.qb_invoice_number),
          qb_status = COALESCE(EXCLUDED.qb_status, invoices.qb_status),
          qb_invoice_url = COALESCE(EXCLUDED.qb_invoice_url, invoices.qb_invoice_url),
          qb_pdf_url = COALESCE(EXCLUDED.qb_pdf_url, invoices.qb_pdf_url),
          qb_pdf_status = EXCLUDED.qb_pdf_status,
          payment_received = EXCLUDED.payment_received,
          payment_status = EXCLUDED.payment_status,
          payment_method = COALESCE(EXCLUDED.payment_method, invoices.payment_method),
          payment_date = COALESCE(EXCLUDED.payment_date, invoices.payment_date),
          notes = COALESCE(EXCLUDED.notes, invoices.notes),
          synced_to_qb = EXCLUDED.synced_to_qb,
          qb_sync_error = COALESCE(EXCLUDED.qb_sync_error, invoices.qb_sync_error),
          email_delivery_status = EXCLUDED.email_delivery_status,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef), railwayLeadId, railwayDealId,
        inv.invoice_number || null, num(inv.amount), inv.description || null,
        inv.payment_stage || 'custom', inv.due_date || null, inv.status || 'draft',
        inv.qb_invoice_id || null, inv.qb_invoice_number || null,
        inv.qb_status || null, inv.qb_invoice_url || null, inv.qb_pdf_url || null,
        inv.qb_pdf_status || 'pending', inv.qb_pdf_generated_at || null,
        inv.qb_pdf_retry_count || 0, num(inv.payment_received),
        inv.payment_status || 'unpaid', inv.payment_method || null,
        inv.payment_date || null, inv.notes || null,
        inv.synced_to_qb === true, inv.qb_sync_error || null, inv.qb_last_sync_at || null,
        inv.email_sent_date || null, emailRecipients,
        inv.email_delivery_status || 'pending', inv.email_error || null, inv.email_resend_count || 0,
      ]);
      if (rows[0]?.inserted) created++; else updated++;
      if ((i + 1) % 100 === 0) console.log(`[migrate-invoices] Progress: ${i + 1}/${base44Invoices.length}`);
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-invoices] Error on ${inv.id}: ${e.message}`);
    }
  }

  console.log(`\n=== INVOICE MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Invoices.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Unresolvable lead_id: ${leadNotFound}, Unresolvable deal_id: ${dealNotFound}`);
  const { rows } = await queryFn('SELECT COUNT(*) as cnt FROM invoices');
  console.log(`Railway invoices table now has: ${rows[0].cnt} rows`);

  return { created, updated, skipped, errors, leadNotFound, dealNotFound, total: base44Invoices.length };
}

module.exports = { runInvoiceMigration };

if (require.main === module) {
  if (!hasBase44Creds()) { console.error('[migrate-invoices] WORKER_SECRET required'); process.exit(1); }
  runInvoiceMigration().then(() => process.exit(0)).catch(e => { console.error('[migrate-invoices] fatal:', e); process.exit(1); });
}