/* eslint-disable no-undef */
'use strict';
/**
 * mergeShlomiIntoSimon.js — Identity merge: Shlomi Ashkenazi → Simon Ashkenazi.
 *
 * Re-points EVERY Railway reference to the duplicate Shlomi identity over to
 * the canonical Simon identity, preserving all business history. Then deletes
 * the Shlomi UserAllowlist row in Base44 (via identityMergeWriter).
 *
 * CANONICAL:  Simon Ashkenazi  | UA id 6a3d634c1e40faa5a663c33f | User id 6a4af06a78e6d77be96d0a1a | office@tsvisionbuilders.com
 * DUPLICATE:  Shlomi Ashkenazi | UA id 6a4aef73f211c8ca4d59eb7a | (no User account)
 *
 * RAILWAY RE-POINT SCOPE (runShlomiMerge — transaction-safe, functional export):
 *   1. owners:            if a Shlomi owner exists → re-point leads.owner_id +
 *                        appointments.owner_id to Simon owner, then DELETE Shlomi owner.
 *                        (Detects appointment overlap collisions — fails closed.)
 *   2. deals.assigned_rep:                 'Shlomi Ashkenazi' → 'Simon Ashkenazi'
 *   3. tasks.assigned_to:                  'Shlomi Ashkenazi' → 'Simon Ashkenazi'
 *   4. deal_commissions.recipient_name:    'Shlomi Ashkenazi' → 'Simon Ashkenazi'
 *
 * PRESERVED (historical display/audit text — NOT re-pointed):
 *   - lead_submissions.assigned_rep_at_time  (records rep at time of submission)
 *   - appointment_events.actor               (immutable audit trail)
 *   - activities.content, notes, message, description bodies (free text)
 *
 * BASE44 SIDE (CLI main only — NOT inside the Railway transaction):
 *   - UserAllowlist: delete the Shlomi row (6a4aef73...). Simon's row remains.
 *
 * ARCHITECTURE: runShlomiMerge(queryFn) accepts a queryFn so the rollback
 * validator runs the EXACT production code path inside BEGIN/ROLLBACK. The
 * CLI main() invokes it with the default pool query, then performs the Base44
 * UserAllowlist delete (which cannot be transaction-wrapped with Railway).
 *
 * Environment: DATABASE_URL, WORKER_SECRET (for identityMergeWriter)
 */
const { query } = require('../db/client');
const { SHLOMI_NAME, SIMON_NAME, SHLOMI_UA_ID, SIMON_UA_ID, SHARED_EMAIL } = require('./auditShlomiIdentity');

const IDENTITY_MERGE_WRITER_URL = process.env.BASE44_FUNCTIONS_URL ||
  'https://crm-ec-construction-group.base44.app/functions/identityMergeWriter';

