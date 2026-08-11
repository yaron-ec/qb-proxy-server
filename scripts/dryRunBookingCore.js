#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * CRM Booking Core + R1A Combined — Dry-Run Validator (REAL PostgreSQL)
 *
 * Validates the prerequisite migration sequence against a REAL, isolated,
 * NON-PRODUCTION PostgreSQL instance:
 *
 *   1. db/migrations/2026-08-crm-booking-core.sql   (prerequisite)
 *   2. db/migrations/2026-09-crm-core.sql           (R1A, already approved)
 *
 * Reports:
 *   - PostgreSQL server version
 *   - Per-statement execution time for BOTH migrations
 *   - Errors / warnings
 *   - Schema verification (tables, columns, PK/FK, indexes, triggers,
 *     CHECK constraints, the appointments EXCLUDE constraint)
 *   - Behavioral tests (updated_at triggers, EXCLUDE overlap semantics,
 *     appointments_no_delete, appointment_events immutability, FK NO ACTION,
 *     activities ON DELETE CASCADE from R1A)
 *   - Idempotency (re-run BOTH migrations, expect zero errors)
 *
 * SAFETY:
 *   - Requires TEST_DATABASE_URL env var. Refuses to run without it.
 *   - NEVER falls back to DATABASE_URL or any production variable.
 *   - Aborts if the URL looks like a production database.
 *   - Runs the ENTIRE dry run inside a single outer transaction and ROLLBACKs.
 *     Zero persistent changes. The test DB is left pristine and reusable.
 *   - No BASELINE: the booking-core migration is self-contained (creates
 *     owners + leads + appointments + outboxes from scratch).
 *
 * USAGE (from src/proxy-server/):
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/testdb \
 *     node scripts/dryRunBookingCore.js
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
const PROD_DB = process.env.DATABASE_URL || '';
function normalizeUrl(u) {
  return String(u || '').replace(/\?.*$/, '').trim().toLowerCase();
}
if (PROD_DB && normalizeUrl(TEST_DB) === normalizeUrl(PROD_DB)) {
  console.error('FATAL: TEST_DATABASE_URL matches DATABASE_URL (the production connection).');
  console.error('       Refusing to run against the production database.');
  process.exit(2);
}
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

// Apply a migration file's statements, recording per-statement timing + errors.
async function applyMigration(client, label, migrationPath, report) {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const statements = splitSql(sql);
  const tStart = performance.now();
  const result = { label, file: path.basename(migrationPath), statements: [], errors: [] };
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const t0 = performance.now();
    try {
      await client.query(stmt);
      result.statements.push({ index: i + 1, ok: true, ms: +(performance.now() - t0).toFixed(3), preview: preview(stmt) });
    } catch (e) {
      result.statements.push({ index: i + 1, ok: false, ms: +(performance.now() - t0).toFixed(3), preview: preview(stmt), error: e.message });
      result.errors.push({ index: i + 1, preview: preview(stmt), error: e.message });
    }
  }
  result.totalMs = +(performance.now() - tStart).toFixed(3);
  result.totalStatements = statements.length;
  result.successful = result.statements.filter((s) => s.ok).length;
  result.failed = result.statements.filter((s) => !s.ok).length;
  report.migrations.push(result);
  if (result.errors.length) report.errors.push(...result.errors.map((e) => ({ migration: label, ...e })));
  return result;
}

