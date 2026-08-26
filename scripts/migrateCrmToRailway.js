#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * migrateCrmToRailway.js — ONE-COMMAND production CRM data migration runner.
 *
 * Usage:
 *   node scripts/migrateCrmToRailway.js             # Full migration (writes)
 *   node scripts/migrateCrmToRailway.js --preflight   # Read-only preflight (no writes)
 *
 * COVERS 24 DATASETS in dependency-safe order:
 *
 *   Foundation (no FK deps):
 *     1.  Owners        — created from Base44 users + distinct assigned_rep values
 *     2.  Users         — Base44 User → Railway users (email, full_name, role)
 *     3.  Contacts      — standalone non-lead contact records
 *     4.  AccessRequests — standalone access request records
 *     5.  CompanySettings — singleton company config
 *     6.  Settings      — app list configs (columns, statuses, projectTypes, sources)
 *     7.  UserAllowlist — email allowlist for app access
 *     8.  SyncCursors   — integration sync position state
 *
 *   Lead-dependent (FK → leads):
 *     9.  Leads         — foundation dataset (external_ref = Base44 Lead ID)
 *     10. Appointments  — converted from Lead appointment fields (date/time/type)
 *     11. Activities    — FK → leads
 *     12. Deals         — FK → leads (legacy_base44_id = Base44 Deal ID)
 *     13. Tasks         — FK → leads
 *     14. Invoices      — FK → leads, deals
 *     15. Properties    — FK → leads
 *     16. HandoffEstimates — FK → leads
 *     17. LeadSubmissions — FK → leads
 *     18. SignNowDocuments — FK → leads
 *     19. LeadAttachments — FK → leads
 *
 *   Deal-dependent (FK → deals):
 *     20. DealExpenses  — FK → deals, leads
 *     21. DealExpensePayments — FK → deals, deal_expenses
 *     22. DealCommissions — FK → deals, leads
 *     23. DealLoanPayments — FK → deals, leads
 *
 * SAFETY GUARANTEES:
 *   - Idempotent (all imports use ON CONFLICT DO UPDATE)
 *   - No DELETE/TRUNCATE
 *   - Preserves external_ref / legacy_base44_id (stable identity keys)
 *   - Preserves existing production rows
 *   - Stops on error (fail-fast)
 *   - Prints counts only, no secrets
 *   - Does NOT write to Base44
 *   - Does NOT change REMINDER_DRY_RUN
 *   - Does NOT send emails or create calendar events
 *   - Does NOT trigger QB/Handoff/SignNow actions
 *   - Does NOT create duplicate records
 *   - Reports unresolved FKs, unmapped owners, duplicate-key conflicts
 *   - Fails closed on material data loss
 *
 * Environment:
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional)
 *   DATABASE_URL (Railway Postgres)
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { query, pool } = require('../db/client');
const helpers = require('./migrationHelpers');

// Migration reads use the migrationReader backend function (asServiceRole + WORKER_SECRET).
// No BASE44_API_URL, BASE44_APP_ID, or BASE44_API_KEY needed — the function handles auth internally.
const BASE44_FUNCTIONS_URL = process.env.BASE44_FUNCTIONS_URL ||
  'https://crm-ec-construction-group.base44.app/functions/migrationReader';

const IS_PREFLIGHT = process.argv.includes('--preflight');

function log(msg) { console.log(`[migrate-crm] ${msg}`); }
function logErr(msg) { console.error(`[migrate-crm] ERROR: ${msg}`); }

