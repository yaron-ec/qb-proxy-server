/* eslint-disable no-undef */
'use strict';

/**
 * appointmentBufferBoundary.int.test.js — REAL-Postgres boundary + parity test
 * for the canonical appointment blocking rule. Skipped without TEST_DATABASE_URL.
 *
 * CANONICAL RULE: a real Appointment blocks 1h BEFORE + its duration + 1h AFTER.
 * A 12:00–13:00 appointment blocks 11:00–14:00. A new appointment is checked as
 * its own actual window against that block: touching a boundary is allowed,
 * overlapping it is not (12:00 appt → 13:59 start = conflict, 14:00 = allowed;
 * a 10:00–11:00 appointment ends exactly at 11:00 = allowed, 10:01 = conflict).
 *
 * PARITY: the availability the UI shows (lib/booking/availabilityService →
 * slotBlocking.computeBlockedSlots over merged busy windows) and the write-path
 * conflict check (lib/booking/appointmentWriter#acquireOwnerLockAndCheckConflict,
 * called by bookingService for every create/reschedule) must agree on every
 * slot — an AVAILABLE slot must never 409 on an unchanged submission.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const TZ = 'America/Los_Angeles';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub('lib/booking/googleCalendarClient', {
    getAccessToken: async () => 'fake', createOrUpdateEvent: async (_t, _c, b) => ({ id: b.id }),
    updateEvent: async (_t, _c, id) => ({ id }), cancelEvent: async () => ({ ok: true }),
    getEvent: async () => ({ exists: false }), listByExt: async () => [], listEvents: async () => [],
  });
  stub('lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
}

let base, server, db, token, ownerId;
let ipSeq = 1;
async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.7.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`,
      authorization: 'Bearer ' + token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}
let seq = 0;
// Random 10-digit phone per lead: the test DB persists between runs, and a phone
// reused from an earlier run is (correctly) rejected by duplicate-lead prevention
// (exact phone-suffix match) with a 409 potential_duplicate.
const rnd = (lo, n) => lo + Math.floor(Math.random() * n);
const randomPhone = () => `${rnd(200, 800)}${rnd(200, 800)}${String(rnd(0, 10000)).padStart(4, '0')}`;
function lead(extra) {
  seq++;
  return {
    first_name: 'Bound', last_name: `Ary${seq}${Date.now() % 1e6}`,
    phone: randomPhone(),
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich', ...extra,
  };
}
let pickDay; // set in test.before from ./freeDays (days with no appointment)
function freshDay() { return pickDay(); }
async function book(day, time) {
  return api('POST', '/api/public/capture', lead({ appointment_date: day, appointment_time: time }));
}

// The write path's OWN conflict check, run in a transaction that is rolled back.
async function writePathAllows(day, time, durationMin = 60) {
  const { toUtcIso } = require(path.join(ROOT, 'lib/booking/slotBlocking'));
  const { acquireOwnerLockAndCheckConflict } = require(path.join(ROOT, 'lib/booking/appointmentWriter'));
  const start = new Date(toUtcIso(day, time, TZ));
  const end = new Date(start.getTime() + durationMin * 60000);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await acquireOwnerLockAndCheckConflict(client, ownerId, start, end, null, false);
    return true;
  } catch (e) {
    if (e.code === 'SLOT_CONFLICT') return false;
    throw e;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function availability(day) {
  const { getAvailability } = require(path.join(ROOT, 'lib/booking/availabilityService'));
  return getAvailability({ owner_id: ownerId, date: day, timezone: TZ, duration_minutes: 60 });
}

async function assertParity(day) {
  const { SLOTS } = require(path.join(ROOT, 'lib/booking/slotBlocking'));
  const av = await availability(day);
  const blocked = new Set(av.blocked_slots);
  const mismatches = [];
  for (const slot of SLOTS) {
    const ok = await writePathAllows(day, slot);
    if (ok === blocked.has(slot)) mismatches.push(`${slot}: UI ${blocked.has(slot) ? 'blocked' : 'available'} vs write ${ok ? 'allowed' : '409'}`);
  }
  assert.deepStrictEqual(mismatches, [], `availability/write-path parity on ${day}`);
  return av;
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'yaron@ecconstructiongroup.com'`)).rows[0].id;
  token = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  app.use('/api/public/capture', require(path.join(ROOT, 'routes/publicCapture')));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

test('B1. 12:00–13:00 blocks exactly 11:00–14:00 (stored busy_range)', { skip }, async () => {
  const day = freshDay();
  const r = await book(day, '12:00');
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const row = (await db.query(`SELECT lower(busy_range) bs, upper(busy_range) be FROM appointments WHERE lead_id = $1`, [r.body.lead.id])).rows[0];
  const { toUtcIso } = require(path.join(ROOT, 'lib/booking/slotBlocking'));
  assert.strictEqual(new Date(row.bs).toISOString(), new Date(toUtcIso(day, '11:00', TZ)).toISOString());
  assert.strictEqual(new Date(row.be).toISOString(), new Date(toUtcIso(day, '14:00', TZ)).toISOString());
});

for (const [time, allowed, why] of [
  ['13:59', false, 'one minute before the end boundary'],
  ['14:00', true, 'exactly at the end boundary'],
  ['14:01', true, 'one minute after the end boundary'],
  ['10:01', false, 'ends one minute inside the start boundary'],
  ['10:00', true, 'ends exactly at the start boundary'],
  ['09:59', true, 'ends one minute before the start boundary'],
  ['12:00', false, 'same time (overlapping real appointments)'],
]) {
  test(`B2. after a 12:00–13:00 appointment a new appointment at ${time} is ${allowed ? 'allowed' : 'rejected'} (${why}) — UI and write path agree`, { skip }, async () => {
    const day = freshDay();
    assert.strictEqual((await book(day, '12:00')).status, 201);
    assert.strictEqual(await writePathAllows(day, time), allowed, 'write-path conflict check');
    const r = await book(day, time);
    assert.strictEqual(r.status, allowed ? 201 : 409, JSON.stringify(r.body));
    if (!allowed) assert.strictEqual(r.body.error, 'conflict');
    // Lead Detail (reschedule/create through PUT /:id/appointment) applies the same rule.
    const l = await api('POST', '/api/public/capture', lead({}));
    assert.strictEqual(l.status, 201);
    const other = freshDay();
    assert.strictEqual((await book(other, '12:00')).status, 201);
    const put = await api('PUT', `/api/v1/leads/${l.body.lead.id}/appointment`, { appointment_date: other, appointment_time: time });
    assert.strictEqual(put.status, allowed ? 200 : 409, JSON.stringify(put.body));
  });
}

test('B3. availability grid ↔ write path parity: single appointment', { skip }, async () => {
  const day = freshDay();
  assert.strictEqual((await book(day, '12:00')).status, 201);
  const av = await assertParity(day);
  assert.ok(av.blocked_slots.includes('13:30'));
  assert.ok(!av.blocked_slots.includes('14:00'), '14:00 is shown available — and books');
  assert.ok(!av.blocked_slots.includes('10:00'));
  assert.ok(av.blocked_slots.includes('10:30'));
});

test('B4. touching busy windows (12:00 and 15:00 appointments → 11:00–14:00 + 14:00–17:00) merge; parity holds', { skip }, async () => {
  const day = freshDay();
  assert.strictEqual((await book(day, '12:00')).status, 201);
  assert.strictEqual((await book(day, '15:00')).status, 201, '15:00 starts one hour after 14:00 → its 1h-before buffer only touches');
  const av = await assertParity(day);
  for (const s of ['11:00', '13:00', '13:30', '14:00', '15:30', '16:00']) assert.ok(av.blocked_slots.includes(s), `${s} blocked`);
  assert.ok(!av.blocked_slots.includes('10:00'));
  assert.ok(!av.blocked_slots.includes('17:00'), '17:00 touches the merged end → available');
  assert.strictEqual((await book(day, '17:00')).status, 201);
});

test('B5. overlapping real appointments (admin override) merge; parity holds and the override is the only way in', { skip }, async () => {
  const day = freshDay();
  assert.strictEqual((await book(day, '12:00')).status, 201);
  const l = await api('POST', '/api/public/capture', lead({}));
  const blocked = await api('PUT', `/api/v1/leads/${l.body.lead.id}/appointment`, { appointment_date: day, appointment_time: '12:30' });
  assert.strictEqual(blocked.status, 409);
  const ov = await api('PUT', `/api/v1/leads/${l.body.lead.id}/appointment`, { appointment_date: day, appointment_time: '12:30', admin_override: true });
  assert.strictEqual(ov.status, 200, JSON.stringify(ov.body));
  const av = await assertParity(day);
  assert.ok(av.blocked_slots.includes('14:00'), 'the overlapping 12:30 appointment extends the block to 14:30');
  assert.ok(!av.blocked_slots.includes('14:30'));
});

test('B7. PRODUCTIZATION: a configured non-default travel buffer actually changes the blocked window end-to-end', { skip }, async () => {
  // company_settings is a singleton (ORDER BY created_at ASC LIMIT 1) —
  // mutate whichever row is actually effective, restore it afterward, so
  // this is correct standalone or inside the shared aggregate test run.
  const companyConfig = require(path.join(ROOT, 'lib/companyConfig'));
  const existing = (await db.query('SELECT id, appointment_travel_buffer_minutes FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  let insertedId = null;
  if (existing) {
    await db.query('UPDATE company_settings SET appointment_travel_buffer_minutes = 30 WHERE id = $1', [existing.id]);
  } else {
    const ins = await db.query(
      `INSERT INTO company_settings (company_name, appointment_travel_buffer_minutes) VALUES ('Buffer Test Co', 30) RETURNING id`
    );
    insertedId = ins.rows[0].id;
  }
  companyConfig.invalidate();
  try {
    const day = freshDay();
    assert.strictEqual((await book(day, '12:00')).status, 201);
    const av = await assertParity(day);
    // 30-minute buffer: 12:00–13:00 appointment's busy_range is [11:30,13:30),
    // NOT the default rule's [11:00,14:00) (see B3, same appointment, default
    // buffer: 10:30 and 13:30 are BOTH blocked there). A 60-min candidate
    // slot is blocked when its own [slot, slot+60m) window overlaps that
    // busy_range.
    assert.ok(av.blocked_slots.includes('11:30'), '30min buffer: 11:30 (candidate overlaps the buffered start) is blocked');
    assert.ok(!av.blocked_slots.includes('10:30'), '30min buffer: 10:30 — blocked under the default 60min buffer (B3) — is now available');
    assert.ok(!av.blocked_slots.includes('13:30'), '30min buffer: 13:30 — blocked under the default 60min buffer (B3) — is now available');
    assert.strictEqual((await book(day, '10:30')).status, 201, '10:30 now genuinely bookable (write path, not just the availability grid) under the 30-minute buffer');
  } finally {
    if (insertedId) await db.query('DELETE FROM company_settings WHERE id = $1', [insertedId]);
    else await db.query('UPDATE company_settings SET appointment_travel_buffer_minutes = $1 WHERE id = $2', [existing.appointment_travel_buffer_minutes, existing.id]);
    companyConfig.invalidate();
  }
});

test('B6. A Phone Call FOLLOW-UP at 12:00 blocks nothing; a real appointment books at exactly 12:00', { skip }, async () => {
  const day = freshDay();
  const f = await api('POST', '/api/public/capture', lead({ follow_up_date: day, follow_up_time: '12:00', follow_up_type: 'Phone Call' }));
  assert.strictEqual(f.status, 201, JSON.stringify(f.body));
  assert.strictEqual(f.body.appointment, null);
  const av = await assertParity(day);
  assert.deepStrictEqual(av.blocked_slots, []);
  assert.deepStrictEqual(av.busy_windows, []);
  assert.strictEqual((await book(day, '12:00')).status, 201);
});

test('B6b. PERMANENT RULE: a Meeting FOLLOW-UP at 12:00 blocks like a real Appointment Meeting (1h before + duration + 1h after), and UI/write-path parity holds', { skip }, async () => {
  const day = freshDay();
  const f = await api('POST', '/api/public/capture', lead({ follow_up_date: day, follow_up_time: '12:00', follow_up_type: 'Meeting' }));
  assert.strictEqual(f.status, 201, JSON.stringify(f.body));
  assert.strictEqual(f.body.appointment, null, 'still never an appointments row');
  const av = await assertParity(day);
  for (const s of ['11:00', '11:30', '12:00', '12:30']) assert.ok(av.blocked_slots.includes(s), `${s} blocked`);
  assert.ok(!av.blocked_slots.includes('10:00') && !av.blocked_slots.includes('14:00'), 'boundaries stay free');
  // A booking attempt at the exact same slot is rejected — parity between
  // the availability display and the write-path conflict check.
  assert.strictEqual((await book(day, '12:00')).status, 409);
  // 14:00 touches the boundary exactly and is allowed, same as a real Appointment.
  assert.strictEqual((await book(day, '14:00')).status, 201);
});
