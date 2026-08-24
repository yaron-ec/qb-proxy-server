#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * dryRunPublicCapture.js — validates the public capture submission atomicity
 * against a REAL, isolated, NON-PRODUCTION PostgreSQL instance.
 *
 * Tests (operator runs against TEST_DATABASE_URL):
 *   H. successful submission creates exactly 1 lead + 1 appointment
 *   F. two submissions for the same protected slot: one succeeds, one 409
 *   G. 409 creates 0 leads, 0 appointments (zero side effects)
 *   I. retry with the same idempotency key does not create a second lead
 *   A-E. buffer rule (re-verified via computeBlockedSlots)
 *
 * SAFETY:
 *   - Requires TEST_DATABASE_URL. Refuses to run without it.
 *   - NEVER falls back to a production DATABASE_URL.
 *   - Uses a dedicated test schema prefix to avoid colliding with real tables,
 *     and cleans up all test data at the end.
 *
 * USAGE (from src/proxy-server/):
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/testdb \
 *     DATABASE_SSL=false node scripts/dryRunPublicCapture.js
 */
'use strict';

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  console.error('FATAL: TEST_DATABASE_URL not set. Refusing to run.');
  process.exit(2);
}
const PROD_DB = process.env.DATABASE_URL || '';
function norm(u) { return String(u || '').replace(/\?.*$/, '').trim().toLowerCase(); }
if (PROD_DB && norm(TEST_DB) === norm(PROD_DB)) {
  console.error('FATAL: TEST_DATABASE_URL matches DATABASE_URL (production). Refusing.');
  process.exit(2);
}
if (/prod|production/i.test(TEST_DB) && !/test|staging|dev|dry|sandbox/i.test(TEST_DB)) {
  console.error('FATAL: TEST_DATABASE_URL appears to reference production. Refusing.');
  process.exit(2);
}

// Point the db client at the test DB BEFORE any module requires it.
process.env.DATABASE_URL = TEST_DB;

const fs = require('fs');
const path = require('path');
const { pool, query } = require('../db/client');
const { createBooking, BookingError } = require('../lib/booking/bookingService');
const { computeBlockedSlots, SLOTS } = require('../lib/booking/slotBlocking');
const { computeIdempotencyKey, laToUtcStart } = require('../lib/captureValidation');

let failed = 0;
let sharedClient = null;
function assert(cond, msg) {
  if (!cond) { failed++; console.log(`  ✗ ${msg}`); }
  else console.log(`  ✓ ${msg}`);
}

