/* eslint-disable no-undef */
/**
 * migratePropertiesToRailway.js — Idempotent property migration from Base44 to Railway.
 *
 * PREREQUISITE: Run migrateLeadsToRailway.js FIRST. Migration 2026-14 must be applied
 * (creates the `properties` table).
 *
 * Run on Railway: node scripts/migratePropertiesToRailway.js
 *
 * Reads ALL properties from Base44 (via REST API) and upserts them into the
 * Railway `properties` table with external_ref = Base44 property ID.
 *
 * Maps Base44 Property.lead_id (Base44 ObjectId) → Railway leads.id (via external_ref).
 *
 * IDEMPOTENT: YES. SAFE TO RE-RUN: YES.
 */
'use strict';

const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildLeadIdCache } = require('./migrationHelpers');

if (!hasBase44Creds()) {
  console.error('[migrate-properties] BASE44_APP_ID and BASE44_API_KEY required');
  process.exit(1);
}

async function upsertProperty(prop, railwayLeadId) {
  const externalRef = prop.id;
  if (!externalRef) return { action: 'skipped', reason: 'no_id' };

  const sql = `
    INSERT INTO properties (
      external_ref, lead_id, address, city, state, zip, property_type,
      square_footage, lot_size, year_built, bedrooms, bathrooms, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (external_ref) DO UPDATE SET
      lead_id = COALESCE(EXCLUDED.lead_id, properties.lead_id),
      address = COALESCE(EXCLUDED.address, properties.address),
      city = COALESCE(EXCLUDED.city, properties.city),
      state = COALESCE(EXCLUDED.state, properties.state),
      zip = COALESCE(EXCLUDED.zip, properties.zip),
      property_type = COALESCE(EXCLUDED.property_type, properties.property_type),
      square_footage = COALESCE(EXCLUDED.square_footage, properties.square_footage),
      lot_size = COALESCE(EXCLUDED.lot_size, properties.lot_size),
      year_built = COALESCE(EXCLUDED.year_built, properties.year_built),
      bedrooms = COALESCE(EXCLUDED.bedrooms, properties.bedrooms),
      bathrooms = COALESCE(EXCLUDED.bathrooms, properties.bathrooms),
      notes = COALESCE(EXCLUDED.notes, properties.notes),
      updated_at = NOW()
    RETURNING (xmax = 0) AS inserted, id
  `;

  const num = (v) => (v !== null && v !== undefined && !isNaN(Number(v))) ? Number(v) : null;

  const params = [
    String(externalRef),
    railwayLeadId || null,
    prop.address || null,
    prop.city || null,
    prop.state || null,
    prop.zip || null,
    prop.property_type || null,
    num(prop.square_footage),
    prop.lot_size || null,
    num(prop.year_built),
    num(prop.bedrooms),
    num(prop.bathrooms),
    prop.notes || null,
  ];

  const { rows } = await query(sql, params);
  return { action: rows[0]?.inserted ? 'created' : 'updated', id: rows[0]?.id };
}

async function main() {
  console.log('[migrate-properties] Starting idempotent property migration...');
  const leadIdCache = await buildLeadIdCache();
  console.log(`[migrate-properties] Loaded ${Object.keys(leadIdCache).length} lead ID mappings`);

  const base44Properties = await fetchBase44Entity('Property');
  console.log(`[migrate-properties] Fetched ${base44Properties.length} properties from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0;
  for (let i = 0; i < base44Properties.length; i++) {
    const prop = base44Properties[i];
    try {
      const railwayLeadId = prop.lead_id ? (leadIdCache[String(prop.lead_id)] || null) : null;
      const result = await upsertProperty(prop, railwayLeadId);
      if (result.action === 'created') created++;
      else if (result.action === 'updated') updated++;
      else skipped++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-properties] Error on ${prop.id}: ${e.message}`);
    }
  }

  console.log('\n=== PROPERTY MIGRATION COMPLETE ===');
  console.log(`Total: ${base44Properties.length}, Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM properties');
  console.log(`Railway properties table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-properties] fatal:', e); process.exit(1); });