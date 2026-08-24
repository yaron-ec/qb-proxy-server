#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * R1A Migration Dry-Run Validator — REAL PostgreSQL
 *
 * Executes db/migrations/2026-09-crm-core.sql against a REAL, isolated,
 * NON-PRODUCTION PostgreSQL instance and reports:
 *   - PostgreSQL server version
 *   - Per-statement execution time
 *   - Errors / warnings
 *   - Resulting schema verification (columns, indexes, tables, triggers,
 *     CHECK constraints, foreign keys)
 *   - Behavioral tests (trigger updated_at, CHECK enforcement, FK cascade)
 *   - Idempotency (re-run, expect zero errors)
 *
 * SAFETY:
 *   - Requires TEST_DATABASE_URL env var. Refuses to run without it.
 *   - NEVER falls back to DATABASE_URL or any production variable.
 *   - Aborts if the URL looks like a production database.
 *   - Runs the ENTIRE dry run inside a single transaction and ROLLBACKs.
 *     Zero persistent changes. The test DB is left pristine and reusable.
 *
 * BASELINE:
 *   Replicates the `owners` and `leads` table definitions from db/schema.sql
 *   (the only tables the R1A migration touches) plus the existing
 *   leads_touch_updated_at trigger. This matches the production schema for
 *   the affected tables without requiring the full schema.sql extensions
 *   (btree_gist, appointments EXCLUDE, etc.).
 *
 * USAGE (from src/proxy-server/):
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/testdb \
 *     node scripts/dryRunMigration.js
 *
 *   The `pg` package is already a dependency of proxy-server, so run from
 *   the src/proxy-server/ directory.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error('FATAL: TEST_DATABASE_URL not set. Refusing to run.');
  console.error('       This script requires an isolated NON-PRODUCTION PostgreSQL instance.');
  console.error('       It will NOT fall back to DATABASE_URL or any production variable.');
  process.exit(2);
}
// Safety guard: refuse if TEST_DATABASE_URL matches DATABASE_URL (production).
const PROD_DB = process.env.DATABASE_URL || '';
function normalizeUrl(u) {
  // Strip query string and lowercase for a stable host/db comparison.
  return String(u || '').replace(/\?.*$/, '').trim().toLowerCase();
}
if (PROD_DB && normalizeUrl(TEST_DB) === normalizeUrl(PROD_DB)) {
  console.error('FATAL: TEST_DATABASE_URL matches DATABASE_URL (the production connection).');
  console.error('       Refusing to run against the production database.');
  console.error('       Provide a separate, isolated non-production database.');
  process.exit(2);
}
// Safety guard: refuse if the URL looks production-only.
if (/prod|production/i.test(TEST_DB) && !/test|staging|dev|dry|sandbox/i.test(TEST_DB)) {
  console.error('FATAL: TEST_DATABASE_URL appears to reference a production database.');
  console.error('       Aborting for safety. Use a dedicated test/staging database.');
  process.exit(2);
}

let pg;
try {
  pg = require('pg');
} catch (e) {
  console.error('FATAL: `pg` package not installed in this environment: ' + e.message);
  console.error('       Run this script from the src/proxy-server/ directory where `pg` is installed.');
  process.exit(2);
}