// ── Railway-side merge (transaction-safe) ────────────────────────────────────
async function runShlomiMerge(queryFn = query) {
  const report = {
    owners: { shlomiOwnerFound: false, shlomiOwnerId: null, simonOwnerId: null, leadsRepointed: 0, appointmentsRepointed: 0, ownerDeleted: false, overlapCollision: null },
    deals: { repointed: 0 },
    tasks: { repointed: 0 },
    dealCommissions: { repointed: 0 },
    preserved: { leadSubmissions: 0, appointmentEvents: 0, freeTextBodies: 0 },
  };

  // ── 1. Resolve Simon owner ──────────────────────────────────────────────────
  const { rows: simonOwners } = await queryFn(
    `SELECT id FROM owners WHERE lower(display_name) = lower($1) OR email = $2 ORDER BY created_at LIMIT 1`,
    [SIMON_NAME, SHARED_EMAIL]
  );
  if (simonOwners.length === 0) {
    throw new Error(`Simon owner not found in Railway owners table (name="${SIMON_NAME}" or email="${SHARED_EMAIL}"). Cannot merge — Simon must exist first.`);
  }
  report.owners.simonOwnerId = simonOwners[0].id;

  // ── 2. Find Shlomi owner ─────────────────────────────────────────────────────
  const { rows: shlomiOwners } = await queryFn(
    `SELECT id, display_name, email FROM owners WHERE lower(display_name) LIKE '%shlomi%' AND id <> $1`,
    [report.owners.simonOwnerId]
  );

  if (shlomiOwners.length > 0) {
    if (shlomiOwners.length > 1) {
      throw new Error(`Multiple Shlomi owners found: ${JSON.stringify(shlomiOwners.map(o => ({ id: o.id, name: o.display_name })))}. Ambiguous — operator must resolve.`);
    }
    const shlomiOwnerId = shlomiOwners[0].id;
    report.owners.shlomiOwnerFound = true;
    report.owners.shlomiOwnerId = shlomiOwnerId;

    // ── 2a. Detect appointment overlap collision (EXCLUDE constraint) ─────────
    // appointments has EXCLUDE USING gist (owner_id WITH =, busy_range WITH &&) WHERE status IN ('scheduled','confirmed').
    // Re-pointing Shlomi appointments to Simon will FAIL if Simon already has an overlapping active appointment.
    const { rows: overlaps } = await queryFn(`
      SELECT s.id AS shlomi_appt_id, s.start_at, s.end_at, s.status,
             m.id AS simon_appt_id
      FROM appointments s
      JOIN appointments m ON m.owner_id = $1 AND m.status IN ('scheduled','confirmed')
                        AND s.busy_range && m.busy_range
      WHERE s.owner_id = $2 AND s.status IN ('scheduled','confirmed')`,
      [report.owners.simonOwnerId, shlomiOwnerId]
    );
    if (overlaps.length > 0) {
      report.owners.overlapCollision = overlaps;
      throw new Error(`Appointment overlap collision: ${overlaps.length} Shlomi appointment(s) overlap Simon's active appointments. Re-pointing would violate the EXCLUDE constraint. Operator must resolve manually: ${JSON.stringify(overlaps.map(o => ({ shlomi: o.shlomi_appt_id, simon: o.simon_appt_id, start: o.start_at })))}`);
    }

    // ── 2b. Re-point leads.owner_id ────────────────────────────────────────────
    const { rowCount: leadsRepointed } = await queryFn(
      `UPDATE leads SET owner_id = $1, updated_at = NOW() WHERE owner_id = $2`,
      [report.owners.simonOwnerId, shlomiOwnerId]
    );
    report.owners.leadsRepointed = leadsRepointed || 0;

    // ── 2c. Re-point appointments.owner_id ─────────────────────────────────────
    const { rowCount: apptsRepointed } = await queryFn(
      `UPDATE appointments SET owner_id = $1, updated_at = NOW() WHERE owner_id = $2`,
      [report.owners.simonOwnerId, shlomiOwnerId]
    );
    report.owners.appointmentsRepointed = apptsRepointed || 0;

    // ── 2d. Delete the Shlomi owner ────────────────────────────────────────────
    await queryFn(`DELETE FROM owners WHERE id = $1`, [shlomiOwnerId]);
    report.owners.ownerDeleted = true;
  }

  // ── 3. Re-point deals.assigned_rep (TEXT) ───────────────────────────────────
  const { rowCount: dealsRepointed } = await queryFn(
    `UPDATE deals SET assigned_rep = $1, updated_at = NOW() WHERE assigned_rep = $2`,
    [SIMON_NAME, SHLOMI_NAME]
  );
  report.deals.repointed = dealsRepointed || 0;

  // ── 4. Re-point tasks.assigned_to (TEXT) ────────────────────────────────────
  const { rowCount: tasksRepointed } = await queryFn(
    `UPDATE tasks SET assigned_to = $1 WHERE assigned_to = $2`,
    [SIMON_NAME, SHLOMI_NAME]
  );
  report.tasks.repointed = tasksRepointed || 0;

  // ── 5. Re-point deal_commissions.recipient_name (TEXT) ───────────────────────
  const { rowCount: commRepointed } = await queryFn(
    `UPDATE deal_commissions SET recipient_name = $1, updated_at = NOW() WHERE recipient_name = $2`,
    [SIMON_NAME, SHLOMI_NAME]
  );
  report.dealCommissions.repointed = commRepointed || 0;

  // ── 6. Count preserved historical references (for the report) ────────────────
  const { rows: lsRows } = await queryFn(`SELECT COUNT(*) c FROM lead_submissions WHERE assigned_rep_at_time = $1`, [SHLOMI_NAME]);
  report.preserved.leadSubmissions = parseInt(lsRows[0].c, 10);
  const { rows: aeRows } = await queryFn(`SELECT COUNT(*) c FROM appointment_events WHERE actor = $1`, [SHLOMI_NAME]);
  report.preserved.appointmentEvents = parseInt(aeRows[0].c, 10);

  return report;
}

// ── Base44-side: delete the Shlomi UserAllowlist row ──────────────────────────
async function deleteShlomiUserAllowlist() {
  const workerSecret = process.env.WORKER_SECRET;
  if (!workerSecret) throw new Error('WORKER_SECRET required to delete Shlomi UserAllowlist row');

  const res = await fetch(IDENTITY_MERGE_WRITER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': workerSecret },
    body: JSON.stringify({ action: 'delete_entity_record', entity: 'UserAllowlist', id: SHLOMI_UA_ID }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`identityMergeWriter HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error(`identityMergeWriter error: ${data.error?.message || 'unknown'}`);
  }
  return data.data;
}

// ── CLI main: Railway merge + Base44 delete + final audit ─────────────────────
async function main() {
  console.log('[merge-shlomi] Starting Shlomi → Simon identity merge...');

  // Step 1: Railway-side merge (permanent — NOT wrapped in a transaction here;
  // the rollback validator has already verified this path is safe).
  console.log('\n[merge-shlomi] === STEP 1: Railway re-point ===');
  const report = await runShlomiMerge(query);
  console.log(JSON.stringify(report, null, 2));

  // Step 2: Base44 UserAllowlist Shlomi row delete
  console.log('\n[merge-shlomi] === STEP 2: Base44 UserAllowlist Shlomi delete ===');
  const delResult = await deleteShlomiUserAllowlist();
  console.log(`Deleted Shlomi UserAllowlist row ${SHLOMI_UA_ID}: ${JSON.stringify(delResult)}`);

  // Step 3: Final zero-reference audit
  console.log('\n[merge-shlomi] === STEP 3: Final zero-reference audit ===');
  const { auditShlomiIdentity } = require('./auditShlomiIdentity');
  const audit = await auditShlomiIdentity();
  const activeRefs = audit.shlomiRefs.filter(r => r.classification.includes('RE-POINT'));
  if (activeRefs.length > 0) {
    console.error(`\n❌ MERGE INCOMPLETE: ${activeRefs.length} active Shlomi references remain:`);
    for (const r of activeRefs) console.error(`  [${r.store}] ${r.table || r.entity}.${r.column || r.field} id=${r.record_id}`);
    process.exit(1);
  }
  console.log(`\n✅ Zero active Shlomi references. Preserved (historical): ${audit.preserve.length}`);
  console.log('\n[merge-shlomi] IDENTITY MERGE COMPLETE.');
  process.exit(0);
}

module.exports = { runShlomiMerge, deleteShlomiUserAllowlist };

if (require.main === module) {
  main().catch(e => { console.error('[merge-shlomi] fatal:', e); process.exit(1); });
}