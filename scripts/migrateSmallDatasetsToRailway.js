/* eslint-disable no-undef */
/**
 * migrateSmallDatasetsToRailway.js — Import small datasets from Base44 to Railway.
 *
 * PREREQUISITE: Run migrateLeadsToRailway.js FIRST. Migration 2026-14 must be applied
 * (creates user_allowlist, company_settings, sync_cursors, lead_attachments,
 * deal_expenses tables).
 *
 * Run on Railway: node scripts/migrateSmallDatasetsToRailway.js
 *
 * Handles: UserAllowlist (5), CompanySettings (1), SyncCursor (5), LeadAttachment (7),
 * DealExpense (31).
 *
 * Each dataset is imported with ON CONFLICT (external_ref) DO UPDATE for idempotency.
 * Tables that don't have external_ref use ON CONFLICT on their natural unique key.
 */
'use strict';

const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

if (!hasBase44Creds()) {
  console.error('[migrate-small] BASE44_APP_ID and BASE44_API_KEY required');
  process.exit(1);
}

// ── UserAllowlist (uses email as natural key, no external_ref needed) ─────────
async function migrateUserAllowlist() {
  console.log('\n[migrate-small] === UserAllowlist ===');
  const items = await fetchBase44Entity('UserAllowlist');
  console.log(`[migrate-small] Fetched ${items.length} user allowlist entries`);

  let created = 0, updated = 0, errors = 0;
  for (const item of items) {
    try {
      await query(`
        INSERT INTO user_allowlist (email, name, role, enabled, notes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (email) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, user_allowlist.name),
          role = EXCLUDED.role,
          enabled = EXCLUDED.enabled,
          notes = COALESCE(EXCLUDED.notes, user_allowlist.notes),
          updated_at = NOW()
      `, [item.email, item.name || null, item.role || 'sales_rep', item.enabled !== false, item.notes || null]);
      created++;
    } catch (e) {
      errors++;
      console.error(`[migrate-small] UserAllowlist error on ${item.email}: ${e.message}`);
    }
  }
  console.log(`[migrate-small] UserAllowlist: ${created} upserted, ${errors} errors`);
}

// ── CompanySettings (singleton) ──────────────────────────────────────────────
async function migrateCompanySettings() {
  console.log('\n[migrate-small] === CompanySettings ===');
  const items = await fetchBase44Entity('CompanySettings');
  console.log(`[migrate-small] Fetched ${items.length} company settings records`);

  for (const item of items) {
    try {
      await query(`
        INSERT INTO company_settings (
          company_name, company_logo_url, company_email, company_phone,
          company_address, company_city, company_state, company_zip,
          admin_name, admin_email, company_website, crm_activity_notifications_enabled
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (company_name) DO UPDATE SET
          company_logo_url = COALESCE(EXCLUDED.company_logo_url, company_settings.company_logo_url),
          company_email = COALESCE(EXCLUDED.company_email, company_settings.company_email),
          company_phone = COALESCE(EXCLUDED.company_phone, company_settings.company_phone),
          company_address = COALESCE(EXCLUDED.company_address, company_settings.company_address),
          company_city = COALESCE(EXCLUDED.company_city, company_settings.company_city),
          company_state = COALESCE(EXCLUDED.company_state, company_settings.company_state),
          company_zip = COALESCE(EXCLUDED.company_zip, company_settings.company_zip),
          admin_name = COALESCE(EXCLUDED.admin_name, company_settings.admin_name),
          admin_email = COALESCE(EXCLUDED.admin_email, company_settings.admin_email),
          company_website = COALESCE(EXCLUDED.company_website, company_settings.company_website),
          crm_activity_notifications_enabled = EXCLUDED.crm_activity_notifications_enabled,
          updated_at = NOW()
      `, [
        item.company_name || 'EC Construction Group',
        item.company_logo_url || null,
        item.company_email || null,
        item.company_phone || null,
        item.company_address || null,
        item.company_city || null,
        item.company_state || null,
        item.company_zip || null,
        item.admin_name || null,
        item.admin_email || null,
        item.company_website || null,
        item.crm_activity_notifications_enabled === true,
      ]);
      console.log('[migrate-small] CompanySettings upserted');
    } catch (e) {
      console.error(`[migrate-small] CompanySettings error: ${e.message}`);
    }
  }
}