// ── All 23 datasets in migration order ─────────────────────────────────────
const ALL_DATASETS = [
  // Foundation
  { name: 'Owners',          b44: null,              railway: 'owners',              script: 'migrateOwnersToRailway.js' },
  { name: 'Users',           b44: 'User',            railway: 'users',               script: 'migrateUsersToRailway.js' },
  { name: 'Contacts',        b44: 'Contact',         railway: 'contacts',            script: 'migrateContactsToRailway.js' },
  { name: 'AccessRequests',  b44: 'AccessRequest',   railway: 'access_requests',     script: 'migrateAccessRequestsToRailway.js' },
  { name: 'CompanySettings', b44: 'CompanySettings',  railway: 'company_settings',   script: null, handler: 'migrateSmallDatasets' },
  { name: 'Settings',        b44: 'Settings',         railway: 'settings',           script: 'migrateSettingsToRailway.js' },
  { name: 'UserAllowlist',   b44: 'UserAllowlist',    railway: 'user_allowlist',     script: null, handler: 'migrateSmallDatasets' },
  { name: 'SyncCursors',     b44: 'SyncCursor',       railway: 'sync_cursors',        script: null, handler: 'migrateSmallDatasets' },
  // Lead-dependent
  { name: 'Leads',           b44: 'Lead',             railway: 'leads',              script: 'migrateLeadsToRailway.js' },
  { name: 'Appointments',    b44: 'Lead',             railway: 'appointments',        script: 'migrateAppointmentsToRailway.js' },
  { name: 'Activities',     b44: 'Activity',         railway: 'activities',         script: 'migrateActivitiesToRailway.js' },
  { name: 'Deals',          b44: 'Deal',              railway: 'deals',              script: 'migrateDealsToRailway.js' },
  { name: 'Tasks',          b44: 'Task',              railway: 'tasks',              script: 'migrateTasksToRailway.js' },
  { name: 'Invoices',       b44: 'Invoice',           railway: 'invoices',           script: 'migrateInvoicesToRailway.js' },
  { name: 'Estimates',      b44: 'Estimate',          railway: 'estimates',          script: 'migrateEstimatesToRailway.js' },
  // Properties EXCLUDED — see EXCLUDED_DATASETS (Base44 Property is a key-value store, not real estate)
  { name: 'HandoffEstimates', b44: 'HandoffEstimate', railway: 'handoff_estimates',  script: 'migrateHandoffEstimatesToRailway.js' },
  { name: 'LeadSubmissions', b44: 'LeadSubmission',   railway: 'lead_submissions',   script: 'migrateLeadSubmissionsToRailway.js' },
  { name: 'SignNowDocuments', b44: 'SignNowDocument', railway: 'signnow_documents',  script: 'migrateSignNowDocumentsToRailway.js' },
  { name: 'LeadAttachments', b44: 'LeadAttachment',   railway: 'lead_attachments',    script: null, handler: 'migrateSmallDatasets' },
  // Deal-dependent
  { name: 'DealExpenses',   b44: 'DealExpense',       railway: 'deal_expenses',      script: null, handler: 'migrateSmallDatasets' },
  { name: 'DealExpensePayments', b44: 'DealExpensePayment', railway: 'deal_expense_payments', script: 'migrateDealExpensePaymentsToRailway.js' },
  { name: 'DealCommissions', b44: 'DealCommission',   railway: 'deal_commissions',    script: 'migrateDealCommissionsToRailway.js' },
  { name: 'DealLoanPayments', b44: 'DealLoanPayment', railway: 'deal_loan_payments', script: 'migrateDealLoanPaymentsToRailway.js' },
];

