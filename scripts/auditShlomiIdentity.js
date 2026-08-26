/* eslint-disable no-undef */
'use strict';
/**
 * auditShlomiIdentity.js — Comprehensive read-only audit for the
 * Shlomi Ashkenazi → Simon Ashkenazi identity merge.
 *
 * Scans BOTH stores for every Shlomi reference:
 *   1. Railway Postgres — all CRM tables, all text columns, case-insensitive
 *      substring search for Shlomi identifiers.
 *   2. Base44 entities — via migrationReader (asServiceRole), all identity-bearing
 *      entities, field-by-field scan.
 *
 * Shlomi-specific identifiers (the shared email office@tsvisionbuilders.com is
 * NOT Shlomi-specific — it belongs to Simon; only name + Base44 IDs identify
 * Shlomi):
 *   - Name:  "Shlomi Ashkenazi" (and substring "shlomi")
 *   - Base44 UserAllowlist id: 6a4aef73f211c8ca4d59eb7a
 *   - Base44 User id: (none — Shlomi has no User account; only Simon does)
 *
 * Simon canonical identifiers (merge target):
 *   - Name:  "Simon Ashkenazi"
 *   - Base44 UserAllowlist id: 6a3d634c1e40faa5a663c33f
 *   - Base44 User id: 6a4af06a78e6d77be96d0a1a
 *   - Email: office@tsvisionbuilders.com
 *
 * Each found reference is CLASSIFIED:
 *   - canonical-identity-reference → will be re-pointed to Simon by the merge
 *   - historical-display-text      → preserved (audit trail), NOT re-pointed
 *
 * Environment: DATABASE_URL, WORKER_SECRET
 */
const { query } = require('../db/client');
const { fetchBase44Entity, hasBase44Creds } = require('./migrationHelpers');

const SHLOMI_NAME = 'Shlomi Ashkenazi';
const SHLOMI_NAME_LOWER = SHLOMI_NAME.toLowerCase();
const SHLOMI_SUBSTR = 'shlomi';
const SHLOMI_UA_ID = '6a4aef73f211c8ca4d59eb7a';

const SIMON_NAME = 'Simon Ashkenazi';
const SIMON_UA_ID = '6a3d634c1e40faa5a663c33f';
const SIMON_USER_ID = '6a4af06a78e6d77be96d0a1a';
const SHARED_EMAIL = 'office@tsvisionbuilders.com';

// ── Railway tables + text columns to scan ────────────────────────────────────
// Historical/audit text columns are scanned but classified as preserve.
const RAILWAY_SCAN = [
  { table: 'owners',                   cols: ['display_name', 'email'],                       classify: 'canonical' },
  { table: 'leads',                    cols: ['external_ref', 'first_name', 'last_name', 'email', 'notes'], classify: 'mixed' },
  { table: 'appointments',             cols: [],                                               classify: 'canonical' }, // owner_id is UUID — handled separately
  { table: 'appointment_events',       cols: ['actor'],                                        classify: 'historical' },
  { table: 'deals',                    cols: ['assigned_rep', 'name', 'description', 'notes', 'created_by', 'updated_by'], classify: 'mixed' },
  { table: 'activities',               cols: ['author', 'content'],                            classify: 'mixed' },
  { table: 'tasks',                    cols: ['assigned_to', 'title', 'notes'],                 classify: 'mixed' },
  { table: 'deal_commissions',         cols: ['recipient_name', 'recipient_user_id', 'notes', 'created_by', 'updated_by'], classify: 'mixed' },
  { table: 'lead_submissions',         cols: ['assigned_rep_at_time'],                         classify: 'historical' },
  { table: 'user_allowlist',           cols: ['email', 'name', 'notes'],                       classify: 'canonical' },
  { table: 'sync_cursors',             cols: ['integration'],                                  classify: 'canonical' },
  { table: 'deal_expenses',            cols: ['created_by', 'updated_by', 'vendor_name', 'description', 'notes'], classify: 'mixed' },
  { table: 'deal_expense_payments',    cols: ['created_by', 'updated_by', 'notes'],            classify: 'mixed' },
  { table: 'deal_loan_payments',       cols: ['created_by', 'updated_by', 'notes', 'lender_name'], classify: 'mixed' },
  { table: 'invoices',                 cols: ['created_by', 'updated_by', 'description', 'notes'], classify: 'mixed' },
  { table: 'handoff_estimates',        cols: ['customer_name', 'customer_email', 'customer_phone'], classify: 'mixed' },
  { table: 'lead_attachments',         cols: ['uploaded_by'],                                  classify: 'mixed' },
  { table: 'properties',               cols: ['notes'],                                        classify: 'mixed' },
  { table: 'contacts',                 cols: ['first_name', 'last_name', 'email', 'notes'],     classify: 'mixed' },
  { table: 'access_requests',          cols: ['email', 'name', 'reason'],                      classify: 'mixed' },
  { table: 'company_settings',         cols: ['admin_name', 'admin_email', 'company_name'],    classify: 'mixed' },
];

