/* eslint-disable no-undef */
/**
 * validateAppointmentOverride.js — DB-level validation for the 2026-12
 * appointment admin-override migration against an ISOLATED test PostgreSQL.
 *
 * Target: the nurturing-success isolated Railway test DB ONLY. NEVER production.
 *
 * Env:
 *   TEST_DATABASE_URL   connection string for the isolated test DB (REQUIRED).
 *   TEST_DATABASE_SSL   'false' to disable SSL (default: SSL on, like db/client).
 *   RAILWAY_JWT_SECRET  optional; a local test secret is used if absent, so the
 *                       sign+verify of the test admin/non-admin JWTs that exercise
 *                       authorizeOverride's logic work without the prod secret.
 *
 * What it does:
 *   1. Applies db/migrations/2026-12-appointment-override.sql (idempotent).
 *   2. Verifies override_conflict column + extended-predicate EXCLUDE constraint.
 *   3. Runs tests A–I via the REAL bookingService.createBooking + captureOverrideAuth.
 *   4. Verifies rollback readiness (down.sql) inside a ROLLBACK-only transaction.
 *   5. Non-destructive cleanup: cancels active test appointments (allowed UPDATE),
 *      deletes only legally-deletable rows (outbox/mapping/idempotency), and
 *      REPORTS the immutable rows retained by schema design. No triggers are
 *      disabled or bypassed.
 *
 * The functional pass/fail (report.passed) is independent of cleanup status:
 * immutable audit rows retained by the schema never mark functional tests failed.
 *
 * No production deploy. No Base44 publish. No Google Calendar / availability
 * endpoint changes. No production schema/behavior changes — this is a test
 * harness only.
 */
'use strict';

// ── Wire the DB URL BEFORE requiring db/client (Pool reads it at load) ──────
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) {
  console.error(JSON.stringify({
    status: 'config_error',
    message: 'TEST_DATABASE_URL not set — provide the nurturing-success isolated test DB connection string.',
  }));
  process.exit(2);
}
process.env.DATABASE_URL = TEST_URL;
if (process.env.TEST_DATABASE_SSL === 'false') process.env.DATABASE_SSL = 'false';
if (!process.env.RAILWAY_JWT_SECRET) {
  process.env.RAILWAY_JWT_SECRET = 'validation-only-test-secret-32chars-minimum-ok';
}

const fs = require('fs');
const path = require('path');
const { pool, ensureSchema } = require('../db/client');
const { createBooking, BookingError } = require('../lib/booking/bookingService');
const { authorizeOverride } = require('../lib/captureOverrideAuth');
const { signJWT } = require('../lib/crypto');

const RUN_ID = String(Date.now());
const MARK = `valovr-${RUN_ID}`;
const MIGRATION_PATH = path.join(__dirname, '..', 'db', 'migrations', '2026-12-appointment-override.sql');
const DOWN_PATH = path.join(__dirname, '..', 'db', 'rollback', '2026-12-appointment-override.down.sql');

const report = {
  run_id: RUN_ID,
  test_environment: { project: 'nurturing-success (per operator)', db_url: TEST_URL.replace(/:[^:@]+@/, ':***@') },
  migration: {},
  schema_verification: {},
  tests: {},
  idempotency: {},
  overlap_protection: {},
  rollback_readiness: {},
  cleanup: {},
  passed: true, // functional tests only — independent of cleanup status
  failures: [],
};

function check(name, cond, detail) {
  if (cond) {
    report.tests[name] = { result: 'pass', detail: detail || undefined };
  } else {
    report.tests[name] = { result: 'fail', detail: detail || undefined };
    report.passed = false;
    report.failures.push(name);
  }
}

// Deterministic, unique phone per tag so the idempotency request hash is stable
// across retries of the SAME tag (E vs G) and lead dedup never false-matches.
function phoneFor(tag) {
  const h = tag.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 10000;
  return `+1555${RUN_ID.slice(-6)}${String(h).padStart(4, '0')}`;
}

