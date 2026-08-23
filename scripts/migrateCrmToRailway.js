#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * migrateCrmToRailway.js — ONE-COMMAND production CRM data migration runner.
 *
 * Usage:
 *   node scripts/migrateCrmToRailway.js             # Full migration (writes)
 *   node scripts/migrateCrmToRailway.js --preflight   # Read-only preflight (no writes)
 *
 * EXECUTES IN ORDER:
 *   1. Run schema migrations (db/migrate.js)
 *   2. Verify required tables exist
 *   3. Import leads (foundation — all other datasets depend on this)
 *   4. Import activities (FK → leads)
 *   5. Import deals (FK → leads)
 *   6. Import properties (FK → leads)
 *   7. Import handoff estimates (FK → leads)
 *   8. Import small datasets (UserAllowlist, CompanySettings, SyncCursors, LeadAttachments, DealExpenses)
 *   9. Run reconciliation counts
 *  10. Exit non-zero on any failure
 *
 * SAFETY GUARANTEES:
 *   - Idempotent (all imports use ON CONFLICT DO UPDATE)
 *   - No DELETE/TRUNCATE
 *   - Preserves external_ref (stable identity key)
 *   - Preserves existing production rows
 *   - Stops on error (fail-fast)
 *   - Prints counts only, no secrets
 *   - Does NOT change REMINDER_SOURCE
 *   - Does NOT send emails
 *   - Does NOT create calendar events
 *   - Does NOT trigger QB/Handoff/SignNow actions
 *   - Does NOT run Base44 automations
 *   - Does NOT create duplicate leads
 *
 * Environment:
 *   BASE44_APP_ID, BASE44_API_KEY, BASE44_API_URL (optional)
 *   DATABASE_URL (Railway Postgres)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { query, pool } = require('../db/client');

const BASE44_API_URL = process.env.BASE44_API_URL || 'https://api.base44.com';
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;