// ── SyncCursor ──────────────────────────────────────────────────────────────
async function migrateSyncCursors() {
  console.log('\n[migrate-small] === SyncCursor ===');
  const items = await fetchBase44Entity('SyncCursor');
  console.log(`[migrate-small] Fetched ${items.length} sync cursors`);

  for (const item of items) {
    try {
      const summary = item.last_sync_summary ? JSON.stringify(item.last_sync_summary) : null;
      await query(`
        INSERT INTO sync_cursors (
          integration, last_successful_sync_at, last_cursor, last_record_id,
          last_updated_timestamp, total_synced, last_sync_summary, is_full_sync_in_progress
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (integration) DO UPDATE SET
          last_successful_sync_at = COALESCE(EXCLUDED.last_successful_sync_at, sync_cursors.last_successful_sync_at),
          last_cursor = COALESCE(EXCLUDED.last_cursor, sync_cursors.last_cursor),
          last_record_id = COALESCE(EXCLUDED.last_record_id, sync_cursors.last_record_id),
          last_updated_timestamp = COALESCE(EXCLUDED.last_updated_timestamp, sync_cursors.last_updated_timestamp),
          total_synced = EXCLUDED.total_synced,
          last_sync_summary = COALESCE(EXCLUDED.last_sync_summary, sync_cursors.last_sync_summary),
          is_full_sync_in_progress = EXCLUDED.is_full_sync_in_progress,
          updated_at = NOW()
      `, [
        item.integration,
        item.last_successful_sync_at || null,
        item.last_cursor || null,
        item.last_record_id || null,
        item.last_updated_timestamp || null,
        item.total_synced || 0,
        summary,
        item.is_full_sync_in_progress === true,
      ]);
      console.log(`[migrate-small] SyncCursor '${item.integration}' upserted`);
    } catch (e) {
      console.error(`[migrate-small] SyncCursor error on ${item.integration}: ${e.message}`);
    }
  }
}

// ── LeadAttachment ──────────────────────────────────────────────────────────
async function migrateLeadAttachments() {
  console.log('\n[migrate-small] === LeadAttachment ===');
  const items = await fetchBase44Entity('LeadAttachment');
  console.log(`[migrate-small] Fetched ${items.length} lead attachments`);

  // Build lead ID cache
  const { rows: leadRows } = await query('SELECT id, external_ref FROM leads WHERE external_ref IS NOT NULL');
  const leadCache = {};
  for (const r of leadRows) leadCache[String(r.external_ref)] = r.id;

  let created = 0, errors = 0;
  for (const item of items) {
    try {
      const railwayLeadId = item.lead_id ? (leadCache[String(item.lead_id)] || null) : null;
      if (!railwayLeadId) { console.warn(`[migrate-small] Attachment ${item.id}: lead not found, skipping`); continue; }

      await query(`
        INSERT INTO lead_attachments (
          external_ref, lead_id, file_name, file_url, file_type, file_size,
          storage_key, uploaded_by, uploaded_at, qb_invoice_id, qb_invoice_number,
          invoice_amount, invoice_date, due_date, balance_due
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (external_ref) DO UPDATE SET
          file_name = COALESCE(EXCLUDED.file_name, lead_attachments.file_name),
          file_url = EXCLUDED.file_url,
          file_type = COALESCE(EXCLUDED.file_type, lead_attachments.file_type),
          file_size = COALESCE(EXCLUDED.file_size, lead_attachments.file_size),
          updated_at = NOW()
      `, [
        String(item.id),
        railwayLeadId,
        item.file_name || null,
        item.file_url,
        item.file_type || null,
        item.file_size || null,
        item.storage_key || null,
        item.uploaded_by || null,
        item.uploaded_at || null,
        item.qb_invoice_id || null,
        item.qb_invoice_number || null,
        item.invoice_amount || null,
        item.invoice_date || null,
        item.due_date || null,
        item.balance_due || null,
      ]);
      created++;
    } catch (e) {
      errors++;
      console.error(`[migrate-small] Attachment error on ${item.id}: ${e.message}`);
    }
  }
  console.log(`[migrate-small] LeadAttachments: ${created} upserted, ${errors} errors`);
}

