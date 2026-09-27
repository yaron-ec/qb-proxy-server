/* eslint-disable no-undef */
'use strict';

/**
 * auditTravelArtifacts.int.test.js — REAL-Postgres proof of the invalid
 * Driving / Travel Time cleanup (scripts/auditTravelArtifacts.js). Skipped
 * without TEST_DATABASE_URL.
 *
 * Seeds every shape the classifier distinguishes and runs the real script as a
 * separate process: report → confirm-host guard → apply → idempotent re-run.
 * Proves that ONLY provably invalid, upcoming travel artifacts get a
 * cancel_travel queued (never a row deleted, never Google called directly), and
 * that real Site Visit travel — active or historical — and ambiguous migrated
 * rows are left untouched. Google-side classification is exercised in-process.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db, ownerId, typeId;
const RUN = `t${Date.now().toString(36)}`;
const ids = {};

function audit(extra = []) {
  const out = execFileSync(process.execPath, ['scripts/auditTravelArtifacts.js', '--json', '--no-google', ...extra],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return JSON.parse(out.slice(out.indexOf('{')));
}
const ours = (report) => report.records.filter(r => Object.values(ids).includes(r.appointment_id));
const clsOf = (report, key) => ours(report).filter(r => r.appointment_id === ids[key]).map(r => r.class).sort();

async function lead(key) {
  const r = await db.query(`INSERT INTO leads (first_name, last_name, owner_id, status) VALUES ($1, $2, $3, 'New') RETURNING id`, [key, RUN, ownerId]);
  return r.rows[0].id;
}
// days: offset from now; buffered: Site Visit shape; key: idempotency key override
async function appt(key, { days, buffered, status = 'scheduled', travel = true, type = 'Consultation', idem }) {
  const l = await lead(key);
  const r = await db.query(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                               idempotency_key, calendar_sync_status, google_event_id, google_travel_event_id, override_conflict)
     VALUES ($1, $2, $3, date_trunc('hour', NOW()) + make_interval(days => $4), date_trunc('hour', NOW()) + make_interval(days => $4) + interval '1 hour',
             'America/Los_Angeles',
             CASE WHEN $5 THEN tstzrange(date_trunc('hour', NOW()) + make_interval(days => $4) - interval '1 hour', date_trunc('hour', NOW()) + make_interval(days => $4) + interval '2 hours', '[)')
                  ELSE tstzrange(date_trunc('hour', NOW()) + make_interval(days => $4), date_trunc('hour', NOW()) + make_interval(days => $4) + interval '1 hour', '[)') END,
             $6, $7, 'synced', $8, $9, true) RETURNING id`,
    [l, ownerId, typeId[type], days, !!buffered, status, idem || `${RUN}-${key}`, `${RUN}main${key}`, travel ? `${RUN}travel${key}` : null]);
  ids[key] = r.rows[0].id;
  return r.rows[0].id;
}

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('ethan.test@ecconstructiongroup.com', 'Ethan Test') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'ethan.test@ecconstructiongroup.com'`)).rows[0].id;
  typeId = Object.fromEntries((await db.query('SELECT name, id FROM appointment_types')).rows.map(r => [r.name, r.id]));

  await appt('pcUpcoming', { days: 3, buffered: false });                 // legacy Phone Call + travel → APPLY
  await appt('pcPast', { days: -30, buffered: false, status: 'completed' }); // Phone Call travel in the past → report
  await appt('cancelledOpen', { days: 5, buffered: true, status: 'cancelled' }); // cancel never completed → APPLY
  const done = await appt('cancelledDone', { days: 6, buffered: true, status: 'cancelled' });
  await db.query(`INSERT INTO calendar_outbox (appointment_id, action, slot, version, google_event_id, calendar_id, idempotency_key, status)
                  VALUES ($1, 'cancel_travel', 's', 2, $2, 'c', $3, 'synced')`, [done, `${RUN}travelcancelledDone`, `${RUN}-done`]);
  await appt('siteVisitActive', { days: 4, buffered: true });              // valid → untouched
  await appt('siteVisitCompleted', { days: -10, buffered: true, status: 'completed' }); // history → untouched
  await appt('migratedMeeting', { days: 7, buffered: false, type: 'General Meeting', idem: `migration:appt:${RUN}-mig` }); // ambiguous → report
  const job = await appt('pcJob', { days: 8, buffered: false, travel: false });
  await db.query(`INSERT INTO calendar_outbox (appointment_id, action, slot, version, google_event_id, calendar_id, payload, idempotency_key, status)
                  VALUES ($1, 'create_travel', 's', 1, 'x', 'c', '{}', $2, 'pending')`, [job, `${RUN}-job`]);
  await db.query(`UPDATE calendar_outbox SET next_attempt_at = '2999-01-01' WHERE idempotency_key = $1`, [`${RUN}-job`]);
});
test.after(async () => { if (!skip) await db.pool.end(); });

test('classification: only provably invalid upcoming travel is an apply candidate', { skip }, async () => {
  const r = audit();
  assert.strictEqual(r.mode, 'report-only');
  const got = Object.fromEntries(Object.keys(ids).map(k => [k, clsOf(r, k)]));
  assert.deepStrictEqual(got, {
    pcUpcoming: ['LEGACY_PHONE_CALL_BOOKING', 'LINK_ON_PHONE_CALL'],
    pcPast: ['LINK_ON_PHONE_CALL'],
    cancelledOpen: ['LINK_ON_INACTIVE'],
    cancelledDone: ['LINK_ALREADY_CANCELLED'],
    siteVisitActive: [],
    siteVisitCompleted: [],
    migratedMeeting: ['LINK_ON_MIGRATED_MEETING'],
    pcJob: ['INVALID_TRAVEL_JOB', 'LEGACY_PHONE_CALL_BOOKING'],
  });
  const applyIds = ours(r).filter(x => x.apply).map(x => x.appointment_id).sort();
  assert.deepStrictEqual(applyIds, [ids.cancelledOpen, ids.pcUpcoming].sort());
  assert.strictEqual(ours(r).find(x => x.appointment_id === ids.pcPast).reason, 'past — history left untouched');
});

test('--apply requires --confirm-host and changes nothing without it', { skip }, async () => {
  assert.throws(() => audit(['--apply']), (e) => e.status === 2);
  const n = (await db.query(`SELECT count(*)::int AS n FROM calendar_outbox WHERE idempotency_key LIKE 'audit-travel-cancel:${RUN}%'`)).rows[0].n;
  assert.strictEqual(n, 0);
});

test('apply queues cancel_travel ONLY for the proven artifacts, audits it, deletes nothing; re-run is idempotent', { skip }, async () => {
  const host = new URL(DB_URL).hostname;
  const before = (await db.query('SELECT count(*)::int AS n FROM appointments')).rows[0].n;
  const r = audit(['--apply', `--confirm-host=${host}`]);
  assert.ok(r.run_id);
  const q = (await db.query(`SELECT appointment_id, google_event_id, status FROM calendar_outbox
                              WHERE idempotency_key LIKE 'audit-travel-cancel:${RUN}%' ORDER BY google_event_id`)).rows;
  assert.deepStrictEqual(q.map(x => [x.appointment_id, x.google_event_id, x.status]).sort(), [
    [ids.cancelledOpen, `${RUN}travelcancelledOpen`, 'pending'],
    [ids.pcUpcoming, `${RUN}travelpcUpcoming`, 'pending'],
  ].sort());
  const ev = (await db.query(`SELECT appointment_id, actor, previous_values FROM appointment_events WHERE actor = $1`, [`audit:travel-artifacts:${r.run_id}`])).rows
    .filter(e => Object.values(ids).includes(e.appointment_id));
  assert.strictEqual(ev.length, 2);
  assert.ok(ev.every(e => e.previous_values.travel_event_id));
  assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM appointments')).rows[0].n, before, 'no appointment deleted');
  // Idempotent: a second apply queues nothing new for these events.
  const r2 = audit(['--apply', `--confirm-host=${host}`]);
  const q2 = (await db.query(`SELECT count(*)::int AS n FROM calendar_outbox WHERE idempotency_key LIKE 'audit-travel-cancel:${RUN}%'`)).rows[0].n;
  assert.strictEqual(q2, 2);
  assert.ok(r2.run_id && r2.run_id !== r.run_id);
  // Once the worker cancels the event, the link clears and the row stops being a candidate.
  await db.query(`UPDATE calendar_outbox SET status = 'synced' WHERE idempotency_key LIKE 'audit-travel-cancel:${RUN}%'`);
  await db.query(`UPDATE appointments SET google_travel_event_id = NULL WHERE id = ANY($1::uuid[])`, [[ids.pcUpcoming, ids.cancelledOpen]]);
  const r3 = audit();
  assert.deepStrictEqual(ours(r3).filter(x => x.apply), []);
});

test('Google-side: our marker proves provenance; unmarked / orphan / migrated / completed are never applied', { skip }, async () => {
  const { classifyGoogleEvent, invalidReason } = require(path.join(ROOT, 'scripts/auditTravelArtifacts.js'));
  const rows = (await db.query(
    `SELECT a.*, t.name AS type_name FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id WHERE a.id = ANY($1::uuid[])`,
    [Object.values(ids)])).rows;
  const byId = new Map(rows.map(a => [String(a.id), a]));
  const cur = (a) => require(path.join(ROOT, 'lib/booking/calendarOutbox')).buildOperation(a, null, null, 'travel').googleEventId;
  const ev = (id, appt, extra) => ({ id, summary: 'Driving / Travel Time', extendedProperties: { private: { ec_kind: 'travel', ec_appointment_id: appt } }, ...extra });
  const c = (e) => { const x = classifyGoogleEvent(e, byId, cur); return x && [x.cls, x.apply]; };
  const sv = byId.get(String(ids.siteVisitActive));
  assert.deepStrictEqual(c(ev(sv.google_travel_event_id, sv.id)), ['TRAVEL_VALID', false]);
  assert.deepStrictEqual(c(ev('someOldSlotId', sv.id)), ['TRAVEL_STALE_SLOT', true]);
  assert.deepStrictEqual(c(ev('x1', ids.pcUpcoming)), ['TRAVEL_ON_PHONE_CALL', true]);
  assert.deepStrictEqual(c(ev('x2', ids.cancelledOpen)), ['TRAVEL_ON_INACTIVE', true]);
  assert.deepStrictEqual(c(ev('x3', ids.siteVisitCompleted)), ['TRAVEL_VALID', false]);
  assert.deepStrictEqual(c(ev('x4', ids.migratedMeeting)), ['TRAVEL_ON_MIGRATED_MEETING', false]);
  assert.deepStrictEqual(c(ev('x5', '00000000-0000-0000-0000-000000000000')), ['TRAVEL_NO_APPOINTMENT', false]);
  assert.deepStrictEqual(c({ id: 'x6', summary: 'Driving / Travel Time' }), ['TRAVEL_UNMARKED', false]);
  assert.strictEqual(c({ id: 'x7', summary: 'Lunch' }), null);
  assert.strictEqual(invalidReason(byId.get(String(ids.siteVisitCompleted))), null, 'a completed Site Visit keeps its travel history');
});
