/* eslint-disable no-undef */
'use strict';
/**
 * migrateUsersToRailway.js — Migrate Base44 users to Railway users table.
 *
 * Reads all Base44 User records and upserts them into the Railway users table.
 * Preserves email, full_name, and role. Sets status='active'.
 * password_hash and google_sub are left NULL (users re-auth via Google SSO
 * or password reset after migration).
 *
 * IDEMPOTENT: ON CONFLICT (lower(email)) DO UPDATE. Safe to re-run.
 */
const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

async function main() {
  console.log('[migrate-users] Starting user migration...');
  if (!hasBase44Creds()) { console.error('[migrate-users] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const base44Users = await fetchBase44Entity('User');
  console.log(`[migrate-users] Fetched ${base44Users.length} users from Base44`);

  let created = 0, updated = 0, errors = 0;
  for (const u of base44Users) {
    if (!u.email) { errors++; continue; }
    try {
      const role = ['admin', 'manager', 'sales_rep', 'office', 'user'].includes(u.role) ? u.role : 'user';
      const { rows } = await query(`
        INSERT INTO users (email, full_name, role, status)
        VALUES ($1, $2, $3, 'active')
        ON CONFLICT (lower(email)) DO UPDATE SET
          full_name = COALESCE(EXCLUDED.full_name, users.full_name),
          role = EXCLUDED.role,
          status = CASE WHEN users.status = 'disabled' THEN users.status ELSE 'active' END,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [u.email.toLowerCase(), u.full_name || null, role]);
      if (rows[0]?.inserted) created++; else updated++;
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`[migrate-users] Error on ${u.email}: ${e.message}`);
    }
  }

  console.log(`\n=== USER MIGRATION COMPLETE ===`);
  console.log(`Total: ${base44Users.length}, Created: ${created}, Updated: ${updated}, Errors: ${errors}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM users');
  console.log(`Railway users table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-users] fatal:', e); process.exit(1); });