// Columns that are historical audit text → preserve, never re-point.
const HISTORICAL_COLUMNS = new Set([
  'lead_submissions.assigned_rep_at_time',
  'appointment_events.actor',
]);

// ── Base44 entities + fields to scan ──────────────────────────────────────────
const B44_SCAN = [
  { entity: 'UserAllowlist',  fields: ['name', 'email', 'notes'] },
  { entity: 'User',            fields: ['full_name', 'email'] },
  { entity: 'Lead',            fields: ['assigned_rep', 'first_name', 'last_name', 'notes', 'message'] },
  { entity: 'Deal',            fields: ['assigned_rep', 'name', 'description', 'notes'] },
  { entity: 'Activity',        fields: ['author', 'content'] },
  { entity: 'Task',            fields: ['assigned_to', 'title', 'notes'] },
  { entity: 'DealCommission',  fields: ['recipient_name', 'recipient_user_id', 'notes'] },
  { entity: 'LeadSubmission',  fields: ['assigned_rep_at_time'] },
  { entity: 'SyncCursor',      fields: ['integration'] },
  { entity: 'DealExpense',     fields: ['created_by', 'updated_by', 'vendor_name', 'notes'] },
  { entity: 'DealExpensePayment', fields: ['created_by', 'updated_by', 'notes'] },
  { entity: 'DealLoanPayment', fields: ['created_by', 'updated_by', 'notes', 'lender_name'] },
  { entity: 'Invoice',         fields: ['description', 'notes'] },
  { entity: 'HandoffEstimate', fields: ['customer_name', 'customer_email'] },
  { entity: 'LeadAttachment',   fields: ['uploaded_by'] },
  { entity: 'Contact',          fields: ['first_name', 'last_name', 'email', 'notes'] },
  { entity: 'AccessRequest',   fields: ['email', 'name', 'reason'] },
  { entity: 'CompanySettings', fields: ['admin_name', 'admin_email'] },
];

function containsShlomi(value) {
  if (value === null || value === undefined) return false;
  const s = String(value).toLowerCase();
  return s.includes(SHLOMI_SUBSTR) || s.includes(SHLOMI_UA_ID);
}

function classifyRef(table, col) {
  if (HISTORICAL_COLUMNS.has(`${table}.${col}`)) return 'historical-display-text (PRESERVE)';
  return 'canonical-identity-reference (RE-POINT to Simon)';
}