// ── Intentionally excluded datasets (with reasons) ─────────────────────────
const EXCLUDED_DATASETS = [
  { name: 'QBConnection',          reason: 'QB OAuth tokens stored in filesystem (.qb-tokens.encrypted) + integration_credentials table. Tokens are expired (reconnectRequired=true). Reconnecting QB post-migration populates fresh tokens.' },
  { name: 'QBLeadMatchMapping',    reason: 'Replaced by runtime qbMatch.findMatchingLead() algorithm — matching is computed, not stored.' },
  { name: 'SignNowTemplate',        reason: 'Templates are synced from SignNow API via syncSignNowTemplates. No CRM-owned template config exists.' },
  { name: 'QBSyncJob',              reason: 'Historical sync job logs — regenerated by each sync run.' },
  { name: 'QBSyncLog',              reason: 'Historical sync log entries — regenerated by each sync run.' },
  { name: 'HubSpotSyncJob',         reason: 'Historical HubSpot sync jobs — regenerated by each sync run.' },
  { name: 'SyncJob',               reason: 'Historical sync jobs — regenerated by each sync run.' },
  { name: 'IntegrationSyncLog',     reason: 'Historical integration sync logs — regenerated by each sync run.' },
  { name: 'SyncReport',             reason: 'Historical sync reports — regenerated by each sync run.' },
  { name: 'SyncState',              reason: 'Historical sync state — regenerated by each sync run.' },
  { name: 'HandoffSyncQueue',       reason: 'Historical handoff sync queue — regenerated by handoff worker.' },
  { name: 'CalendarSyncQueue',      reason: 'Historical calendar sync queue — replaced by calendar_outbox (Railway-owned).' },
  { name: 'Automation',             reason: 'Replaced by Railway cron jobs (routes/cronJobs.js).' },
  { name: 'AutomationRun',          reason: 'Historical automation execution logs — replaced by Railway cron.' },
  { name: 'MonitoringIncident',      reason: 'Railway monitoring operational data — not Base44 data.' },
  { name: 'SmsReminder',            reason: 'Operational reminder records — regenerated by reminder engine.' },
  { name: 'SmsLog',                 reason: 'Operational SMS log records — regenerated by reminder engine.' },
  { name: 'LeadHealthScore',        reason: 'Computed scores — regenerated by calculateLeadHealthScore function.' },
  { name: 'DealHealthScore',        reason: 'Computed scores — regenerated by calculateDealHealthScore function.' },
  { name: 'HandoffEstimateSeedIds', reason: 'Operational seed IDs — not production CRM data.' },
  { name: 'Project',                reason: 'SAFE TO DISCARD: 0 records in Base44 (verified via SDK query). The CRM UI (ProjectsModern.jsx) uses the Deals API (/api/v1/deals) as its data source, not the Project entity. No runtime consumers, no integrations reference it. No Railway table needed.' },
  { name: 'Property',               reason: 'SCHEMA MISMATCH — Base44 Property is a generic key-value store, NOT real estate properties. 133 records contain: (1) 114 qb_customer_<leadId> → QB Customer ID mappings — replaced by runtime qbMatch.findMatchingLead() algorithm (computed, not stored); (2) 3 OAuth tokens (qb_tokens, signnow_tokens, handoff_bearer_token) — belong in integration_credentials table (AES-256-CBC encrypted); (3) 1 integration config (qb_environment) — belongs in settings table; (4) 15 app UI config (app_title, app_logo_url, primary_color) — belong in settings table. The Railway properties table (address, city, state, zip, square_footage, bedrooms, bathrooms) was designed for real estate properties — a completely different concept. The migratePropertiesToRailway.js script maps non-existent fields (address, city, etc. are null in ALL 133 records). Migrating would create 133 empty real estate property shells with no meaningful data, while the actual data (tokens, config, mappings) is already handled by integration_credentials, settings, and the runtime QB matching algorithm. The Railway properties table should remain empty (0 rows) until the CRM UI needs real estate property tracking.' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function countRailwayTable(tableName) {
  try {
    const { rows } = await query(`SELECT COUNT(*) as cnt FROM ${tableName}`);
    return parseInt(rows[0].cnt, 10);
  } catch { return 'TABLE_MISSING'; }
}

async function tableExists(tableName) {
  try {
    const { rows } = await query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
      [tableName]
    );
    return rows[0].exists;
  } catch { return false; }
}

// ── Preflight ────────────────────────────────────────────────────────────────

async function runPreflight() {
  log('=== PREFLIGHT MODE (READ-ONLY — NO WRITES) ===\n');

  const hasCreds = helpers.hasBase44Creds();
  console.log(`Base44 credentials (WORKER_SECRET): ${hasCreds ? 'SET ✅' : 'NOT SET ❌ — migration will fail'}`);
  console.log(`Migration reader endpoint: ${BASE44_FUNCTIONS_URL}`);
  console.log(`Auth mechanism: base44.asServiceRole (bypasses RLS, no user password/SSO needed)`);
  console.log('');

  // 0. Base44 API connectivity probe — verify the REST endpoint is reachable
  console.log('=== BASE44 API CONNECTIVITY PROBE ===\n');
  let b44Reachable = false;
  let b44ProbeError = null;
  if (hasCreds) {
    const probe = await helpers.probeBase44Entity('Lead');
    b44Reachable = probe.reachable;
    b44ProbeError = probe.error;
    console.log(`Endpoint: ${probe.url || 'N/A'}`);
    console.log(`Reachable: ${probe.reachable ? 'YES ✅' : 'NO ❌'}`);
    console.log(`HTTP Status: ${probe.httpStatus || 'N/A'}`);
    if (probe.error) console.log(`Error: ${probe.error}`);
    if (probe.firstRecordId) console.log(`First record ID: ${probe.firstRecordId}`);
  } else {
    console.log('Skipped — no Base44 credentials');
  }
  console.log('');

  // 1. Check all Railway tables exist
  console.log('=== RAILWAY TABLE READINESS ===\n');
  console.log('DATASET                    RAILWAY TABLE          EXISTS   RAILWAY COUNT   B44 COUNT   B44 READ STATUS');
  console.log('─────────────────────────  ─────────────────────  ──────── ──────────────  ───────────  ──────────────────');

  const results = [];
  let failedReads = 0;
  for (const ds of ALL_DATASETS) {
    const exists = await tableExists(ds.railway);
    const rwCount = exists ? await countRailwayTable(ds.railway) : 'TABLE_MISSING';

    // Structured count result: { count, status, error, httpStatus }
    // status: 'ok' | 'zero' | 'error' | 'no_creds' | 'N/A' (derived datasets)
    let b44Result;
    if (ds.b44) {
      b44Result = await helpers.countBase44Entity(ds.b44);
      if (b44Result.status === 'error' || b44Result.status === 'no_creds') {
        failedReads++;
      }
    } else {
      b44Result = { count: null, status: 'N/A', error: null, httpStatus: null };
    }

    const b44CountDisplay = b44Result.count !== null ? b44Result.count : (b44Result.status === 'zero' ? 0 : '—');
    const b44StatusDisplay = b44Result.status === 'ok' ? 'OK ✅' :
                             b44Result.status === 'zero' ? 'ZERO (verified)' :
                             b44Result.status === 'error' ? `ERROR ❌ (${b44Result.httpStatus || 'N/A'})` :
                             b44Result.status === 'no_creds' ? 'NO CREDS ❌' :
                             'N/A (derived)';

    console.log(
      `${ds.name.padEnd(25)}  ${ds.railway.padEnd(20)}  ${exists ? 'YES' : 'NO'}      ${String(rwCount).padEnd(12)}  ${String(b44CountDisplay).padEnd(10)}  ${b44StatusDisplay}`
    );

    if (b44Result.error) {
      console.log(`  └─ Error: ${b44Result.error}`);
    }

    results.push({ ...ds, b44Result, rwCount, exists });
  }

  // 2. Reference integrity checks
  console.log('\n=== REFERENCE INTEGRITY CHECK ===\n');

  // Leads with external_ref
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM leads WHERE external_ref IS NOT NULL');
    console.log(`Leads with external_ref: ${rows[0].cnt}`);
  } catch (e) { console.log(`Leads with external_ref: TABLE_MISSING`); }

  // Active owners
  let activeOwnersCount = 0;
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM owners WHERE is_active = true');
    activeOwnersCount = parseInt(rows[0].cnt, 10) || 0;
    console.log(`Active owners: ${activeOwnersCount}`);
  } catch (e) { console.log(`Active owners: TABLE_MISSING`); }

  // Deals with legacy_base44_id
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM deals WHERE legacy_base44_id IS NOT NULL');
    console.log(`Deals with legacy_base44_id: ${rows[0].cnt}`);
  } catch (e) { console.log(`Deals with legacy_base44_id: TABLE_MISSING`); }

  // Appointment types seeded
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM appointment_types');
    console.log(`Appointment types seeded: ${rows[0].cnt}`);
  } catch (e) { console.log(`Appointment types seeded: TABLE_MISSING`); }

  // Users count
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM users');
    console.log(`Railway users: ${rows[0].cnt}`);
  } catch (e) { console.log(`Railway users: TABLE_MISSING`); }

  // 3. Owner mapping completeness — enumerate EVERY distinct assigned_rep
  //    ONLY runs if the Lead source read succeeds. A source-read failure is
  //    reported separately as 'NOT CHECKED' — it must NOT manufacture unresolved
  //    owners. The fail-closed for source-read failure is handled by the
  //    b44Reachable and failedReads checks, not by this section.
  let unresolvedOwnerCount = 0;
  let ownerCheckStatus = 'not_checked'; // 'ok' | 'not_checked' | 'source_read_failed'
  let totalLeadsWithNamedOwner = 0;
  let totalLeadsGenuinelyUnassigned = 0;

  if (hasCreds) {
    console.log('\n=== OWNER MAPPING — EVERY DISTINCT assigned_rep ===\n');
    if (activeOwnersCount === 0) {
      console.log('Owners table is EMPTY — migrateOwnersToRailway.js (Step 3 of full migration) will populate it.');
      console.log('Owner resolution validation SKIPPED in preflight. It will be enforced by:');
      console.log('  - migrateLeadsToRailway.js (fail-closed on unresolved named owners)');
      console.log('  - migrateAppointmentsToRailway.js (uses resolveOwnerId)');
      console.log('Both run AFTER migrateOwnersToRailway.js in the full migration order.');
      ownerCheckStatus = 'owners_table_empty';
    } else {
    try {
      const base44Leads = await helpers.fetchBase44Entity('Lead');
      const ownerCache = await helpers.buildOwnerCache();
      ownerCheckStatus = 'ok'; // Source read succeeded — owner check is valid

      // Build: assigned_rep → { count, resolvedOwnerId }
      const repStats = new Map();
      for (const lead of base44Leads) {
        const rep = lead.assigned_rep;
        const isGenuinelyUnassigned = !rep || !String(rep).trim();
        if (isGenuinelyUnassigned) {
          totalLeadsGenuinelyUnassigned++;
          continue;
        }
        totalLeadsWithNamedOwner++;
        const repKey = String(rep).trim();
        if (!repStats.has(repKey)) {
          const resolvedId = ownerCache[String(repKey).toLowerCase().replace(/\s+/g, ' ').trim()] || null;
          repStats.set(repKey, { count: 0, resolvedOwnerId: resolvedId });
        }
        repStats.get(repKey).count++;
      }

      console.log(`Total Base44 leads: ${base44Leads.length}`);
      console.log(`Leads with named assigned_rep: ${totalLeadsWithNamedOwner}`);
      console.log(`Leads genuinely unassigned (null/empty): ${totalLeadsGenuinelyUnassigned}`);
      console.log(`Distinct named assigned_rep values: ${repStats.size}`);
      console.log('');

      const sortedReps = [...repStats.entries()].sort((a, b) => b[1].count - a[1].count);
      let mapped = 0, unmapped = 0;
      const unmappedReps = [];

      console.log('SOURCE VALUE                        LEADS  RESOLVED OWNER ID                        STATUS');
      console.log('──────────────────────────────────  ─────  ──────────────────────────────────────  ────────────');
      for (const [rep, stats] of sortedReps) {
        const status = stats.resolvedOwnerId ? 'RESOLVED' : 'UNRESOLVED';
        if (stats.resolvedOwnerId) {
          mapped++;
        } else {
          unmapped++;
          unresolvedOwnerCount++;
          unmappedReps.push(rep);
        }
        console.log(
          `${rep.slice(0, 34).padEnd(34)}  ${String(stats.count).padStart(5)}  ${String(stats.resolvedOwnerId || '—').slice(0, 38).padEnd(38)}  ${status}`
        );
      }

      console.log('');
      console.log(`Summary: ${mapped} resolved, ${unmapped} UNRESOLVED`);

      if (unmapped > 0) {
        console.log('');
        console.log('⚠️  UNRESOLVED OWNERS DETECTED — PREFLIGHT FAILS CLOSED');
        console.log('');
        console.log('The following assigned_rep values have no Railway owner mapping.');
        console.log('No silent fallback will be applied. Ownership must be preserved exactly.');
        console.log('');
        console.log('To fix: run "node scripts/migrateOwnersToRailway.js" to create owners for');
        console.log('all assigned_rep values, then re-run this preflight.');
        console.log('');
        console.log('If migrateOwners has already run and these remain unresolved, the assigned_rep');
        console.log('value may need manual owner creation or alias mapping in the Railway owners table.');
      }
    } catch (e) {
      // Source-read failure — do NOT manufacture unresolved owners.
      // The fail-closed for source-read failure is handled by b44Reachable
      // and failedReads checks in the summary. This section reports NOT CHECKED.
      console.log(`Owner mapping check: NOT CHECKED — Lead source read failed: ${e.message}`);
      ownerCheckStatus = 'source_read_failed';
    }
    } // end else (owners table not empty)
  }

  // 4. Duplicate-key conflict check
  console.log('\n=== DUPLICATE-KEY CONFLICT CHECK ===\n');
  try {
    const { rows } = await query('SELECT external_ref, COUNT(*) as cnt FROM leads WHERE external_ref IS NOT NULL GROUP BY external_ref HAVING COUNT(*) > 1 LIMIT 10');
    if (rows.length > 0) {
      console.log(`⚠️  Duplicate external_ref in leads: ${rows.length} conflicts found`);
      for (const r of rows) console.log(`  ${r.external_ref}: ${r.cnt} rows`);
    } else {
      console.log('No duplicate external_ref conflicts in leads ✅');
    }
  } catch (e) { console.log(`Duplicate check failed: ${e.message}`); }

  // 4b. Migration script SQL shape validation (non-destructive static analysis)
  console.log('\n=== MIGRATION SCRIPT SHAPE VALIDATION ===\n');
  try {
    const validatePath = path.join(__dirname, 'validateMigrationShapes.js');
    if (fs.existsSync(validatePath)) {
      execSync(`node "${validatePath}"`, {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
        env: process.env,
        timeout: 30000,
      });
    } else {
      console.log('⚠️  validateMigrationShapes.js not found — skipping shape validation');
    }
  } catch (e) {
    failReasons.push(`Migration script shape validation FAILED — ${e.message}. Fix SQL/variable defects before proceeding.`);
  }

  // 5. Migration files on disk
  console.log('\n=== MIGRATION SCRIPTS ON DISK ===\n');
  const scriptsDir = path.join(__dirname);
  for (const ds of ALL_DATASETS) {
    if (!ds.script) continue;
    const exists = fs.existsSync(path.join(scriptsDir, ds.script));
    console.log(`  ${exists ? '✅' : '❌'} ${ds.script}`);
  }

  // 6. Intentionally excluded datasets
  console.log('\n=== INTENTIONALLY EXCLUDED DATASETS ===\n');
  for (const ex of EXCLUDED_DATASETS) {
    console.log(`  ⏭️  ${ex.name}: ${ex.reason}`);
  }

  // 7. Summary
  console.log('\n=== PREFLIGHT SUMMARY ===\n');
  const missingTables = results.filter(r => !r.exists).map(r => r.railway);
  const totalB44 = results.reduce((sum, r) => sum + (typeof r.b44Result?.count === 'number' ? r.b44Result.count : 0), 0);
  const totalRW = results.reduce((sum, r) => sum + (typeof r.rwCount === 'number' ? r.rwCount : 0), 0);

  console.log(`Base44 credentials: ${hasCreds ? 'YES' : 'NO'}`);
  console.log(`Base44 API reachable: ${b44Reachable ? 'YES ✅' : 'NO ❌'}`);
  if (b44ProbeError) console.log(`Base44 API error: ${b44ProbeError}`);
  console.log(`Railway database: ${await tableExists('leads') ? 'CONNECTED' : 'NOT CONNECTED'}`);
  console.log(`Missing tables: ${missingTables.length > 0 ? missingTables.join(', ') : 'NONE ✅'}`);
  console.log(`Owner check: ${ownerCheckStatus === 'ok' ? `COMPLETED (${unresolvedOwnerCount} unresolved)` : ownerCheckStatus === 'owners_table_empty' ? 'SKIPPED (owners table empty — will be populated by Step 3)' : ownerCheckStatus === 'source_read_failed' ? 'NOT CHECKED (source read failed)' : 'NOT CHECKED (no credentials)'}`);
  console.log(`Failed Base44 source reads: ${failedReads}`);
  console.log(`Total Base44 records to import: ${totalB44}`);
  console.log(`Total Railway records currently: ${totalRW}`);
  console.log(`Datasets to migrate: ${ALL_DATASETS.length}`);
  console.log(`Datasets intentionally excluded: ${EXCLUDED_DATASETS.length}`);

  // FAIL CLOSED conditions
  const failReasons = [];
  if (!hasCreds) failReasons.push('WORKER_SECRET not set — required to authenticate with the migrationReader backend function');
  if (!b44Reachable) failReasons.push(`Migration reader not reachable — ${b44ProbeError || 'unknown error'}. Check WORKER_SECRET is set in Railway and the migrationReader function is deployed.`);
  if (missingTables.length > 0) failReasons.push(`Missing tables: ${missingTables.join(', ')}. Run 'node db/migrate.js' first.`);
  if (ownerCheckStatus === 'ok' && unresolvedOwnerCount > 0) failReasons.push(`${unresolvedOwnerCount} unresolved named owner(s) — ownership must be preserved exactly, no silent fallback`);
  if (failedReads > 0) failReasons.push(`${failedReads} Base44 source read(s) FAILED — a failed read must NEVER be counted as zero. Check WORKER_SECRET is set correctly and the migrationReader function is deployed at ${BASE44_FUNCTIONS_URL}.`);

  if (failReasons.length > 0) {
    console.log('\n⚠️  PREFLIGHT FAILED — DO NOT PROCEED WITH FULL MIGRATION');
    for (const r of failReasons) console.log(`  ❌ ${r}`);
    console.log('\nFix the issues above, then re-run: node scripts/migrateCrmToRailway.js --preflight');
    console.log('Only proceed with full migration after preflight passes AND you explicitly approve.');
    process.exit(1);
  }

  console.log('\n✅ ALL CHECKS PASSED — preflight is clean.');
  console.log('Review the 22 intentionally excluded datasets above to verify none contain live state required by production.');
  console.log('When ready, explicitly approve the full migration: node scripts/migrateCrmToRailway.js');
  console.log('\n=== PREFLIGHT COMPLETE — NO WRITES PERFORMED ===');
  process.exit(0);
}