const IS_PREFLIGHT = process.argv.includes('--preflight');

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[migrate-crm] ${msg}`); }
function logErr(msg) { console.error(`[migrate-crm] ERROR: ${msg}`); }

async function countBase44Entity(entityName) {
  if (!BASE44_APP_ID || !BASE44_API_KEY) return 'N/A (no Base44 creds)';
  try {
    const url = `${BASE44_API_URL}/entities/${entityName}?limit=1`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'X-App-ID': BASE44_APP_ID },
    });
    if (!res.ok) return `API ${res.status}`;
    // Base44 doesn't return total count; fetch all to count
    const all = [];
    let offset = 0;
    while (true) {
      const r = await fetch(`${BASE44_API_URL}/entities/${entityName}?limit=500&offset=${offset}`, {
        headers: { 'Authorization': `Bearer ${BASE44_API_KEY}`, 'X-App-ID': BASE44_APP_ID },
      });
      if (!r.ok) break;
      const data = await r.json();
      const batch = Array.isArray(data) ? data : (data.items || []);
      if (batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 500) break;
      offset += 500;
    }
    return all.length;
  } catch (e) {
    return `ERR: ${e.message?.substring(0, 60)}`;
  }
}

async function countRailwayTable(tableName) {
  try {
    const { rows } = await query(`SELECT COUNT(*) as cnt FROM ${tableName}`);
    return parseInt(rows[0].cnt, 10);
  } catch (e) {
    return `TABLE_MISSING`;
  }
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

  const datasets = [
    { name: 'Leads', b44: 'Lead', railway: 'leads' },
    { name: 'Activities', b44: 'Activity', railway: 'activities' },
    { name: 'Deals', b44: 'Deal', railway: 'deals' },
    { name: 'Properties', b44: 'Property', railway: 'properties' },
    { name: 'Handoff Estimates', b44: 'HandoffEstimate', railway: 'handoff_estimates' },
    { name: 'Lead Attachments', b44: 'LeadAttachment', railway: 'lead_attachments' },
    { name: 'User Allowlist', b44: 'UserAllowlist', railway: 'user_allowlist' },
    { name: 'Company Settings', b44: 'CompanySettings', railway: 'company_settings' },
    { name: 'Sync Cursors', b44: 'SyncCursor', railway: 'sync_cursors' },
    { name: 'Deal Expenses', b44: 'DealExpense', railway: 'deal_expenses' },
    { name: 'Tasks', b44: 'Task', railway: 'tasks' },
    { name: 'Invoices', b44: 'Invoice', railway: 'invoices' },
  ];

  console.log('DATASET                    BASE44       RAILWAY      TABLE EXISTS');
  console.log('─────────────────────────  ───────────  ───────────  ────────────');

  const results = [];
  for (const ds of datasets) {
    const b44Count = await countBase44Entity(ds.b44);
    const rwCount = await countRailwayTable(ds.railway);
    const exists = await tableExists(ds.railway);
    console.log(
      `${ds.name.padEnd(25)}  ${String(b44Count).padEnd(11)}  ${String(rwCount).padEnd(11)}  ${exists ? 'YES' : 'NO'}`
    );
    results.push({ ...ds, b44Count, rwCount, exists });
  }

  // Check unresolved references
  console.log('\n=== REFERENCE INTEGRITY CHECK ===\n');

  // Check if leads have external_ref set (needed for FK resolution)
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM leads WHERE external_ref IS NOT NULL');
    console.log(`Leads with external_ref: ${rows[0].cnt}`);
  } catch (e) {
    console.log(`Leads with external_ref: TABLE_MISSING`);
  }

  // Check owners table
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM owners WHERE is_active = true');
    console.log(`Active owners: ${rows[0].cnt}`);
  } catch (e) {
    console.log(`Active owners: TABLE_MISSING`);
  }

  // Check migration files present
  console.log('\n=== MIGRATION FILES ON DISK ===\n');
  const migrationDir = path.join(__dirname, '..', 'db', 'migrations');
  if (fs.existsSync(migrationDir)) {
    const files = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();
    console.log(`Found ${files.length} migration files:`);
    for (const f of files) console.log(`  ${f}`);
  } else {
    logErr('db/migrations directory not found');
  }

  // Check import scripts present
  console.log('\n=== IMPORT SCRIPTS ON DISK ===\n');
  const scriptsDir = path.join(__dirname);
  const expectedScripts = [
    'migrateLeadsToRailway.js',
    'migrateActivitiesToRailway.js',
    'migrateDealsToRailway.js',
    'migratePropertiesToRailway.js',
    'migrateHandoffEstimatesToRailway.js',
    'migrateSmallDatasetsToRailway.js',
  ];
  for (const s of expectedScripts) {
    const exists = fs.existsSync(path.join(scriptsDir, s));
    console.log(`  ${exists ? '✅' : '❌'} ${s}`);
  }

  // Summary
  console.log('\n=== PREFLIGHT SUMMARY ===\n');
  const missingTables = results.filter(r => !r.exists).map(r => r.railway);
  const hasBase44Creds = BASE44_APP_ID && BASE44_API_KEY;

  console.log(`Base44 credentials: ${hasBase44Creds ? 'YES' : 'NO'}`);
  console.log(`Railway database: ${await tableExists('leads') ? 'CONNECTED' : 'NOT CONNECTED'}`);
  console.log(`Missing tables: ${missingTables.length > 0 ? missingTables.join(', ') : 'NONE'}`);
  console.log(`Total Base44 records to import: ${results.reduce((sum, r) => sum + (typeof r.b44Count === 'number' ? r.b44Count : 0), 0)}`);
  console.log(`Total Railway records currently: ${results.reduce((sum, r) => sum + (typeof r.rwCount === 'number' ? r.rwCount : 0), 0)}`);

  if (missingTables.length > 0) {
    console.log(`\n⚠️  Missing tables detected. Run schema migrations first (step 1 of full mode).`);
  }

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
  execSync(`node "${scriptPath}"`, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: process.env,
  });
}

async function verifyTables() {
  const required = [
    'leads', 'activities', 'deals', 'properties', 'handoff_estimates',
    'lead_attachments', 'user_allowlist', 'company_settings', 'sync_cursors',
    'deal_expenses', 'owners',
  ];
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
  const tables = [
    'leads', 'activities', 'deals', 'properties', 'handoff_estimates',
    'lead_attachments', 'user_allowlist', 'company_settings', 'sync_cursors',
    'deal_expenses',
  ];
  console.log('TABLE                  RAILWAY COUNT');
  console.log('─────────────────────  ─────────────');
  for (const t of tables) {
    const count = await countRailwayTable(t);
    console.log(`${t.padEnd(21)}  ${count}`);
  }
}

async function runFullMigration() {
  log('=== FULL CRM DATA MIGRATION (WRITE MODE) ===');
  log(`Started: ${new Date().toISOString()}`);
  log(`Base44 API: ${BASE44_API_URL}`);
  log(`Preflight: NO (writes enabled)`);

  if (!BASE44_APP_ID || !BASE44_API_KEY) {
    logErr('BASE44_APP_ID and BASE44_API_KEY required for migration');
    process.exit(1);
  }

  // STEP 1: Run schema migrations
  await runStep(1, 'Run schema migrations (db/migrate.js)', () => {
    const migratePath = path.join(__dirname, '..', 'db', 'migrate.js');
    if (!fs.existsSync(migratePath)) {
      throw new Error('db/migrate.js not found');
    }
    log('  Running: node db/migrate.js');
    execSync('node db/migrate.js', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env: process.env,
    });
  });

  // STEP 2: Verify required tables exist
  await runStep(2, 'Verify required tables exist', verifyTables);

  // STEP 3: Import leads (foundation)
  await runStep(3, 'Import leads (foundation dataset)', () => {
    runImportScript('migrateLeadsToRailway.js');
  });

  // STEP 4: Import activities (FK → leads)
  await runStep(4, 'Import activities (FK → leads)', () => {
    runImportScript('migrateActivitiesToRailway.js');
  });

  // STEP 5: Import deals (FK → leads)
  await runStep(5, 'Import deals (FK → leads)', () => {
    runImportScript('migrateDealsToRailway.js');
  });

  // STEP 6: Import properties (FK → leads)
  await runStep(6, 'Import properties (FK → leads)', () => {
    runImportScript('migratePropertiesToRailway.js');
  });

  // STEP 7: Import handoff estimates (FK → leads)
  await runStep(7, 'Import handoff estimates (FK → leads)', () => {
    runImportScript('migrateHandoffEstimatesToRailway.js');
  });

  // STEP 8: Import small datasets
  await runStep(8, 'Import small datasets (UserAllowlist, CompanySettings, SyncCursors, LeadAttachments, DealExpenses)', () => {
    runImportScript('migrateSmallDatasetsToRailway.js');
  });

  // STEP 9: Reconciliation counts
  await runStep(9, 'Run reconciliation counts', reconciliationCounts);

  log('\n=== FULL CRM DATA MIGRATION COMPLETE ===');
  log(`Finished: ${new Date().toISOString()}`);
  log('\nNEXT STEPS:');
  log('  1. Verify CRM UI shows real data (Dashboard, Leads, Deals)');
  log('  2. Do NOT change REMINDER_SOURCE until reminder_leads is populated');
  log('  3. Do NOT send emails or create calendar events until verified');

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