async function auditRailway() {
  console.log('=== RAILWAY POSTGRES AUDIT ===\n');
  const refs = [];
  const tableExists = {};

  for (const t of RAILWAY_SCAN) {
    // Check table exists
    const { rows: te } = await query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) as e`,
      [t.table]
    );
    tableExists[t.table] = te[0].e;
    if (!te[0].e) {
      console.log(`  [skip] table ${t.table} does not exist`);
      continue;
    }

    // UUID owner_id FK check for owners/leads/appointments
    if (t.table === 'owners') {
      const { rows: ownerRows } = await query(
        `SELECT id, display_name, email, is_active FROM owners WHERE lower(display_name) LIKE '%shlomi%' OR email = $1`,
        [SHARED_EMAIL]
      );
      for (const r of ownerRows) {
        const isShlomi = r.display_name && r.display_name.toLowerCase().includes(SHLOMI_SUBSTR);
        refs.push({
          store: 'railway', table: 'owners', column: 'display_name',
          record_id: r.id, value: `${r.display_name} <${r.email}> active=${r.is_active}`,
          classification: isShlomi ? 'canonical-identity-reference (RE-POINT to Simon)' : 'shared-email-owner (Simon canonical — no change)',
          isShlomi,
        });
      }
      continue;
    }

    if (t.table === 'appointments') {
      // owner_id UUID FK — find appointments owned by a Shlomi owner
      const { rows: apptRows } = await query(`
        SELECT a.id, a.owner_id, o.display_name, a.status, a.start_at
        FROM appointments a JOIN owners o ON a.owner_id = o.id
        WHERE lower(o.display_name) LIKE '%shlomi%'`);
      for (const r of apptRows) {
        refs.push({
          store: 'railway', table: 'appointments', column: 'owner_id',
          record_id: r.id, value: `owner=${r.display_name} (${r.owner_id}) status=${r.status} start=${r.start_at}`,
          classification: 'canonical-identity-reference (RE-POINT owner_id to Simon owner)',
          isShlomi: true,
        });
      }
      continue;
    }

    // Generic text-column scan
    for (const col of t.cols) {
      // Verify column exists
      const { rows: ce } = await query(
        `SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
        [t.table, col]
      );
      if (ce.length === 0) continue;

      const { rows } = await query(
        `SELECT id, ${col} as val FROM ${t.table} WHERE ${col} IS NOT NULL AND (lower(${col}::text) LIKE '%shlomi%' OR ${col}::text LIKE $1)`,
        [SHLOMI_UA_ID]
      );
      for (const r of rows) {
        refs.push({
          store: 'railway', table: t.table, column: col,
          record_id: r.id, value: String(r.val).slice(0, 200),
          classification: classifyRef(t.table, col),
          isShlomi: true,
        });
      }
    }
  }

  // leads.owner_id UUID FK — find leads owned by a Shlomi owner
  if (tableExists.leads && tableExists.owners) {
    const { rows: leadOwnerRows } = await query(`
      SELECT l.id, l.owner_id, o.display_name
      FROM leads l JOIN owners o ON l.owner_id = o.id
      WHERE lower(o.display_name) LIKE '%shlomi%'`);
    for (const r of leadOwnerRows) {
      refs.push({
        store: 'railway', table: 'leads', column: 'owner_id',
        record_id: r.id, value: `owner=${r.display_name} (${r.owner_id})`,
        classification: 'canonical-identity-reference (RE-POINT owner_id to Simon owner)',
        isShlomi: true,
      });
    }
  }

  return refs;
}