// ── Full Migration ───────────────────────────────────────────────────────────

async function runStep(stepNum, description, fn) {
  log(`\n>>> STEP ${stepNum}: ${description}`);
  try {
    await fn();
    log(`    STEP ${stepNum} COMPLETE ✅`);
  } catch (e) {
    logErr(`STEP ${stepNum} FAILED: ${e.message}`);
    process.exit(1);
  }
}

function runImportScript(scriptName) {
  const scriptPath = path.join(__dirname, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Import script not found: ${scriptPath}`);
  }
  log(`  Running: node scripts/${scriptName}`);
  const result = spawnSync('node', [scriptPath], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: 600000,
  });

  // Print captured output
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  // Check exit code (scripts that call process.exit(1) on fatal errors)
  if (result.status !== 0) {
    throw new Error(`Script exited with code ${result.status}`);
  }

  // FAIL CLOSED: check for write-error patterns in output
  const allOutput = (result.stdout || '') + (result.stderr || '');

  // Pattern 1: "Errors: N" where N > 0 (most migration scripts)
  const errorMatch = allOutput.match(/Errors:\s*([1-9]\d*)/);
  if (errorMatch) {
    throw new Error(`Script reported ${errorMatch[1]} write error(s) — step FAILS (fail-closed)`);
  }

  // Pattern 2: "N errors" where N > 0 (migrateSmallDatasetsToRailway.js per-dataset output)
  const smallDsErrorMatch = allOutput.match(/([1-9]\d*)\s+errors\b/);
  if (smallDsErrorMatch) {
    throw new Error(`Script reported ${smallDsErrorMatch[1]} error(s) — step FAILS (fail-closed)`);
  }
}

async function verifyTables() {
  const required = ALL_DATASETS.map(ds => ds.railway);
  // Add appointment_types (needed by appointments migration)
  required.push('appointment_types');
  const missing = [];
  for (const t of required) {
    const exists = await tableExists(t);
    if (!exists) missing.push(t);
  }
  if (missing.length > 0) {
    throw new Error(`Missing tables after migration: ${missing.join(', ')}`);
  }
  log('  All required tables exist ✅');
}

async function reconciliationCounts() {
  log('\n=== RECONCILIATION COUNTS ===\n');
  console.log('TABLE                       RAILWAY COUNT');
  console.log('──────────────────────────  ─────────────');
  for (const ds of ALL_DATASETS) {
    const count = await countRailwayTable(ds.railway);
    console.log(`${ds.railway.padEnd(26)}  ${count}`);
  }
}

async function runFullMigration() {
  log('=== FULL CRM DATA MIGRATION (WRITE MODE) ===');
  log(`Started: ${new Date().toISOString()}`);
  log(`Migration reader: ${BASE44_FUNCTIONS_URL}`);
  log(`Datasets: ${ALL_DATASETS.length}`);

  if (!helpers.hasBase44Creds()) {
    logErr('WORKER_SECRET required for migration (set in Railway Variables)');
    process.exit(1);
  }

  // STEP 1: Run schema migrations
  await runStep(1, 'Run schema migrations (db/migrate.js)', () => {
    const migratePath = path.join(__dirname, '..', 'db', 'migrate.js');
    if (!fs.existsSync(migratePath)) throw new Error('db/migrate.js not found');
    log('  Running: node db/migrate.js');
    execSync('node db/migrate.js', { stdio: 'inherit', cwd: path.join(__dirname, '..'), env: process.env });
  });

  // STEP 2: Verify required tables exist
  await runStep(2, 'Verify required tables exist', verifyTables);

  // STEPS 3-25: Run migration scripts in dependency order
  let stepNum = 3;
  let smallDatasetsRun = false;
  for (const ds of ALL_DATASETS) {
    if (ds.handler === 'migrateSmallDatasets') {
      // migrateSmallDatasets handles 5 datasets in one script.
      // It must run AFTER leads and deals (LeadAttachments and DealExpenses have FK deps).
      // Run it only once, when we first encounter it AFTER the Deals step.
      if (!smallDatasetsRun && ds.name === 'LeadAttachments') {
        await runStep(stepNum, `Import small datasets (UserAllowlist, CompanySettings, SyncCursors, LeadAttachments, DealExpenses)`, () => {
          runImportScript('migrateSmallDatasetsToRailway.js');
        });
        smallDatasetsRun = true;
      }
      stepNum++;
      continue;
    }
    if (ds.script) {
      await runStep(stepNum, `Import ${ds.name}`, () => {
        runImportScript(ds.script);
      });
    }
    stepNum++;
  }

  // Final step: Reconciliation counts
  await runStep(stepNum, 'Run reconciliation counts', reconciliationCounts);

  log('\n=== FULL CRM DATA MIGRATION COMPLETE ===');
  log(`Finished: ${new Date().toISOString()}`);
  log('\nNEXT STEPS:');
  log('  1. Verify CRM UI shows real data (Dashboard, Leads, Deals)');
  log('  2. Do NOT change REMINDER_DRY_RUN until reminder_leads is populated');
  log('  3. Do NOT send emails or create calendar events until verified');
  log('  4. Reconnect QuickBooks OAuth (tokens expired)');
  log('  5. Set REMINDER_DRY_RUN=false to enable real reminder sending');

  await pool.end();
  process.exit(0);
}

// ── Entry ────────────────────────────────────────────────────────────────────

if (IS_PREFLIGHT) {
  runPreflight().catch(e => {
    logErr(`Preflight fatal: ${e.message}`);
    process.exit(1);
  });
} else {
  runFullMigration().catch(e => {
    logErr(`Migration fatal: ${e.message}`);
    process.exit(1);
  });
}