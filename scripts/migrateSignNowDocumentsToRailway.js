/* eslint-disable no-undef */
'use strict';
/**
 * migrateSignNowDocumentsToRailway.js — Idempotent SignNow document migration.
 *
 * PREREQUISITE: migrateLeadsToRailway.js (signnow_documents.lead_id FK → leads).
 *
 * The Railway signnow_documents table has no external_ref column by default.
 * This script adds it (ALTER TABLE ADD COLUMN IF NOT EXISTS) and uses it for
 * idempotent ON CONFLICT upserts.
 *
 * Maps: Base44 SignNowDocument.signnow_document_id → Railway document_id
 *       Base44 signer_email + signer_name → Railway signers JSONB array
 */
const { query } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-signnow] Starting SignNow document migration...');
  if (!hasBase44Creds()) { console.error('[migrate-signnow] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  // Ensure external_ref column exists
  await query('ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS external_ref TEXT');
  await query('CREATE UNIQUE INDEX IF NOT EXISTS signnow_documents_external_ref_idx ON signnow_documents (external_ref) WHERE external_ref IS NOT NULL');
  console.log('[migrate-signnow] external_ref column ensured');

  const leadIdCache = await buildLeadIdCache();
  console.log(`[migrate-signnow] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Items = await fetchBase44Entity('SignNowDocument');
  console.log(`[migrate-signnow] Fetched ${base44Items.length} SignNow documents from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, leadNotFound = 0;
  for (const item of base44Items) {
    try {
      const externalRef = item.id;
      if (!externalRef) { skipped++; continue; }
      const railwayLeadId = item.lead_id ? (leadIdCache[String(item.lead_id)] || null) : null;
      if (item.lead_id && !railwayLeadId) leadNotFound++;
      if (!railwayLeadId) { skipped++; continue; }

      // Build signers JSONB from Base44 fields
      const signers = [];
      if (item.signer_email || item.signer_name) {
        signers.push({ email: item.signer_email || null, name: item.signer_name || null, role: 'signer', status: item.status || 'pending' });
      }
      const signersJson = JSON.stringify(signers);

      // Map Base44 status to Railway status
      const statusMap = { draft: 'pending', sent: 'sent', viewed: 'viewed', signed: 'signed', declined: 'voided', completed: 'completed', error: 'error' };
      const railwayStatus = statusMap[item.status] || 'pending';

      const { rows } = await query(`
        INSERT INTO signnow_documents (
          external_ref, lead_id, document_id, document_name, template_id, status,
          signers, signing_url, pdf_url, created_by, error_message, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (external_ref) DO UPDATE SET
          lead_id = EXCLUDED.lead_id,
          document_id = COALESCE(EXCLUDED.document_id, signnow_documents.document_id),
          document_name = COALESCE(EXCLUDED.document_name, signnow_documents.document_name),
          status = EXCLUDED.status,
          signers = EXCLUDED.signers,
          signing_url = COALESCE(EXCLUDED.signing_url, signnow_documents.signing_url),
          pdf_url = COALESCE(EXCLUDED.pdf_url, signnow_documents.pdf_url),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef), railwayLeadId,
        item.signnow_document_id || null, item.document_name || 'Untitled Document',
        null, // template_id - Base44 doesn't store this
        railwayStatus, signersJson,
        item.signnow_document_url || null, item.signed_pdf_url || null,
        null, // created_by
        null, // error_message
        item.sent_at || item.created_date || new Date().toISOString(),
      ]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-signnow] Error on ${item.id}: ${e.message}`);
    }
  }

  console.log(`\n=== SIGNNOW DOCUMENT MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Items.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Unresolvable lead_id: ${leadNotFound}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM signnow_documents');
  console.log(`Railway signnow_documents table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-signnow] fatal:', e); process.exit(1); });