// Fixed UTC test times (far future, no DST ambiguity). Blocker 10:00–11:00.
const DAY = '2026-09-15';
const BLOCKER = `${DAY}T10:00:00.000Z`;    // 10:00–11:00, busy [09:00,12:00)
const A_FREE  = `${DAY}T18:00:00.000Z`;    // clearly outside every buffer
const B_CONFLICT = BLOCKER;               // overlaps blocker
const E_OVERRIDE = BLOCKER;               // override into the same blocked slot
const H_CONFLICT = `${DAY}T10:30:00.000Z`; // overlaps blocker
const I_BEFORE = `${DAY}T08:00:00.000Z`;   // within 1hr-before buffer
const I_AFTER  = `${DAY}T11:00:00.000Z`;   // within 1hr-after buffer
const I_FREE   = `${DAY}T13:00:00.000Z`;   // first free slot after buffer

async function main() {
  // ── 1. Ensure base schema, then apply the migration ───────────────────────
  // The migration ALTERs the appointments table; the table must exist first.
  // ensureSchema() runs db/schema.sql idempotently (CREATE IF NOT EXISTS) so a
  // fresh test DB is bootstrapped; on a pre-provisioned DB it is a no-op. It
  // runs against the TEST pool (DATABASE_URL was wired to TEST_DATABASE_URL
  // above before this module loaded db/client).
  await ensureSchema();
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  try {
    await pool.query(migrationSql);
    report.migration = { applied: true, file: '2026-12-appointment-override.sql' };
  } catch (e) {
    report.migration = { applied: false, error: e.message };
    report.passed = false; report.failures.push('migration');
    return finish();
  }

  // ── 2. Schema verification ───────────────────────────────────────────────
  const col = (await pool.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_name='appointments' AND column_name='override_conflict'`)).rows[0];
  report.schema_verification.column = col || null;
  check('schema:override_conflict_column',
    col && col.data_type === 'boolean' && col.is_nullable === 'NO' && /false/i.test(col.column_default || ''),
    col ? `${col.data_type} nullable=${col.is_nullable} default=${col.column_default}` : 'column missing');

  const con = (await pool.query(
    `SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='appointments_no_active_overlap'`)).rows[0];
  report.schema_verification.constraint = con ? con.def : null;
  // pg_get_constraintdef may render `status IN (...)` as `= ANY (ARRAY[...])`;
  // check for the key tokens instead of an exact syntactic match.
  check('schema:extended_predicate',
    !!con && /NOT override_conflict/i.test(con.def) && /scheduled/i.test(con.def) && /confirmed/i.test(con.def),
    con ? con.def : 'constraint missing');

  // ── Stale-run cleanup: cancel active valovr-* appointments from prior
  //    crashed runs that overlap the fixed test day. Fixed test times mean a
  //    prior run's active appointment at the same slot would block the current
  //    run's blocker booking (false slot_conflict). Cancellation is the
  //    permitted normal behavior (status UPDATE; appointments_no_delete only
  //    blocks DELETE). Scoped to valovr-* leads only; no unrelated records.
  //    Also deletes those stale rows' calendar/projection outbox so no worker
  //    can sync stale test data. Reports exactly what was cancelled.
  const staleDayStart = `${DAY}T00:00:00.000Z`;
  const staleDayEnd = `${DAY}T23:59:59.999Z`;
  const staleRes = await pool.query(
    `SELECT a.id AS appt_id, a.status, a.start_at, l.id AS lead_id, l.external_ref
     FROM appointments a
     JOIN leads l ON a.lead_id = l.id
     WHERE l.external_ref LIKE 'valovr-%'
       AND a.status IN ('scheduled','confirmed')
       AND a.busy_range && tstzrange($1, $2, '[)')`,
    [staleDayStart, staleDayEnd]
  );
  if (staleRes.rows.length) {
    const staleApptIds = staleRes.rows.map(r => r.appt_id);
    const staleLeadIds = [...new Set(staleRes.rows.map(r => r.lead_id))];
    const cancelRes = await pool.query(
      `UPDATE appointments SET status = 'cancelled', updated_at = NOW()
       WHERE id = ANY($1::uuid[]) AND status IN ('scheduled','confirmed')`,
      [staleApptIds]
    );
    await pool.query('DELETE FROM calendar_outbox WHERE appointment_id = ANY($1::uuid[])', [staleApptIds]);
    await pool.query('DELETE FROM projection_outbox WHERE lead_id = ANY($1::uuid[])', [staleLeadIds]);
    report.stale_run_cleanup = {
      found: staleRes.rows.length,
      cancelled_count: cancelRes.rowCount,
      cancelled_appt_ids: staleApptIds,
      refs: staleRes.rows.map(r => r.external_ref),
      outbox_deleted: true,
    };
  } else {
    report.stale_run_cleanup = { found: 0, cancelled_count: 0 };
  }

  // ── Setup: test owner + appointment type ──────────────────────────────────
  const ownerEmail = `${MARK}@test.local`;
  const typeName = `Validation Consultation ${RUN_ID}`;
  await pool.query('INSERT INTO owners (email, display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ownerEmail, 'Validation Owner']);
  const ownerId = (await pool.query('SELECT id FROM owners WHERE lower(email)=lower($1)', [ownerEmail])).rows[0].id;
  const typeId = (await pool.query(
    `INSERT INTO appointment_types (name, default_duration_minutes, is_active) VALUES ($1,60,true) RETURNING id`, [typeName])).rows[0].id;

  let blockerApptId = null;
  let overrideLeadId = null, overrideApptId = null;
  const ctx = { ownerId, typeId };

  async function bookingInput(tag, start, extra = {}) {
    return {
      idempotency_key: `${MARK}-${tag}`,
      owner_email: ownerEmail,
      first_name: 'Val', last_name: tag,
      email: `${MARK}-${tag}@validate-override.test`,
      phone: phoneFor(tag),
      property_address: '1 Validation Way', city: 'Los Angeles',
      project_type: 'Validation', source: 'Validation',
      appointment_type_id: typeId, start_at: start,
      timezone: 'America/Los_Angeles', actor: 'validation-script',
      external_ref: `${MARK}-${tag}`,
      ...extra,
    };
  }
  async function tryBooking(input) {
    try {
      const r = await createBooking(input);
      // Defense-in-depth: immediately delete the calendar/projection outbox rows
      // this booking enqueued, so no concurrent outbox worker can drain them to
      // Google Calendar / Base44 during the validation run. Harness-only; does
      // not alter the appointment/lead/event rows the tests inspect.
      if (r.appointment && r.appointment.id) {
        await pool.query('DELETE FROM calendar_outbox WHERE appointment_id = $1', [r.appointment.id]);
      }
      if (r.lead && r.lead.id) {
        await pool.query('DELETE FROM projection_outbox WHERE lead_id = $1', [r.lead.id]);
      }
      return { ok: true, idempotent: !!r.idempotent, leadId: r.lead && r.lead.id, apptId: r.appointment && r.appointment.id };
    } catch (e) {
      if (e instanceof BookingError) return { ok: false, code: e.code, status: e.status, message: e.message };
      return { ok: false, code: 'throw', message: e.message };
    }
  }

  // ── A. Normal booking into an available slot → success ────────────────────
  const A = await tryBooking(await bookingInput('A', A_FREE));
  check('A:normal_available_succeeds', A.ok, A);

  // ── Blocker: a normal booking that creates the blocked slot ───────────────
  const BLK = await tryBooking(await bookingInput('BLK', BLOCKER));
  if (!BLK.ok) { check('setup:blocker_created', false, BLK); return finish(ctx); }
  blockerApptId = BLK.apptId;
  ctx.blockerApptId = blockerApptId;
  check('setup:blocker_created', true, { blockerApptId });

  // ── B. Normal booking into the blocked slot → 409 slot_conflict ───────────
  const B = await tryBooking(await bookingInput('B', B_CONFLICT));
  check('B:normal_blocked_409', !B.ok && B.code === 'slot_conflict', B);

  // ── C. Override request without JWT → 403 override_forbidden ─────────────
  // captureOverrideAuth.authorizeOverride(authHeader, _verify?) expects the
  // raw Authorization header string (or null/undefined) — NOT an object.
  const C = authorizeOverride(null);
  check('C:override_no_jwt_403', !C.ok && C.code === 'override_forbidden', C);

  // ── D. Override request with non-admin JWT → 403 override_forbidden ──────
  const nonAdminToken = signJWT({ sub: 'rep', email: 'rep@ecconstructiongroup.com', role: 'sales_rep', full_name: 'Rep' }, 300);
  const D = authorizeOverride(`Bearer ${nonAdminToken}`);
  check('D:override_nonadmin_403', !D.ok && D.code === 'override_forbidden', D);

  // ── E. Authorized Yaron admin override into the same blocked slot ────────
  const adminToken = signJWT({ sub: 'yaron', email: 'yaron@ecconstructiongroup.com', role: 'admin', full_name: 'Yaron Drilevich' }, 300);
  const Eauth = authorizeOverride(`Bearer ${adminToken}`);
  check('E:override_admin_authorized', Eauth.ok && Eauth.user && Eauth.user.email === 'yaron@ecconstructiongroup.com', Eauth);

  const E = await tryBooking(await bookingInput('E', E_OVERRIDE, { override_conflict: true, override_actor: 'yaron@ecconstructiongroup.com' }));
  check('E:override_booking_succeeds', E.ok, E);
  if (E.ok) { overrideLeadId = E.leadId; overrideApptId = E.apptId; ctx.overrideLeadId = overrideLeadId; ctx.overrideApptId = overrideApptId; }

  // ── F. Verify the override created exactly one lead + one appointment ─────
  if (E.ok) {
    const appt = (await pool.query('SELECT override_conflict, status, lead_id FROM appointments WHERE id=$1', [overrideApptId])).rows[0];
    check('F:override_conflict_true', appt && appt.override_conflict === true, appt);

    // The original (blocker) appointment must remain intact and fully
    // protected — override coexists, it never mutates the existing row.
    const blocker = blockerApptId
      ? (await pool.query('SELECT status, override_conflict FROM appointments WHERE id=$1', [blockerApptId])).rows[0]
      : null;
    check('F:original_appointment_intact',
      blocker && blocker.status === 'scheduled' && blocker.override_conflict === false, blocker);

    const leadCount = (await pool.query('SELECT count(*)::int n FROM leads WHERE external_ref=$1', [`${MARK}-E`])).rows[0].n;
    const apptCount = (await pool.query('SELECT count(*)::int n FROM appointments WHERE lead_id=$1', [overrideLeadId])).rows[0].n;
    check('F:exactly_one_lead_one_appointment', leadCount === 1 && apptCount === 1, { leadCount, apptCount });

    const ev = (await pool.query(
      `SELECT new_values FROM appointment_events WHERE appointment_id=$1 AND action='created'`, [overrideApptId])).rows[0];
    // new_values is JSONB → node-postgres returns it already parsed as a JS object.
    // Handle both object and string forms defensively.
    let nv = null;
    try {
      nv = (ev && typeof ev.new_values === 'string') ? JSON.parse(ev.new_values || '{}') : (ev && ev.new_values) || {};
    } catch (e) { nv = { parseError: String(e.message) }; }
    check('F:audit_identifies_admin',
      nv && nv.override_conflict === true && nv.override_actor === 'yaron@ecconstructiongroup.com',
      nv);
  }

  // ── G. Retry the same override/idempotency request → no duplicate ─────────
  const G = await tryBooking(await bookingInput('E', E_OVERRIDE, { override_conflict: true, override_actor: 'yaron@ecconstructiongroup.com' }));
  const gLeadCount = overrideLeadId ? (await pool.query('SELECT count(*)::int n FROM leads WHERE external_ref=$1', [`${MARK}-E`])).rows[0].n : null;
  const gApptCount = overrideLeadId ? (await pool.query('SELECT count(*)::int n FROM appointments WHERE lead_id=$1', [overrideLeadId])).rows[0].n : null;
  check('G:idempotent_retry_no_duplicate',
    G.ok && G.idempotent === true && G.leadId === overrideLeadId && G.apptId === overrideApptId && gLeadCount === 1 && gApptCount === 1,
    { G, gLeadCount, gApptCount });
  report.idempotency = {
    retry_returned_same_lead: G.leadId === overrideLeadId,
    retry_returned_same_appt: G.apptId === overrideApptId,
    lead_count: gLeadCount, appt_count: gApptCount,
  };

  // ── H. Another normal concurrent booking still cannot overlap → 409 ───────
  const H = await tryBooking(await bookingInput('H', H_CONFLICT));
  check('H:normal_concurrent_409', !H.ok && H.code === 'slot_conflict', H);

  // ── I. Verify the 1hr-before + duration + 1hr-after buffer remains ────────
  const blk = (await pool.query('SELECT lower(busy_range) lo, upper(busy_range) hi FROM appointments WHERE id=$1', [blockerApptId])).rows[0];
  const buf = blk ? { lo: new Date(blk.lo).toISOString(), hi: new Date(blk.hi).toISOString() } : null;
  const bufOk = buf && buf.lo === `${DAY}T09:00:00.000Z` && buf.hi === `${DAY}T12:00:00.000Z`;
  check('I:buffer_range_1hr_before_after', bufOk, buf);

  const Ibefore = await tryBooking(await bookingInput('Ib', I_BEFORE));
  check('I:normal_before_buffer_409', !Ibefore.ok && Ibefore.code === 'slot_conflict', Ibefore);
  const Iafter = await tryBooking(await bookingInput('Ia', I_AFTER));
  check('I:normal_after_buffer_409', !Iafter.ok && Iafter.code === 'slot_conflict', Iafter);
  const Ifree = await tryBooking(await bookingInput('If', I_FREE));
  check('I:normal_outside_buffer_succeeds', Ifree.ok, Ifree);
  report.overlap_protection = {
    buffer_range: buf,
    before_buffer_blocked: !Ibefore.ok,
    after_buffer_blocked: !Iafter.ok,
    outside_buffer_allowed: Ifree.ok,
  };

  // ── 4. Rollback readiness (down.sql) — ROLLBACK only, never committed ─────
  const downSql = fs.readFileSync(DOWN_PATH, 'utf8');

  // (a) Guard: with an active override row present, restoring the strict
  //     original constraint (no exemption) must FAIL — the overlapping
  //     override+blocker pair violates it.
  let guardBlocked = false, guardErr = null;
  const c1 = await pool.connect();
  try {
    await c1.query('BEGIN');
    await c1.query(downSql);
    await c1.query('COMMIT');
  } catch (e) {
    guardBlocked = true; guardErr = e.message;
    try { await c1.query('ROLLBACK'); } catch (_) {}
  } finally { c1.release(); }
  check('rollback:guard_refuses_with_override_rows', guardBlocked, guardErr);

  // (b) Clean path: after neutralizing the override (cancel → excluded from the
  //     active predicate), the original constraint ADD succeeds. Then ROLLBACK
  //     so nothing persists. We CANNOT physically DELETE the override — the
  //     appointments_no_delete trigger blocks it — so we cancel it instead,
  //     which removes it from the active EXCLUDE predicate identically.
  let cleanOk = false, cleanErr = null;
  const c2 = await pool.connect();
  try {
    await c2.query('BEGIN');
    await c2.query('UPDATE appointments SET status=$1 WHERE id=$2', ['cancelled', overrideApptId]);
    await c2.query(downSql);
    cleanOk = true;
    await c2.query('ROLLBACK');
  } catch (e) {
    cleanErr = e.message;
    try { await c2.query('ROLLBACK'); } catch (_) {}
  } finally { c2.release(); }
  check('rollback:clean_path_succeeds_after_neutralizing_override', cleanOk, cleanErr);
  report.rollback_readiness = {
    guard_refused_while_override_active: guardBlocked,
    clean_path_succeeds_after_cancel: cleanOk,
  };

  return finish(ctx);
}

async function finish(ctx = {}) {
  // ── 5. Non-destructive cleanup (NO trigger disabling) ─────────────────────
  // The schema intentionally makes appointments and appointment_events
  // immutable (appointments_no_delete / appointment_events_no_update triggers)
  // and FK-locks leads/owners/appointment_types behind the retained
  // appointments. We do NOT bypass any of those guards. Instead:
  //   • Cancel active test appointments via the allowed UPDATE path so they
  //     no longer block availability / the active EXCLUDE constraint.
  //   • Delete only rows that are legally deletable without disabling triggers
  //     or violating FKs: calendar_outbox, projection_outbox,
  //     base44_entity_map, booking_idempotency (nothing references them; they
  //     have no immutability triggers). Deleting the outbox rows also prevents
  //     a worker from syncing test data to Google Calendar / Base44.
  //   • Report exactly which immutable rows remain, keyed by the RUN_ID marker.
  // report.passed (functional) is independent of cleanup status: retained
  // immutable rows never mark functional tests as failed.
  let cleanupOk = true, cleanupError = null;
  const deleted = {};

  // Phase 1 — cancel + delete deletable rows in one transaction.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const leadIds = (await c.query(`SELECT id FROM leads WHERE external_ref LIKE $1`, [`${MARK}-%`])).rows.map(r => r.id);
    const apptIds = (await c.query(`SELECT id FROM appointments WHERE lead_id = ANY($1::uuid[])`, [leadIds])).rows.map(r => r.id);

    if (apptIds.length) {
      const cancelRes = await c.query(
        `UPDATE appointments SET status='cancelled'
         WHERE id = ANY($1::uuid[]) AND status IN ('scheduled','confirmed')`,
        [apptIds]
      );
      deleted.appointments_cancelled = cancelRes.rowCount;
      deleted.calendar_outbox = (await c.query('DELETE FROM calendar_outbox WHERE appointment_id = ANY($1::uuid[])', [apptIds])).rowCount;
    }
    if (leadIds.length) {
      deleted.projection_outbox = (await c.query('DELETE FROM projection_outbox WHERE lead_id = ANY($1::uuid[])', [leadIds])).rowCount;
      deleted.base44_entity_map = (await c.query('DELETE FROM base44_entity_map WHERE railway_lead_id = ANY($1::uuid[])', [leadIds])).rowCount;
    }
    deleted.booking_idempotency = (await c.query('DELETE FROM booking_idempotency WHERE idempotency_key LIKE $1', [`${MARK}-%`])).rowCount;

    await c.query('COMMIT');
  } catch (e) {
    cleanupError = e.message;
    cleanupOk = false;
    try { await c.query('ROLLBACK'); } catch (_) {}
  } finally {
    c.release();
  }

  // Phase 2 — report final retained counts (read-only, after cleanup).
  const retained = {};
  try {
    const leadIds = (await pool.query(`SELECT id FROM leads WHERE external_ref LIKE $1`, [`${MARK}-%`])).rows.map(r => r.id);
    const apptIds = leadIds.length
      ? (await pool.query(`SELECT id FROM appointments WHERE lead_id = ANY($1::uuid[])`, [leadIds])).rows.map(r => r.id)
      : [];
    retained.leads = leadIds.length;
    retained.appointments = apptIds.length;
    retained.appointment_events = apptIds.length
      ? (await pool.query(`SELECT count(*)::int n FROM appointment_events WHERE appointment_id = ANY($1::uuid[])`, [apptIds])).rows[0].n
      : 0;
    retained.owners = ctx.ownerId
      ? (await pool.query('SELECT count(*)::int n FROM owners WHERE id=$1', [ctx.ownerId])).rows[0].n
      : 0;
    retained.appointment_types = ctx.typeId
      ? (await pool.query('SELECT count(*)::int n FROM appointment_types WHERE id=$1', [ctx.typeId])).rows[0].n
      : 0;
  } catch (e) {
    retained.error = e.message;
  }

  await pool.end();

  report.cleanup = {
    status: cleanupOk ? 'completed' : 'partial',
    deleted,
    retained_by_schema_design: retained,
    marker: MARK,
    triggers_disabled: false,
    note: 'Appointments are cancelled (not deleted — appointments_no_delete trigger). appointment_events are immutable (appointment_events_no_update trigger). leads, owners, and appointment_types are retained because FKs from the retained (cancelled) appointments prevent their deletion. No triggers were disabled or bypassed. This is expected on the isolated test DB and does NOT affect functional test results.',
    error: cleanupError,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

main().catch(async (e) => {
  report.fatal = e.message;
  report.passed = false;
  // Best-effort non-destructive cleanup of any test rows created before the
  // fatal, so a crashed run does not leave active appointments that block a
  // re-run (test times are fixed). finish() finds rows by marker, not by ctx.
  await finish({});
});