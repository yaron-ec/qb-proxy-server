/* eslint-disable no-undef */
'use strict';
/**
 * migrateSignNowDocumentsToRailway.js — Idempotent SignNow document migration.
 *
 * PREREQUISITE: migrateLeadsToRailway.js (signnow_documents.lead_id FK → leads).
 * PREREQUISITE: migration 2026-24 (adds external_ref, signnow_invite_id, sent_at,
 *               signed_at, last_status_check, uploaded_file_url columns).
 *
 * IMPORT-SAFE: Exports runSignNowDocumentMigration(queryFn) for use by rollback
 * validators. main() is guarded by require.main === module.
 *
 * Idempotent: ON CONFLICT (external_ref) DO UPDATE.
 *
 * Field mapping (Base44 → Railway):
 *   id                     → external_ref
 *   lead_id                → lead_id (via leadIdCache, Base44 ID → Railway UUID)
 *   signnow_document_id    → document_id
 *   document_name          → document_name
 *   status                 → status (draft→pending, sent→sent, viewed→viewed,
 *                                    signed→signed, declined→voided)
 *   signer_email           → signers[0].email (JSONB)
 *   signer_name            → signers[0].name  (JSONB)
 *   signnow_document_url   → signing_url
 *   signed_pdf_url         → pdf_url
 *   signnow_invite_id      → signnow_invite_id
 *   sent_at                → sent_at (NOT created_at — fixed semantic mismatch)
 *   signed_at              → signed_at
 *   last_status_check      → last_status_check
 *   uploaded_file_url      → uploaded_file_url
 *   created_date           → created_at
 *
 * Orphan handling: records with unresolvable lead_id (test/fake IDs) are SKIPPED
 * (lead_id is NOT NULL FK → leads). leadNotFound is reported.
 */
const { query: defaultQuery } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, hasBase44Creds } = require('./migrationHelpers');

const STATUS_MAP = {
  draft: 'pending',
  sent: 'sent',
  viewed: 'viewed',
  signed: 'signed',
  declined: 'voided',
  completed: 'completed',
  error: 'error',
};

/**
 * Run the SignNow document migration.
 * @param {Function} queryFn - optional query function (defaults to direct query).
 *        Pass a transaction-bound queryFn for rollback validation.
 * @returns {Promise<{total, created, updated, skipped, errors, leadNotFound, finalCount}>}
 */
async function runSignNowDocumentMigration(queryFn) {
  const query = queryFn || defaultQuery;
  console.log('[migrate-signnow] Starting SignNow document migration...');
  if (!hasBase44Creds()) {
    throw new Error('[migrate-signnow] WORKER_SECRET required for migration reader');
  }

  // Ensure all columns exist (idempotent safety net — migration 2026-24 also does this)
  await query('ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS external_ref TEXT');
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS signnow_documents_external_ref_idx
    ON signnow_documents (external_ref) WHERE external_ref IS NOT NULL`);
  await query('ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS signnow_invite_id TEXT');
  await query('ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ');
  await query('ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ');
  await query('ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS last_status_check TIMESTAMPTZ');
  await query('ALTER TABLE signnow_documents ADD COLUMN IF NOT EXISTS uploaded_file_url TEXT');
  console.log('[migrate-signnow] Columns ensured');

  const leadIdCache = await buildLeadIdCache(query);
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
      const railwayStatus = STATUS_MAP[item.status] || 'pending';
      const signers = [];
      if (item.signer_email || item.signer_name) {
        signers.push({
          email: item.signer_email || null,
          name: item.signer_name || null,
          role: 'signer',
          status: railwayStatus,
        });
      }
      const signersJson = JSON.stringify(signers);

      const { rows } = await query(`
        INSERT INTO signnow_documents (
          external_ref, lead_id, document_id, document_name, template_id, status,
          signers, signing_url, pdf_url, created_by, error_message,
          signnow_invite_id, sent_at, signed_at, last_status_check, uploaded_file_url,
          created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (external_ref) DO UPDATE SET
          lead_id = EXCLUDED.lead_id,
          document_id = COALESCE(EXCLUDED.document_id, signnow_documents.document_id),
          document_name = COALESCE(EXCLUDED.document_name, signnow_documents.document_name),
          status = EXCLUDED.status,
          signers = EXCLUDED.signers,
          signing_url = COALESCE(EXCLUDED.signing_url, signnow_documents.signing_url),
          pdf_url = COALESCE(EXCLUDED.pdf_url, signnow_documents.pdf_url),
          signnow_invite_id = COALESCE(EXCLUDED.signnow_invite_id, signnow_documents.signnow_invite_id),
          sent_at = COALESCE(EXCLUDED.sent_at, signnow_documents.sent_at),
          signed_at = COALESCE(EXCLUDED.signed_at, signnow_documents.signed_at),
          last_status_check = COALESCE(EXCLUDED.last_status_check, signnow_documents.last_status_check),
          uploaded_file_url = COALESCE(EXCLUDED.uploaded_file_url, signnow_documents.uploaded_file_url),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef), railwayLeadId,
        item.signnow_document_id || null,
        item.document_name || 'Untitled Document',
        null, // template_id — Base44 doesn't store this
        railwayStatus, signersJson,
        item.signnow_document_url || null,
        item.signed_pdf_url || null,
        null, // created_by — Base44 doesn't store this
        null, // error_message
        item.signnow_invite_id || null,
        item.sent_at || null,
        item.signed_at || null,
        item.last_status_check || null,
        item.uploaded_file_url || null,
        item.created_date || new Date().toISOString(),
      ]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-signnow] Error on ${item.id}: ${e.message}`);
    }
  }

  let finalCount = null;
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM signnow_documents');
    finalCount = parseInt(rows[0].cnt, 10);
  } catch (e) {
    console.error('[migrate-signnow] Could not get final count:', e.message);
  }

  const result = {
    total: base44Items.length, created, updated, skipped, errors, leadNotFound, finalCount,
  };
  console.log(`\n=== SIGNNOW DOCUMENT MIGRATION COMPLETE ===`);
  console.log(`Total: ${result.total}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Unresolvable lead_id: ${leadNotFound}`);
  if (finalCount !== null) console.log(`Railway signnow_documents table now has: ${finalCount} rows`);
  return result;
}

module.exports = { runSignNowDocumentMigration };

if (require.main === module) {
  runSignNowDocumentMigration()
    .then(() => process.exit(0))
    .catch(e => { console.error('[migrate-signnow] fatal:', e); process.exit(1); });
}