// ── DealExpense ──────────────────────────────────────────────────────────────
async function migrateDealExpenses() {
  console.log('\n[migrate-small] === DealExpense ===');
  const items = await fetchBase44Entity('DealExpense');
  console.log(`[migrate-small] Fetched ${items.length} deal expenses`);

  // Build deal ID cache: legacy_base44_id → deals.id
  const { rows: dealRows } = await query('SELECT id, legacy_base44_id FROM deals WHERE legacy_base44_id IS NOT NULL');
  const dealCache = {};
  for (const r of dealRows) dealCache[String(r.legacy_base44_id)] = r.id;

  // Build lead ID cache
  const { rows: leadRows } = await query('SELECT id, external_ref FROM leads WHERE external_ref IS NOT NULL');
  const leadCache = {};
  for (const r of leadRows) leadCache[String(r.external_ref)] = r.id;

  let created = 0, errors = 0;
  for (const item of items) {
    try {
      const railwayDealId = item.deal_id ? (dealCache[String(item.deal_id)] || null) : null;
      const railwayLeadId = item.lead_id ? (leadCache[String(item.lead_id)] || null) : null;
      if (!railwayDealId) { console.warn(`[migrate-small] Expense ${item.id}: deal not found, skipping`); continue; }

      const num = (v) => (v !== null && v !== undefined && !isNaN(Number(v))) ? Number(v) : 0;
      await query(`
        INSERT INTO deal_expenses (
          external_ref, deal_id, lead_id, expense_date, vendor_name, vendor_id,
          category, subcategory, description, amount, payment_status, payment_method,
          check_or_reference_number, quickbooks_transaction_id, quickbooks_sync_status,
          receipt_url, receipt_key, receipt_filename, receipt_mime_type, notes,
          include_in_profit_calculation, amount_paid, amount_remaining, created_by, updated_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
        ON CONFLICT (external_ref) DO UPDATE SET
          vendor_name = EXCLUDED.vendor_name,
          amount = EXCLUDED.amount,
          payment_status = EXCLUDED.payment_status,
          updated_at = NOW()
      `, [
        String(item.id), railwayDealId, railwayLeadId,
        item.expense_date || null, item.vendor_name || 'Unknown', item.vendor_id || null,
        item.category || 'Other', item.subcategory || null, item.description || null,
        num(item.amount), item.payment_status || 'Unpaid', item.payment_method || null,
        item.check_or_reference_number || null, item.quickbooks_transaction_id || null,
        item.quickbooks_sync_status || 'not_synced',
        item.receipt_url || null, item.receipt_key || null, item.receipt_filename || null,
        item.receipt_mime_type || null, item.notes || null,
        item.include_in_profit_calculation !== false, num(item.amount_paid), num(item.amount_remaining),
        item.created_by || null, item.updated_by || null,
      ]);
      created++;
    } catch (e) {
      errors++;
      console.error(`[migrate-small] DealExpense error on ${item.id}: ${e.message}`);
    }
  }
  console.log(`[migrate-small] DealExpenses: ${created} upserted, ${errors} errors`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[migrate-small] Starting small dataset migration...');

  // Order: no-dependency datasets first, then FK-dependent
  await migrateUserAllowlist();
  await migrateCompanySettings();
  await migrateSyncCursors();
  await migrateLeadAttachments();
  await migrateDealExpenses();

  console.log('\n=== SMALL DATASET MIGRATION COMPLETE ===');
  process.exit(0);
}

main().catch(e => { console.error('[migrate-small] fatal:', e); process.exit(1); });