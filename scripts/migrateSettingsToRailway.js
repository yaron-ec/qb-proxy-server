/* eslint-disable no-undef */
'use strict';
/**
 * migrateSettingsToRailway.js — Idempotent settings migration.
 *
 * Reads Base44 Settings (key/value/type rows) and groups them into the
 * Railway settings.app_lists JSONB singleton (id=1).
 *
 * Also reads Base44 CompanySettings and merges company info into the
 * settings singleton (company_name, company_email, etc.) as a fallback
 * to the company_settings table.
 *
 * No FK prerequisites.
 */
const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-settings] Starting settings migration...');
  if (!hasBase44Creds()) { console.error('[migrate-settings] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  // 1. Read Base44 Settings (list configurations)
  const base44Settings = await fetchBase44Entity('Settings');
  console.log(`[migrate-settings] Fetched ${base44Settings.length} settings records from Base44`);

  const appLists = {};
  for (const s of base44Settings) {
    if (!s.type) continue;
    if (!appLists[s.type]) appLists[s.type] = {};
    if (s.key) appLists[s.type][s.key] = s.value || {};
  }

  // 2. Read Base44 CompanySettings for company info
  const base44Company = await fetchBase44Entity('CompanySettings');
  const company = base44Company[0] || {};

  // 3. Upsert into settings singleton (id=1)
  await query(`
    INSERT INTO settings (
      id, company_name, company_email, company_phone, company_address,
      company_city, company_state, company_zip, company_website,
      admin_name, admin_email, app_lists
    ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (id) DO UPDATE SET
      company_name = COALESCE(EXCLUDED.company_name, settings.company_name),
      company_email = COALESCE(EXCLUDED.company_email, settings.company_email),
      company_phone = COALESCE(EXCLUDED.company_phone, settings.company_phone),
      company_address = COALESCE(EXCLUDED.company_address, settings.company_address),
      company_city = COALESCE(EXCLUDED.company_city, settings.company_city),
      company_state = COALESCE(EXCLUDED.company_state, settings.company_state),
      company_zip = COALESCE(EXCLUDED.company_zip, settings.company_zip),
      company_website = COALESCE(EXCLUDED.company_website, settings.company_website),
      admin_name = COALESCE(EXCLUDED.admin_name, settings.admin_name),
      admin_email = COALESCE(EXCLUDED.admin_email, settings.admin_email),
      app_lists = CASE WHEN $11::jsonb != '{}'::jsonb THEN $11::jsonb ELSE settings.app_lists END,
      updated_at = NOW()
  `, [
    company.company_name || 'EC Construction Group',
    company.company_email || null, company.company_phone || null,
    company.company_address || null, company.company_city || null,
    company.company_state || null, company.company_zip || null,
    company.company_website || null, company.admin_name || null,
    company.admin_email || null,
    JSON.stringify(appLists),
  ]);

  console.log(`[migrate-settings] Settings singleton upserted with ${Object.keys(appLists).length} app_list categories`);
  console.log(`[migrate-settings] Company info: ${company.company_name || 'EC Construction Group'}`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-settings] fatal:', e); process.exit(1); });