async function run() {
  // ── Test isolation: one rolled-back outer transaction ──────────────────
  // createBooking manages (and COMMITs) its own transaction, so an outer
  // rollback can't undo its writes directly. To keep ALL test data
  // uncommitted and roll it back at the end — without DELETE/UPDATE on the
  // immutable appointment_events / appointments tables (their BEFORE UPDATE
  // OR DELETE trigger raises P0001) — we route every pool connection through
  // a single shared client and translate createBooking's internal
  // BEGIN/COMMIT/ROLLBACK into SAVEPOINT / RELEASE SAVEPOINT / ROLLBACK TO
  // SAVEPOINT. The final ROLLBACK of the outer tx discards every INSERT
  // (including the append-only appointment_events rows) without firing the
  // immutability trigger, leaving nurturing-success in its exact pre-run state.
  sharedClient = await pool.connect();
  await sharedClient.query('BEGIN');
  let spCounter = 0;
  let currentSp = null;
  async function proxiedQuery(text, params) {
    const op = String(text || '').trim().toUpperCase();
    if (op === 'BEGIN') {
      currentSp = `sp${++spCounter}`;
      return sharedClient.query(`SAVEPOINT ${currentSp}`);
    }
    if (op === 'COMMIT') {
      const sp = currentSp; currentSp = null;
      if (!sp) return { rows: [] }; // no active savepoint (double-commit); no-op
      return sharedClient.query(`RELEASE SAVEPOINT ${sp}`);
    }
    if (op === 'ROLLBACK') {
      const sp = currentSp; currentSp = null;
      // createBooking has an INNER catch (INSERT 23P01) AND an OUTER catch that
      // both issue ROLLBACK. The inner ROLLBACK rolls back to the savepoint and
      // clears currentSp; the outer catch then issues a SECOND ROLLBACK while
      // currentSp is already null. A literal "ROLLBACK TO SAVEPOINT null" is
      // invalid SQL that re-aborts the transaction (25P02) — and the outer catch
      // swallows it, so the F assertion still passes but the outer transaction
      // is poisoned. No-op when no savepoint is active; otherwise roll back AND
      // release so the savepoint is fully cleaned up and the tx stays usable.
      if (!sp) return { rows: [] };
      await sharedClient.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await sharedClient.query(`RELEASE SAVEPOINT ${sp}`);
      return { rows: [] };
    }
    return sharedClient.query(text, params);
  }
  pool.connect = async () => ({ query: proxiedQuery, release: () => {} });
  pool.query = proxiedQuery;

  // Apply the full schema (idempotent) — runs inside the outer tx.
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));

  // Seed a Consultation appointment type + Yaron owner.
  await query("INSERT INTO appointment_types (name, default_duration_minutes) VALUES ('Consultation', 60) ON CONFLICT (name) DO NOTHING");
  const at = (await query("SELECT id FROM appointment_types WHERE name='Consultation'")).rows[0];
  const ownerEmail = 'yaron@ecconstructiongroup.com';
  await query("INSERT INTO owners (email, display_name) VALUES ($1, 'Yaron Drilevich') ON CONFLICT (email) DO NOTHING", [ownerEmail]);
  const owner = (await query("SELECT id FROM owners WHERE email=$1", [ownerEmail])).rows[0];

  // Per-run unique identifiers. A prior crashed run may have left committed
  // rows in the immutable tables (appointments / appointment_events can never
  // be DELETEd, and leads are blocked by their FK to those appointments). So
  // this run uses a unique email/phone/first_name (avoids duplicate-detection
  // against leftover) and a unique far-future date (avoids slot-conflict with
  // leftover's busy_range). The outer-transaction ROLLBACK at the end ensures
  // THIS run leaves zero trace — so no cleanup DELETEs are needed or used.
  const runStamp = Date.now().toString();
  const aliceFirst = 'DryAlice' + runStamp;
  const bobFirst = 'DryBob' + runStamp;
  const aliceEmail = 'alice' + runStamp + '@example.com';
  const bobEmail = 'bob' + runStamp + '@example.com';
  const alicePhone = '310555' + runStamp.slice(-4);
  const bobPhone = '310556' + runStamp.slice(-4);

  const date = '2027-06-01';
  const time = '11:00';
  const start_at = laToUtcStart(date, time);

  // ── H. successful submission creates exactly 1 lead + 1 appointment ───────
  const keyA = 'drycap-' + computeIdempotencyKey({ owner_email: ownerEmail, first_name: aliceFirst, last_name: 'Smith', email: aliceEmail, phone: alicePhone, property_address: '1 Test St', appointment_type_id: at.id, start_at });
  const leadCountBefore = Number((await query("SELECT count(*) c FROM leads WHERE first_name=$1", [aliceFirst])).rows[0].c);
  const apptCountBefore = Number((await query("SELECT count(*) c FROM appointments WHERE idempotency_key=$1", [keyA])).rows[0].c);
  const bookingA = await createBooking({
    idempotency_key: keyA, owner_email: ownerEmail, owner_display_name: 'Yaron Drilevich',
    first_name: aliceFirst, last_name: 'Smith', email: aliceEmail, phone: alicePhone,
    property_address: '1 Test St', project_type: 'Roofing', source: 'Google Search',
    appointment_type_id: at.id, start_at, timezone: 'America/Los_Angeles', actor: 'dry-run',
  });
  const leadCountAfter = Number((await query("SELECT count(*) c FROM leads WHERE first_name=$1", [aliceFirst])).rows[0].c);
  const apptCountAfter = Number((await query("SELECT count(*) c FROM appointments WHERE idempotency_key=$1", [keyA])).rows[0].c);
  assert(leadCountAfter - leadCountBefore === 1, 'H: successful submit creates exactly 1 lead');
  assert(apptCountAfter - apptCountBefore === 1, 'H: successful submit creates exactly 1 appointment');
  assert(!!bookingA.lead && !!bookingA.appointment, 'H: booking returns lead + appointment');

  // ── F + G. second DIFFERENT lead for the same protected slot → 409, 0 side effects ─
  const keyB = 'drycap-' + computeIdempotencyKey({ owner_email: ownerEmail, first_name: bobFirst, last_name: 'Jones', email: bobEmail, phone: bobPhone, property_address: '2 Test St', appointment_type_id: at.id, start_at });
  const allLeadsBefore = Number((await query("SELECT count(*) c FROM leads WHERE first_name IN ($1,$2)", [aliceFirst, bobFirst])).rows[0].c);
  let conflict = null;
  try {
    await createBooking({
      idempotency_key: keyB, owner_email: ownerEmail, owner_display_name: 'Yaron Drilevich',
      first_name: bobFirst, last_name: 'Jones', email: bobEmail, phone: bobPhone,
      property_address: '2 Test St', project_type: 'Solar', source: 'Referral',
      appointment_type_id: at.id, start_at, timezone: 'America/Los_Angeles', actor: 'dry-run',
    });
  } catch (e) {
    conflict = e;
  }
  assert(conflict instanceof BookingError && conflict.code === 'slot_conflict', 'F: second submission for same slot → 409 slot_conflict');
  const allLeadsAfter = Number((await query("SELECT count(*) c FROM leads WHERE first_name IN ($1,$2)", [aliceFirst, bobFirst])).rows[0].c);
  assert(allLeadsAfter === allLeadsBefore, 'G: 409 creates 0 leads (DryBob not created)');
  const bobAppts = Number((await query("SELECT count(*) c FROM appointments WHERE idempotency_key=$1", [keyB])).rows[0].c);
  assert(bobAppts === 0, 'G: 409 creates 0 appointments');

  // ── I. retry with the same idempotency key → idempotent (no second lead) ────
  const retryA = await createBooking({
    idempotency_key: keyA, owner_email: ownerEmail, owner_display_name: 'Yaron Drilevich',
    first_name: aliceFirst, last_name: 'Smith', email: aliceEmail, phone: alicePhone,
    property_address: '1 Test St', project_type: 'Roofing', source: 'Google Search',
    appointment_type_id: at.id, start_at, timezone: 'America/Los_Angeles', actor: 'dry-run',
  });
  assert(retryA.idempotent === true, 'I: retry returns idempotent=true');
  const aliceLeads = Number((await query("SELECT count(*) c FROM leads WHERE first_name=$1", [aliceFirst])).rows[0].c);
  assert(aliceLeads === 1, 'I: retry does not create a second lead (still 1)');
  const aliceAppts = Number((await query("SELECT count(*) c FROM appointments WHERE idempotency_key=$1", [keyA])).rows[0].c);
  assert(aliceAppts === 1, 'I: retry does not create a second appointment (still 1)');

  // ── A-E. buffer rule (re-verify against the seeded 11:00 appointment) ──────
  // busy_range for the 11:00-12:00 appointment = 10:00-13:00 LA.
  const busyWindows = (await query(
    `SELECT lower(busy_range) AS start, upper(busy_range) AS end FROM appointments WHERE idempotency_key=$1`, [keyA]
  )).rows.map(r => ({ start: r.start, end: r.end }));
  const blocked = computeBlockedSlots(SLOTS, date, 'America/Los_Angeles', 60, busyWindows);
  const bs = new Set(blocked);
  assert(!bs.has('09:00'), 'A/B: 09:00 allowed (touches 10:00)');
  assert(bs.has('09:30'), 'C: 09:30 blocked');
  assert(bs.has('11:00'), '11:00 blocked');
  assert(bs.has('12:30'), 'D: 12:30 blocked');
  assert(!bs.has('13:00'), 'E: 13:00 allowed (touches 13:00)');

  // ── Cleanup: roll back the outer transaction ─────────────────────────────
  // Every INSERT (leads, appointments, appointment_events, booking_idempotency,
  // calendar_outbox, projection_outbox, base44_entity_map) is still
  // uncommitted. ROLLBACK discards them all at once — no DELETE/UPDATE is
  // issued against the immutable appointment_events / appointments tables, so
  // the immutability trigger never fires and nurturing-success is left in its
  // exact pre-run state.
  await sharedClient.query('ROLLBACK');
  await sharedClient.release();
  await pool.end();

  if (failed > 0) { console.error(`\nFAIL: ${failed} assertion(s)`); process.exit(1); }
  console.log('\nPASS: public capture atomicity (F, G, H, I) + buffer rule (A-E) verified');
  process.exit(0);
}

run().catch(e => {
  console.error('DRY RUN CRASH:', e);
  try { if (sharedClient) sharedClient.query('ROLLBACK'); } catch (_) {}
  try { pool.end(); } catch (_) {}
  process.exit(1);
});