async function run() {
  const report = {
    timestamp: new Date().toISOString(),
    environment: 'real PostgreSQL (isolated non-production)',
    testDatabaseUrl: TEST_DB.replace(/:[^:@/]+@/, ':***@'),
    migrationsApplied: [],
    migrations: [],
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

    const bookingCorePath = path.join(__dirname, '..', 'db', 'migrations', '2026-08-crm-booking-core.sql');
    const crmCorePath = path.join(__dirname, '..', 'db', 'migrations', '2026-09-crm-core.sql');
    report.migrationsApplied = ['2026-08-crm-booking-core.sql', '2026-09-crm-core.sql'];

    // ── Apply prerequisite (booking-core) ──
    const r1 = await applyMigration(client, 'booking-core', bookingCorePath, report);

    // ── Apply R1A (crm-core) ──
    const r2 = await applyMigration(client, 'crm-core (R1A)', crmCorePath, report);

    report.summary.totalStatements = r1.totalStatements + r2.totalStatements;
    report.summary.successful = r1.successful + r2.successful;
    report.summary.failed = r1.failed + r2.failed;

    // ── Schema verification ──
    const sv = report.schemaVerification;

    // All expected tables (9 from booking-core + 2 from R1A)
    const expectedTables = [
      'owners', 'leads', 'appointments', 'appointment_types', 'appointment_events',
      'booking_idempotency', 'calendar_outbox', 'projection_outbox', 'base44_entity_map',
      'activities', 'settings',
    ];
    const tbls = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      [expectedTables]
    );
    sv.createdTables = tbls.rows.map((r) => r.table_name);
    sv.createdTablesOk = expectedTables.every((t) => sv.createdTables.includes(t));

    // owners columns
    const ownersCols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='owners' ORDER BY ordinal_position`
    );
    sv.ownersColumns = { count: ownersCols.rows.length, names: ownersCols.rows.map((r) => r.column_name), ok: ownersCols.rows.length === 6 };

    // leads base + booking-core columns (19 base + projection_revision + origin_system = 21) + 12 R1A = 33
    const expectedLeadsBase = [
      'id','external_ref','first_name','last_name','email','phone','property_address','city','zip',
      'project_type','budget_range','start_timeframe','source','referral_name','owner_id','status',
      'notes','created_at','updated_at','projection_revision','origin_system',
    ];
    const expectedLeadsR1A = [
      'message','lead_score','is_new_intake_lead','customer_reminders_disabled','photo_urls',
      'crm_created_date','reviewed_at','record_type','follow_up_date','follow_up_time',
      'follow_up_type','meeting_stage',
    ];
    const leadsCols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='leads' ORDER BY ordinal_position`
    );
    const leadsColNames = leadsCols.rows.map((r) => r.column_name);
    sv.leadsColumns = {
      total: leadsColNames.length,
      baseOk: expectedLeadsBase.every((c) => leadsColNames.includes(c)),
      r1aOk: expectedLeadsR1A.every((c) => leadsColNames.includes(c)),
      ok: [...expectedLeadsBase, ...expectedLeadsR1A].every((c) => leadsColNames.includes(c)),
    };

    // appointments columns (18 base + version = 19)
    const expectedApptCols = [
      'id','lead_id','owner_id','appointment_type_id','start_at','end_at','duration_override_minutes',
      'timezone','busy_range','status','idempotency_key','calendar_sync_status','google_event_id',
      'google_travel_event_id','calendar_last_error','calendar_synced_at','created_at','updated_at','version',
    ];
    const apptCols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='appointments' ORDER BY ordinal_position`
    );
    const apptColNames = apptCols.rows.map((r) => r.column_name);
    sv.appointmentsColumns = {
      total: apptColNames.length,
      ok: expectedApptCols.every((c) => apptColNames.includes(c)),
    };

    // appointment_types seed (12 rows)
    const atSeed = await client.query('SELECT count(*) AS c FROM appointment_types');
    sv.appointmentTypesSeed = { count: Number(atSeed.rows[0].c), ok: Number(atSeed.rows[0].c) === 12 };

    // Indexes
    const expectedIndexes = [
      'leads_owner_idx','leads_email_idx',
      'appointments_owner_idx','appointments_lead_idx','appointments_status_idx','appointments_start_idx',
      'appointment_events_appt_idx',
      'calendar_outbox_idem_uidx','calendar_outbox_claim_idx','calendar_outbox_appt_idx','calendar_outbox_processing_idx',
      'projection_outbox_idem_uidx','projection_outbox_claim_idx','projection_outbox_lead_idx',
      'base44_entity_map_base44_uidx',
    ];
    const idxAll = await client.query(
      `SELECT tablename, indexname FROM pg_indexes WHERE tablename IN ('leads','appointments','appointment_events','calendar_outbox','projection_outbox','base44_entity_map')`
    );
    const idxNames = idxAll.rows.map((r) => r.indexname);
    sv.indexes = { found: idxNames, ok: expectedIndexes.every((n) => idxNames.includes(n)) };

    // Triggers
    const expectedTriggers = [
      'owners_set_updated_at','leads_set_updated_at','appointments_set_updated_at','appointments_no_delete',
      'appointment_events_no_update','projection_outbox_set_updated_at','base44_entity_map_set_updated_at',
    ];
    const trig = await client.query(
      `SELECT event_object_table, trigger_name FROM information_schema.triggers WHERE trigger_schema='public'`
    );
    const trigNames = trig.rows.map((r) => r.trigger_name);
    sv.triggers = { found: trigNames, ok: expectedTriggers.every((n) => trigNames.includes(n)) };

    // Foreign keys
    const fks = await client.query(
      `SELECT conname, conrelid::regclass AS tbl, confrelid::regclass AS ref, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE contype='f' AND conrelid IN ('owners'::regclass,'leads'::regclass,'appointments'::regclass,'appointment_types'::regclass,'appointment_events'::regclass,'booking_idempotency'::regclass,'calendar_outbox'::regclass,'projection_outbox'::regclass,'base44_entity_map'::regclass,'activities'::regclass)
       ORDER BY conrelid::regclass::text`
    );
    sv.foreignKeys = { count: fks.rows.length, rows: fks.rows, ok: fks.rows.length >= 11 };

    // EXCLUDE constraint
    const exclude = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype='x' AND conrelid='appointments'::regclass`
    );
    sv.excludeConstraint = {
      found: exclude.rows.length > 0,
      name: exclude.rows[0]?.conname,
      def: exclude.rows[0]?.def,
      ok: exclude.rows.length > 0 && /appointments_no_active_overlap/.test(exclude.rows[0]?.conname || ''),
    };

    // CHECK constraints (key ones)
    const checks = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype='c' AND conrelid IN ('appointments'::regclass,'appointment_types'::regclass,'appointment_events'::regclass,'calendar_outbox'::regclass,'projection_outbox'::regclass)`
    );
    sv.checkConstraints = { count: checks.rows.length, rows: checks.rows };

    // ── Behavioral tests ──
    const bt = report.behavioralTests;

    // Seed an owner + lead for tests
    await client.query(`INSERT INTO owners (email, display_name, updated_at) VALUES ('test@ec.com','Test Owner','2020-01-01T00:00:00Z') ON CONFLICT (email) DO NOTHING`);
    const ownerRow = await client.query(`SELECT id FROM owners WHERE email='test@ec.com'`);
    const ownerId = ownerRow.rows[0].id;
    await client.query(`INSERT INTO leads (first_name, last_name, owner_id, updated_at) VALUES ('Jane','Doe',$1,'2020-01-01T00:00:00Z')`, [ownerId]);
    const leadRow = await client.query(`SELECT id FROM leads WHERE first_name='Jane' AND last_name='Doe' ORDER BY created_at DESC LIMIT 1`);
    const leadId = leadRow.rows[0].id;
    const atRow = await client.query(`SELECT id FROM appointment_types WHERE name='Consultation' LIMIT 1`);
    const apptTypeId = atRow.rows[0].id;

    // --- owners updated_at trigger (deterministic) ---
    const ownersBefore = await client.query(`SELECT updated_at FROM owners WHERE id=$1`, [ownerId]);
    await client.query(`UPDATE owners SET display_name='Test Owner Updated' WHERE id=$1`, [ownerId]);
    const ownersAfter = await client.query(`SELECT updated_at FROM owners WHERE id=$1`, [ownerId]);
    bt.ownersTriggerUpdated = {
      ok: new Date(ownersAfter.rows[0].updated_at).getTime() > new Date(ownersBefore.rows[0].updated_at).getTime(),
    };

    // --- leads updated_at trigger (deterministic) ---
    const leadsBefore = await client.query(`SELECT updated_at FROM leads WHERE id=$1`, [leadId]);
    await client.query(`UPDATE leads SET notes='trigger test' WHERE id=$1`, [leadId]);
    const leadsAfter = await client.query(`SELECT updated_at FROM leads WHERE id=$1`, [leadId]);
    bt.leadsTriggerUpdated = {
      ok: new Date(leadsAfter.rows[0].updated_at).getTime() > new Date(leadsBefore.rows[0].updated_at).getTime(),
    };

    // --- appointments updated_at trigger (deterministic) ---
    await client.query(
      `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, busy_range, status, idempotency_key, updated_at)
       VALUES ($1,$2,$3,'2026-08-15 10:00:00-07','2026-08-15 11:00:00-07',tstzrange('2026-08-15 10:00:00-07','2026-08-15 11:00:00-07'),'scheduled','appt-1','2020-01-01T00:00:00Z')`,
      [leadId, ownerId, apptTypeId]
    );
    const apptRow = await client.query(`SELECT id, updated_at FROM appointments WHERE idempotency_key='appt-1' ORDER BY created_at DESC LIMIT 1`);
    const apptId = apptRow.rows[0].id;
    const apptBeforeTs = apptRow.rows[0].updated_at;
    await client.query(`UPDATE appointments SET calendar_sync_status='synced' WHERE id=$1`, [apptId]);
    const apptAfter = await client.query(`SELECT updated_at FROM appointments WHERE id=$1`, [apptId]);
    bt.appointmentsTriggerUpdated = {
      ok: new Date(apptAfter.rows[0].updated_at).getTime() > new Date(apptBeforeTs).getTime(),
    };

    // --- EXCLUDE: overlapping active appointment must be REJECTED ---
    async function expectFailure(savepoint, sql, params) {
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await client.query(sql, params);
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { ok: false, enforced: false, error: 'constraint NOT enforced (invalid value accepted)' };
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { ok: true, enforced: true, error: e.message };
      }
    }
    async function expectSuccess(savepoint, sql, params) {
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await client.query(sql, params);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { ok: true };
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { ok: false, error: e.message };
      }
    }

    bt.excludeOverlapRejected = await expectFailure(
      'sp_overlap',
      `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, busy_range, status, idempotency_key)
       VALUES ($1,$2,$3,'2026-08-15 10:30:00-07','2026-08-15 11:30:00-07',tstzrange('2026-08-15 10:30:00-07','2026-08-15 11:30:00-07'),'scheduled','appt-overlap')`,
      [leadId, ownerId, apptTypeId]
    );

    // --- EXCLUDE: boundary-touching active appointment must be ACCEPTED ---
    bt.excludeBoundaryAccepted = await expectSuccess(
      'sp_boundary',
      `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, busy_range, status, idempotency_key)
       VALUES ($1,$2,$3,'2026-08-15 11:00:00-07','2026-08-15 12:00:00-07',tstzrange('2026-08-15 11:00:00-07','2026-08-15 12:00:00-07'),'scheduled','appt-boundary')`,
      [leadId, ownerId, apptTypeId]
    );

    // --- EXCLUDE: cancelled overlapping appointment must be ACCEPTED (WHERE excludes cancelled) ---
    bt.excludeCancelledAccepted = await expectSuccess(
      'sp_cancelled',
      `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, busy_range, status, idempotency_key)
       VALUES ($1,$2,$3,'2026-08-15 10:30:00-07','2026-08-15 11:30:00-07',tstzrange('2026-08-15 10:30:00-07','2026-08-15 11:30:00-07'),'cancelled','appt-cancelled')`,
      [leadId, ownerId, apptTypeId]
    );

    // --- appointments_no_delete trigger: physical DELETE must be REJECTED ---
    bt.appointmentsNoDelete = await expectFailure(
      'sp_no_delete',
      `DELETE FROM appointments WHERE id=$1`,
      [apptId]
    );

    // --- appointment_events immutability: INSERT a row, then UPDATE + DELETE must be REJECTED ---
    await client.query(
      `INSERT INTO appointment_events (appointment_id, actor, action) VALUES ($1,'system','created')`,
      [apptId]
    );
    const evRow = await client.query(`SELECT id FROM appointment_events WHERE appointment_id=$1 ORDER BY created_at DESC LIMIT 1`, [apptId]);
    const evId = evRow.rows[0].id;
    bt.appointmentEventsNoUpdate = await expectFailure(
      'sp_ev_update',
      `UPDATE appointment_events SET actor='other' WHERE id=$1`,
      [evId]
    );
    bt.appointmentEventsNoDelete = await expectFailure(
      'sp_ev_delete',
      `DELETE FROM appointment_events WHERE id=$1`,
      [evId]
    );

    // --- FK NO ACTION: deleting a lead that has an appointment must be REJECTED ---
    bt.fkLeadNoAction = await expectFailure(
      'sp_fk_lead',
      `DELETE FROM leads WHERE id=$1`,
      [leadId]
    );

    // --- R1A activities ON DELETE CASCADE: delete a lead with no appointments (new lead) → activities cascade-removed ---
    // Create a fresh lead + activity with no appointment, then delete the lead.
    await client.query(`INSERT INTO leads (first_name, last_name, owner_id) VALUES ('Cascade','Test',$1)`, [ownerId]);
    const cascadeLead = await client.query(`SELECT id FROM leads WHERE first_name='Cascade' AND last_name='Test' ORDER BY created_at DESC LIMIT 1`);
    const cascadeLeadId = cascadeLead.rows[0].id;
    await client.query(`INSERT INTO activities (lead_id, type, content, author) VALUES ($1,'note','cascade test','system')`, [cascadeLeadId]);
    await client.query(`DELETE FROM leads WHERE id=$1`, [cascadeLeadId]);
    const remaining = await client.query(`SELECT count(*) AS c FROM activities WHERE lead_id=$1`, [cascadeLeadId]);
    bt.activitiesCascadeDelete = { ok: Number(remaining.rows[0].c) === 0, remaining: Number(remaining.rows[0].c) };

    // ── Idempotency: re-run BOTH migrations, expect zero errors ──
    let idemErrors = 0;
    const idemDetails = [];
    for (const mp of [bookingCorePath, crmCorePath]) {
      const sql = fs.readFileSync(mp, 'utf8');
      const stmts = splitSql(sql);
      for (const stmt of stmts) {
        try {
          await client.query(stmt);
        } catch (e) {
          idemErrors++;
          idemDetails.push({ migration: path.basename(mp), preview: preview(stmt), error: e.message });
        }
      }
    }
    report.idempotency = { ok: idemErrors === 0, errorsOnRerun: idemErrors, details: idemDetails };

    // ── ROLLBACK (zero persistent changes) ──
    await client.query('ROLLBACK');
    report.summary.rollback = 'success — zero persistent changes';

    // ── Overall pass: every required validation must be true ──
    report.overallPass = !!(
      sv.createdTablesOk &&
      sv.ownersColumns?.ok &&
      sv.leadsColumns?.ok &&
      sv.appointmentsColumns?.ok &&
      sv.appointmentTypesSeed?.ok &&
      sv.indexes?.ok &&
      sv.triggers?.ok &&
      sv.foreignKeys?.ok &&
      sv.excludeConstraint?.ok &&
      bt.ownersTriggerUpdated?.ok &&
      bt.leadsTriggerUpdated?.ok &&
      bt.appointmentsTriggerUpdated?.ok &&
      bt.excludeOverlapRejected?.ok &&
      bt.excludeBoundaryAccepted?.ok &&
      bt.excludeCancelledAccepted?.ok &&
      bt.appointmentsNoDelete?.ok &&
      bt.appointmentEventsNoUpdate?.ok &&
      bt.appointmentEventsNoDelete?.ok &&
      bt.fkLeadNoAction?.ok &&
      bt.activitiesCascadeDelete?.ok &&
      report.idempotency?.ok &&
      report.idempotency?.errorsOnRerun === 0 &&
      report.summary.rollback === 'success — zero persistent changes' &&
      Array.isArray(report.errors) && report.errors.length === 0
    );
  } catch (e) {
    report.errors.push({ fatal: true, error: e.message, stack: e.stack });
    try { await client.query('ROLLBACK'); } catch (_) {}
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