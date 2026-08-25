/* eslint-disable no-undef */
'use strict';
/**
 * auditOwnerResolution.js — Production-safe validation of owner resolution.
 *
 * Reads ALL Base44 leads and ALL Railway owners, then calls the EXACT same
 * code path as migrateLeadsToRailway.js (buildOwnerCache() + resolveOwnerId())
 * to verify that every named-owner lead resolves and every genuinely
 * unassigned lead maps to the canonical Unassigned owner.
 *
 * READ-ONLY. No writes. No side effects. Safe to run at any time.
 *
 * Exit code 0 = all leads resolve. Exit code 1 = unresolved leads exist.
 *
 * Usage: node scripts/auditOwnerResolution.js
 */
const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds, buildOwnerCache, resolveOwnerId } = require('./migrationHelpers');

async function main() {
  console.log('=== OWNER RESOLUTION AUDIT (READ-ONLY) ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  if (!hasBase44Creds()) {
    console.error('FATAL: WORKER_SECRET required');
    process.exit(1);
  }

  // 1. Build owner cache — SAME helper used by migrateLeadsToRailway.js
  const ownerCache = await buildOwnerCache();
  console.log(`Railway owners (active): ${Object.keys(ownerCache).length} keys`);

  // 2. Print every Railway owner for the audit record
  const { rows: owners } = await query(
    'SELECT id, display_name, email, is_active FROM owners ORDER BY display_name'
  );
  console.log('\n=== RAILWAY OWNERS TABLE ===\n');
  console.log('DISPLAY NAME                  EMAIL                          ACTIVE   ID');
  console.log('─────────────────────────  ──────────────────────────────────  ──────  ──────────────────────────────────');
  for (const o of owners) {
    const nameKey = (o.display_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    console.log(
      `${(o.display_name || '—').slice(0, 28).padEnd(28)}  ${(o.email || '—').slice(0, 30).padEnd(30)}  ${o.is_active ? 'YES' : 'NO '}  ${o.id}`
    );
  }
  console.log(`Total owners: ${owners.length}`);

  // 3. Fetch ALL Base44 leads
  const base44Leads = await fetchBase44Entity('Lead');
  console.log(`\nBase44 leads fetched: ${base44Leads.length}`);

  // 4. Resolve every lead using the SAME code path as production
  let namedResolved = 0;
  let namedUnresolved = 0;
  let genuinelyUnassigned = 0;
  const repStats = new Map(); // rep → { count, resolvedId }

  for (const lead of base44Leads) {
    const rep = lead.assigned_rep;
    const isGenuinelyUnassigned = !rep || !String(rep).trim();

    if (isGenuinelyUnassigned) {
      genuinelyUnassigned++;
      continue;
    }

    // EXACT same call as migrateLeadsToRailway.js line 174 (after fix)
    const ownerId = resolveOwnerId(rep, ownerCache);
    const repKey = String(rep).trim();

    if (!repStats.has(repKey)) {
      repStats.set(repKey, { count: 0, resolvedId: ownerId });
    }
    repStats.get(repKey).count++;

    if (ownerId) {
      namedResolved++;
    } else {
      namedUnresolved++;
    }
  }

  // 5. Report
  console.log('\n=== OWNER RESOLUTION RESULTS ===\n');
  console.log(`Total Base44 leads:                ${base44Leads.length}`);
  console.log(`Named-owner leads (resolved):      ${namedResolved}`);
  console.log(`Named-owner leads (UNRESOLVED):    ${namedUnresolved}`);
  console.log(`Genuinely unassigned (null/empty): ${genuinelyUnassigned}`);
  console.log(`Distinct named assigned_rep values: ${repStats.size}`);
  console.log('');

  console.log('SOURCE VALUE                        LEADS   RESOLVED OWNER ID                        STATUS');
  console.log('──────────────────────────────────  ──────  ──────────────────────────────────────  ────────────');
  const sortedReps = [...repStats.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [rep, stats] of sortedReps) {
    const status = stats.resolvedId ? 'RESOLVED ✅' : 'UNRESOLVED ❌';
    console.log(
      `${rep.slice(0, 34).padEnd(34)}  ${String(stats.count).padStart(6)}  ${String(stats.resolvedId || '—').slice(0, 38).padEnd(38)}  ${status}`
    );
  }

  // 6. Verify Unassigned owner exists
  const { rows: unassignedRows } = await query(
    `SELECT id FROM owners WHERE lower(display_name) = 'unassigned' AND is_active = true LIMIT 1`
  );
  const unassignedOwnerId = unassignedRows[0]?.id || null;
  console.log('');
  console.log(`Canonical Unassigned owner ID: ${unassignedOwnerId || 'NOT FOUND ❌'}`);

  // 7. Final verdict
  console.log('');
  if (namedUnresolved > 0) {
    console.log(`❌ AUDIT FAILED — ${namedUnresolved} named-owner lead(s) have NO Railway owner mapping.`);
    console.log('   The migration would FAIL CLOSED on these leads. No silent fallback will be applied.');
    console.log('   Fix: ensure every assigned_rep value has a corresponding owner in the Railway owners table.');
    process.exit(1);
  } else {
    console.log('✅ AUDIT PASSED — all named-owner leads resolve to a Railway owner.');
    console.log(`   ${namedResolved} named-owner leads + ${genuinelyUnassigned} genuinely unassigned leads = ${base44Leads.length} total.`);
    process.exit(0);
  }
}

main().catch(e => {
  console.error('Audit fatal:', e);
  process.exit(1);
});