/* eslint-disable no-undef */
'use strict';
/**
 * migrateContactsToRailway.js — Idempotent contact migration from Base44 to Railway.
 *
 * No FK prerequisites. Contacts are standalone records (non-lead contacts).
 */
const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-contacts] Starting contact migration...');
  if (!hasBase44Creds()) { console.error('[migrate-contacts] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const base44Items = await fetchBase44Entity('Contact');
  console.log(`[migrate-contacts] Fetched ${base44Items.length} contacts from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0;
  for (const item of base44Items) {
    try {
      const externalRef = item.id;
      if (!externalRef) { skipped++; continue; }

      const { rows } = await query(`
        INSERT INTO contacts (external_ref, first_name, last_name, email, phone, company, record_type, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (external_ref) DO UPDATE SET
          first_name = COALESCE(EXCLUDED.first_name, contacts.first_name),
          last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
          email = COALESCE(EXCLUDED.email, contacts.email),
          phone = COALESCE(EXCLUDED.phone, contacts.phone),
          notes = COALESCE(EXCLUDED.notes, contacts.notes),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        String(externalRef),
        item.first_name || null, item.last_name || null,
        item.email || null, item.phone || null,
        null, // company - Base44 Contact doesn't have a company field
        'Contact', // record_type
        item.notes || null,
      ]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-contacts] Error on ${item.id}: ${e.message}`);
    }
  }

  console.log(`\n=== CONTACT MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Items.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM contacts');
  console.log(`Railway contacts table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-contacts] fatal:', e); process.exit(1); });