// ── SQL statement splitter (handles $$ dollar-quoting and ' strings) ──
function splitSql(sql) {
  const lines = sql.split('\n').filter((l) => !l.trim().startsWith('--'));
  const clean = lines.join('\n');
  const out = [];
  let buf = '';
  let inDollar = false;
  let inQuote = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '$' && clean[i + 1] === '$' && !inQuote) {
      inDollar = !inDollar;
      buf += '$$';
      i++;
      continue;
    }
    if (ch === "'" && !inDollar) inQuote = !inQuote;
    buf += ch;
    if (ch === ';' && !inDollar && !inQuote) {
      const t = buf.trim().replace(/;$/, '').trim();
      if (t) out.push(t);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function preview(s, n = 70) {
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > n ? c.slice(0, n) + '…' : c;
}

// Baseline: owners + leads from db/schema.sql (exact definitions).
const BASELINE = [
  `CREATE TABLE owners (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT UNIQUE, display_name TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE OR REPLACE FUNCTION owners_touch_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER owners_set_updated_at BEFORE UPDATE ON owners FOR EACH ROW EXECUTE FUNCTION owners_touch_updated_at()`,
  `CREATE TABLE leads (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), external_ref TEXT UNIQUE, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, phone TEXT, property_address TEXT, city TEXT, zip TEXT, project_type TEXT, budget_range TEXT, start_timeframe TEXT, source TEXT, referral_name TEXT, owner_id UUID NOT NULL REFERENCES owners(id), status TEXT NOT NULL DEFAULT 'new', notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), projection_revision INTEGER NOT NULL DEFAULT 0, origin_system TEXT CHECK (origin_system IN ('railway','base44')))`,
  `CREATE OR REPLACE FUNCTION leads_touch_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql`,
  `CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION leads_touch_updated_at()`,
  `INSERT INTO owners (email, display_name) VALUES ('test@ec.com', 'Test Owner')`,
  `INSERT INTO leads (first_name, last_name, owner_id) SELECT 'Jane', 'Doe', id FROM owners LIMIT 1`,
];

async function run() {
  const report = {
    timestamp: new Date().toISOString(),
    environment: 'real PostgreSQL (isolated non-production)',
    testDatabaseUrl: TEST_DB.replace(/:[^:@/]+@/, ':***@'),
    migrationFile: 'db/migrations/2026-09-crm-core.sql',
    pgVersion: null,
    statements: [],
    errors: [],
    warnings: [],
    schemaVerification: {},
    behavioralTests: {},
    idempotency: null,
    overallPass: false,
    summary: {},
  };

  const pool = new pg.Pool({ connectionString: TEST_DB });
  const client = await pool.connect();

  try {
    const v = await client.query('SHOW server_version');
    report.pgVersion = v.rows[0].server_version;

    await client.query('BEGIN');

    // ── Baseline ──
    for (const s of BASELINE) {
      await client.query(s);
    }

    // Pre-migration leads columns snapshot
    const preCols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' ORDER BY ordinal_position`
    );
    report.schemaVerification.preMigrationLeadsColumns = preCols.rows.map((r) => r.column_name);

    // ── Apply R1A migration statement-by-statement with timing ──
    const migrationPath = path.join(__dirname, '..', 'db', 'migrations', '2026-09-crm-core.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    const statements = splitSql(migrationSql);
    report.summary.totalStatements = statements.length;

    const tStart = performance.now();
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const t0 = performance.now();
      try {
        await client.query(stmt);
        const dt = performance.now() - t0;
        report.statements.push({ index: i + 1, ok: true, ms: +dt.toFixed(3), preview: preview(stmt) });
      } catch (e) {
        const dt = performance.now() - t0;
        report.statements.push({ index: i + 1, ok: false, ms: +dt.toFixed(3), preview: preview(stmt), error: e.message });
        report.errors.push({ index: i + 1, preview: preview(stmt), error: e.message });
      }
    }
    report.summary.totalMs = +(performance.now() - tStart).toFixed(3);
    report.summary.successful = report.statements.filter((s) => s.ok).length;
    report.summary.failed = report.statements.filter((s) => !s.ok).length;

    // ── Schema verification ──
    const sv = report.schemaVerification;

    // Created tables (activities + settings are new in R1A)
    const createdTables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('activities','settings') ORDER BY table_name`
    );
    sv.createdTables = createdTables.rows.map((r) => r.table_name);
    sv.createdTablesOk = sv.createdTables.length === 2;

    const expectedLeadsCols = [
      'message', 'lead_score', 'is_new_intake_lead', 'customer_reminders_disabled',
      'photo_urls', 'crm_created_date', 'reviewed_at', 'record_type',
      'follow_up_date', 'follow_up_time', 'follow_up_type', 'meeting_stage',
    ];
    const leadsCols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'leads' AND column_name = ANY($1)`,
      [expectedLeadsCols]
    );
    sv.leadsNewColumns = {
      expected: expectedLeadsCols.length,
      found: leadsCols.rows.length,
      columns: leadsCols.rows,
      ok: leadsCols.rows.length === expectedLeadsCols.length,
    };

    const actCols = await client.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'activities' ORDER BY ordinal_position`
    );
    sv.activitiesColumns = { count: actCols.rows.length, columns: actCols.rows, ok: actCols.rows.length === 9 };

    const setCols = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'settings' ORDER BY ordinal_position`
    );
    sv.settingsColumns = { count: setCols.rows.length, columns: setCols.rows, ok: setCols.rows.length === 13 };

    const seed = await client.query(`SELECT id, company_name, app_lists FROM settings WHERE id = 1`);
    sv.settingsSeed = { ok: seed.rows.length === 1, row: seed.rows[0] };

    const idx = await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'leads'`);
    sv.leadsIndexes = idx.rows.map((r) => r.indexname);
    const expectedIdx = ['leads_status_idx', 'leads_record_type_idx', 'leads_crm_created_date_idx', 'leads_follow_up_date_idx'];
    sv.leadsIndexesOk = expectedIdx.every((n) => sv.leadsIndexes.includes(n));

    const actIdx = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'activities'`);
    sv.activitiesIndexes = actIdx.rows.map((r) => r.indexname);

    const trig = await client.query(
      `SELECT event_object_table, trigger_name, action_timing, event_manipulation FROM information_schema.triggers WHERE event_object_table IN ('activities','settings')`
    );
    sv.triggers = trig.rows;

    const checks = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('leads'::regclass, 'activities'::regclass)`
    );
    sv.checkConstraints = checks.rows;

    const fks = await client.query(
      `SELECT conname, conrelid::regclass AS table, confrelid::regclass AS ref_table, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'f' AND conrelid = 'activities'::regclass`
    );
    sv.foreignKeys = fks.rows;

    // ── Behavioral tests ──
    // All tests run inside the single outer BEGIN. PostgreSQL NOW() returns
    // the transaction-start timestamp, so JS sleeps cannot advance it. For
    // trigger tests we INSERT with an explicit old updated_at (INSERT does
    // not fire the BEFORE UPDATE trigger), then UPDATE and verify the trigger
    // replaced the old value. For expected-failure CHECK tests we wrap each
    // intentionally-invalid statement in its own SAVEPOINT so the outer
    // transaction stays usable after the abort.
    const bt = report.behavioralTests;

    // --- activities: updated_at trigger (deterministic) ---
    await client.query(
      `INSERT INTO activities (lead_id, type, content, author, updated_at)
       SELECT id, 'note', 'trigger test', 'system', '2020-01-01T00:00:00Z' FROM leads LIMIT 1`
    );
    const actBefore = await client.query(
      `SELECT id, updated_at FROM activities WHERE content = 'trigger test' ORDER BY created_at DESC LIMIT 1`
    );
    const actId = actBefore.rows[0].id;
    const actBeforeTs = actBefore.rows[0].updated_at;
    await client.query(`UPDATE activities SET content = 'updated' WHERE id = $1`, [actId]);
    const actAfter = await client.query(`SELECT updated_at, content FROM activities WHERE id = $1`, [actId]);
    const actAfterTs = actAfter.rows[0].updated_at;
    bt.activitiesTriggerUpdated = {
      ok: new Date(actAfterTs).getTime() > new Date(actBeforeTs).getTime(),
      before: actBeforeTs,
      after: actAfterTs,
    };

    // --- settings: updated_at trigger (deterministic) ---
    // Use a dedicated test row (id=999) with an explicit old updated_at so the
    // singleton seed row (id=1) is untouched and the test is deterministic.
    await client.query(
      `INSERT INTO settings (id, company_name, updated_at)
       VALUES (999, 'Test Co', '2020-01-01T00:00:00Z') ON CONFLICT (id) DO NOTHING`
    );
    const setBefore = await client.query(`SELECT updated_at FROM settings WHERE id = 999`);
    const setBeforeTs = setBefore.rows[0].updated_at;
    await client.query(`UPDATE settings SET company_name = 'Test Co Updated' WHERE id = 999`);
    const setAfter = await client.query(`SELECT updated_at, company_name FROM settings WHERE id = 999`);
    const setAfterTs = setAfter.rows[0].updated_at;
    bt.settingsTriggerUpdated = {
      ok: new Date(setAfterTs).getTime() > new Date(setBeforeTs).getTime(),
      before: setBeforeTs,
      after: setAfterTs,
    };

    // --- expected-failure helper: SAVEPOINT keeps the outer tx usable ---
    async function expectFailure(savepoint, sql, params) {
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await client.query(sql, params);
        // Unexpectedly succeeded → constraint NOT enforced; undo the change.
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { ok: false, enforced: false, error: 'CHECK NOT enforced (invalid value accepted)' };
      } catch (e) {
        // Expected failure → restore the transaction to a usable state.
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { ok: true, enforced: true, error: e.message };
      }
    }

    bt.activitiesTypeCheck = await expectFailure(
      'sp_activities_type',
      `INSERT INTO activities (lead_id, type, content) SELECT id, 'bogus', 'x' FROM leads LIMIT 1`
    );

    bt.leadsRecordTypeCheck = await expectFailure(
      'sp_leads_record_type',
      `UPDATE leads SET record_type = 'BOGUS'`
    );

    // --- FK cascade: delete a lead → its activities must be cascade-removed ---
    const leadRow = await client.query(`SELECT id FROM leads LIMIT 1`);
    const leadId = leadRow.rows[0].id;
    await client.query(`DELETE FROM leads WHERE id = $1`, [leadId]);
    const remaining = await client.query(`SELECT count(*) AS c FROM activities`);
    const remainingCount = Number(remaining.rows[0].c);
    bt.fkCascade = { ok: remainingCount === 0, remainingActivities: remainingCount };

    // ── Idempotency: re-run migration, expect zero errors ──
    let idemErrors = 0;
    const idemDetails = [];
    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (e) {
        idemErrors++;
        idemDetails.push({ preview: preview(stmt), error: e.message });
      }
    }
    report.idempotency = { ok: idemErrors === 0, errorsOnRerun: idemErrors, details: idemDetails };

    // ── ROLLBACK (zero persistent changes) ──
    await client.query('ROLLBACK');
    report.summary.rollback = 'success — zero persistent changes';

    // ── Overall pass: every required validation must be true ──
    // `sv` (schemaVerification) was declared earlier in this block; reuse it.
    report.overallPass = !!(
      sv.createdTablesOk &&
      sv.leadsNewColumns?.ok &&
      sv.activitiesColumns?.ok &&
      sv.settingsColumns?.ok &&
      sv.settingsSeed?.ok &&
      sv.leadsIndexesOk &&
      bt.activitiesTriggerUpdated?.ok &&
      bt.settingsTriggerUpdated?.ok &&
      bt.activitiesTypeCheck?.ok &&
      bt.leadsRecordTypeCheck?.ok &&
      bt.fkCascade?.ok &&
      report.idempotency?.ok &&
      report.idempotency?.errorsOnRerun === 0 &&
      report.summary.rollback === 'success — zero persistent changes' &&
      Array.isArray(report.errors) && report.errors.length === 0
    );
  } catch (e) {
    report.errors.push({ fatal: true, error: e.message, stack: e.stack });
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
  } finally {
    client.release();
    await pool.end();
  }

  return report;
}

run()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.overallPass ? 0 : 1);
  })
  .catch((e) => {
    console.error('DRY RUN CRASH:', e);
    process.exit(1);
  });