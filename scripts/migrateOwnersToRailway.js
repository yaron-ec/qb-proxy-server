/* eslint-disable no-undef */
'use strict';
/**
 * migrateOwnersToRailway.js — Ensure every Base44 assigned_rep has a Railway owner.
 *
 * PREREQUISITE: None. Must run BEFORE migrateLeadsToRailway.js (leads.owner_id
 * is NOT NULL FK to owners).
 *
 * Reads all Base44 leads to collect distinct assigned_rep values, and reads
 * Base44 users for email mapping. Creates owner records for any assigned_rep
 * that doesn't already exist in the Railway owners table.
 *
 * IDEMPOTENT: ON CONFLICT DO NOTHING. Safe to re-run.
 */
const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-owners] Starting owner reconciliation...');
  if (!hasBase44Creds()) { console.error('[migrate-owners] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  // 1. Load existing owners
  const { rows: existingOwners } = await query('SELECT id, display_name, email FROM owners');
  const existingByName = new Set();
  const existingByEmail = new Set();
  for (const o of existingOwners) {
    if (o.display_name) existingByName.add(o.display_name.toLowerCase().replace(/\s+/g, ' ').trim());
    if (o.email) existingByEmail.add(o.email.toLowerCase());
  }
  console.log(`[migrate-owners] Found ${existingOwners.length} existing owners`);

  // 2. Read Base44 users for email mapping
  const base44Users = await fetchBase44Entity('User');
  const userEmailMap = {};
  for (const u of base44Users) {
    if (u.full_name) {
      const nameKey = u.full_name.toLowerCase().replace(/\s+/g, ' ').trim();
      if (u.email) userEmailMap[nameKey] = u.email;
    }
  }
  console.log(`[migrate-owners] Loaded ${base44Users.length} Base44 users for email mapping`);

  // 3. Read all Base44 leads to collect distinct assigned_rep values
  const base44Leads = await fetchBase44Entity('Lead');
  const assignedReps = new Set();
  for (const lead of base44Leads) {
    if (lead.assigned_rep) assignedReps.add(lead.assigned_rep);
  }
  console.log(`[migrate-owners] Found ${assignedReps.size} distinct assigned_rep values in ${base44Leads.length} leads`);

  // 4. Create missing owners
  let created = 0, skipped = 0, noName = 0;
  for (const rep of assignedReps) {
    const nameKey = String(rep).toLowerCase().replace(/\s+/g, ' ').trim();
    if (!nameKey) { noName++; continue; }
    if (existingByName.has(nameKey)) { skipped++; continue; }

    const email = userEmailMap[nameKey] || null;
    if (email && existingByEmail.has(email.toLowerCase())) { skipped++; continue; }

    await query(`
      INSERT INTO owners (display_name, email, is_active)
      VALUES ($1, $2, true)
      ON CONFLICT DO NOTHING
    `, [String(rep).trim(), email]);
    created++;
    existingByName.add(nameKey);
    if (email) existingByEmail.add(email.toLowerCase());
  }

  console.log(`[migrate-owners] Created ${created} new owners, skipped ${skipped} existing, ${noName} had no name`);

  // 5. Also create owners for Base44 users that aren't assigned_reps but have roles
  for (const u of base44Users) {
    if (!u.full_name) continue;
    const nameKey = u.full_name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (existingByName.has(nameKey)) continue;
    if (u.email && existingByEmail.has(u.email.toLowerCase())) continue;

    await query(`
      INSERT INTO owners (display_name, email, is_active)
      VALUES ($1, $2, true)
      ON CONFLICT DO NOTHING
    `, [u.full_name.trim(), u.email || null]);
    created++;
    existingByName.add(nameKey);
    if (u.email) existingByEmail.add(u.email.toLowerCase());
  }

  const { rows } = await query('SELECT COUNT(*) as cnt FROM owners WHERE is_active = true');
  console.log(`[migrate-owners] Active owners now: ${rows[0].cnt}`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-owners] fatal:', e); process.exit(1); });