async function auditBase44() {
  console.log('\n=== BASE44 ENTITY AUDIT (via migrationReader) ===\n');
  const refs = [];
  if (!hasBase44Creds()) {
    console.log('  [skip] WORKER_SECRET not set — cannot read Base44');
    return refs;
  }

  for (const e of B44_SCAN) {
    let items;
    try {
      items = await fetchBase44Entity(e.entity);
    } catch (err) {
      console.log(`  [skip] ${e.entity}: ${err.message}`);
      continue;
    }
    console.log(`  ${e.entity}: ${items.length} records scanned`);
    for (const item of items) {
      for (const field of e.fields) {
        const val = item[field];
        if (containsShlomi(val)) {
          // Classify: LeadSubmission.assigned_rep_at_time + Activity.author + AppointmentEvents are historical
          let classification = 'canonical-identity-reference (RE-POINT to Simon)';
          if (e.entity === 'LeadSubmission' && field === 'assigned_rep_at_time') {
            classification = 'historical-display-text (PRESERVE — records rep at time of submission)';
          } else if (e.entity === 'Activity' && field === 'author') {
            // author is semi-historical but represents the actor identity → re-point (same person)
            classification = 'canonical-identity-reference (RE-POINT to Simon — same person authored)';
          } else if (field === 'content' || field === 'message' || field === 'notes' || field === 'reason' || field === 'description') {
            classification = 'historical-display-text (PRESERVE — free-text body, audit only)';
          }
          refs.push({
            store: 'base44', entity: e.entity, field,
            record_id: item.id, value: String(val).slice(0, 200),
            classification, isShlomi: true,
          });
        }
      }
    }
  }
  return refs;
}

async function auditShlomiIdentity() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  SHLOMI ASHKENAZI → SIMON ASHKENAZI IDENTITY-MERGE AUDIT       ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`Canonical (KEEP):  ${SIMON_NAME}  | UA id ${SIMON_UA_ID} | User id ${SIMON_USER_ID} | ${SHARED_EMAIL}`);
  console.log(`Duplicate (MERGE): ${SHLOMI_NAME} | UA id ${SHLOMI_UA_ID} | (no User account)`);
  console.log('');

  const [railwayRefs, b44Refs] = await Promise.all([auditRailway(), auditBase44()]);

  const allRefs = [...railwayRefs, ...b44Refs];
  const shlomiRefs = allRefs.filter(r => r.isShlomi);
  const rePoint = shlomiRefs.filter(r => r.classification.includes('RE-POINT'));
  const preserve = shlomiRefs.filter(r => r.classification.includes('PRESERVE'));

  console.log('\n=== AUDIT SUMMARY ===\n');
  console.log(`Total Shlomi references found: ${shlomiRefs.length}`);
  console.log(`  Re-point to Simon:    ${rePoint.length}`);
  console.log(`  Preserve (historical): ${preserve.length}`);
  console.log('');

  if (shlomiRefs.length > 0) {
    console.log('── All Shlomi references ──');
    for (const r of shlomiRefs) {
      const loc = r.store === 'railway' ? `${r.table}.${r.column}` : `${r.entity}.${r.field}`;
      console.log(`  [${r.store}] ${loc} | id=${r.record_id}`);
      console.log(`        value: "${r.value}"`);
      console.log(`        class: ${r.classification}`);
    }
  } else {
    console.log('✅ Zero Shlomi references found across Railway + Base44.');
  }

  // ── UserAllowlist final state preview ──────────────────────────────────────
  console.log('\n=== USERALLOWLIST STATE ===\n');
  const { rows: uaRows } = await query(`SELECT email, name, role, enabled FROM user_allowlist ORDER BY email`);
  console.log(`Railway user_allowlist: ${uaRows.length} rows`);
  for (const r of uaRows) console.log(`  ${r.email} | ${r.name} | ${r.role} | enabled=${r.enabled}`);

  const { rows: uaDup } = await query(`SELECT email, COUNT(*) c FROM user_allowlist GROUP BY email HAVING COUNT(*) > 1`);
  if (uaDup.length > 0) {
    console.log(`\n⚠️  Duplicate emails in Railway user_allowlist: ${JSON.stringify(uaDup)}`);
  }

  return { railwayRefs, b44Refs, shlomiRefs, rePoint, preserve };
}

module.exports = { auditShlomiIdentity, containsShlomi, SHLOMI_NAME, SIMON_NAME, SHLOMI_UA_ID, SIMON_UA_ID, SIMON_USER_ID, SHARED_EMAIL };

if (require.main === module) {
  auditShlomiIdentity().then(() => process.exit(0)).catch(e => { console.error('[audit-shlomi] fatal:', e); process.exit(1); });
}