/* eslint-disable no-undef */
'use strict';

/**
 * phoneCallCalendarReminder.int.test.js — REAL-Postgres proof of the final
 * Phone Call model: a Phone Call is a FOLLOW-UP / REMINDER, never an
 * appointment. It has calendar VISIBILITY (exactly one non-blocking reminder
 * event per lead, reconciled from the canonical follow-up) and NEVER
 * availability OCCUPANCY — even though Google Calendar holds the event.
 *
 * Cases A–M map to the required checks. Google Calendar is an in-memory fake at
 * the lib/booking/googleCalendarClient boundary (listEvents serves what the
 * CRM wrote plus injected external events, exactly as availability reads it);
 * everything else is real (routes → bookingService → availability → outbox →
 * worker → follow-up reminder reconciler → legacy conversion).
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const TZ = 'America/Los_Angeles';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

// ── Fake Google Calendar ────────────────────────────────────────────────────
const google = {
  events: new Map(), calls: [], failNext: 0,
  reset() { this.events.clear(); this.calls = []; this.failNext = 0; },
};
function utcOf(t) {
  if (!t || !t.dateTime) return null;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime)) return Date.parse(t.dateTime);
  const { toUtcIso } = require('../../lib/booking/slotBlocking');
  return Date.parse(toUtcIso(t.dateTime.slice(0, 10), t.dateTime.slice(11, 16), t.timeZone || TZ));
}
const gClient = {
  getAccessToken: async () => 'fake-token',
  createOrUpdateEvent: async (_t, _c, body) => { google.calls.push(['insert', body.id]); google.events.set(body.id, { ...body, status: 'confirmed' }); return { id: body.id }; },
  updateEvent: async (_t, _c, id, body) => {
    if (google.failNext > 0) { google.failNext--; throw new Error('Calendar update 503: backend error'); }
    google.calls.push(['put', id]); google.events.set(id, { ...body, id, status: body.status || 'confirmed' }); return { id };
  },
  cancelEvent: async (_t, _c, id) => { google.calls.push(['delete', id]); const e = google.events.get(id); if (e) e.status = 'cancelled'; return { ok: true }; },
  getEvent: async (_t, _c, id) => { const e = google.events.get(id); return e && e.status !== 'cancelled' ? { exists: true, event: e } : { exists: false, reason: 'missing' }; },
  listByExt: async () => [],
  listEvents: async (_c, timeMin, timeMax) => {
    const lo = Date.parse(timeMin), hi = Date.parse(timeMax);
    return [...google.events.values()].filter((e) => e.status !== 'cancelled' && utcOf(e.start) != null
      && utcOf(e.start) < hi && (utcOf(e.end) || utcOf(e.start)) > lo)
      .map((e) => ({ ...e, start: { dateTime: new Date(utcOf(e.start)).toISOString() }, end: { dateTime: new Date(utcOf(e.end)).toISOString() } }));
  },
};
if (DB_URL) {
  const gPath = require.resolve('../../lib/booking/googleCalendarClient');
  require.cache[gPath] = { id: gPath, filename: gPath, loaded: true, exports: gClient };
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('../../lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
}

let base, server, db, token, outbox, ownerId, otherOwnerId, pickDay, getAvailability, reminders, conversion;
let ipSeq = 1;
async function api(method, p, body, tok) {
  const res = await fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.8.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`,
      ...(tok === null ? {} : { authorization: 'Bearer ' + (tok || token) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}
const rnd = (lo, n) => lo + Math.floor(Math.random() * n);
const randomPhone = () => `${rnd(200, 800)}${rnd(200, 800)}${String(rnd(0, 10000)).padStart(4, '0')}`;
let seq = 0;
async function capture(extra, expectStatus = 201) {
  const r = await api('POST', '/api/public/capture', {
    first_name: 'Pcr', last_name: `Remind${++seq}${Date.now() % 100000}`, phone: randomPhone(),
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich', ...extra,
  }, null);
  assert.strictEqual(r.status, expectStatus, JSON.stringify(r.body));
  return r.body && r.body.lead ? r.body.lead.id : r.body;
}
const phoneCall = (day, hhmm) => capture({ follow_up_date: day, follow_up_time: hhmm, follow_up_type: 'Phone Call' });
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const apptsOf = (leadId) => rows('SELECT * FROM appointments WHERE lead_id = $1 ORDER BY created_at', [leadId]);
async function drain() {
  for (let i = 0; i < 20; i++) if (!(await outbox.claimAndProcess(db.pool, 'pc-reminder-worker', { batchSize: 50 })).claimed) return;
}
const reconcile = (now) => reminders.reconcileFollowUpReminders(db.pool, { google: gClient, limit: 100000, delayMs: 0, crmPublicUrl: '', ...(now ? { now } : {}) });
const liveReminders = (leadId) => [...google.events.values()].filter((e) => e.status !== 'cancelled'
  && e.extendedProperties && e.extendedProperties.private.ec_kind === 'followup_reminder'
  && e.extendedProperties.private.ec_lead_id === String(leadId));
const avail = (day, owner = ownerId) => getAvailability({ owner_id: owner, date: day, timezone: TZ, duration_minutes: 60 });
const at = (day, hhmm) => require('../../lib/booking/slotBlocking').toUtcIso(day, hhmm, TZ);

// A legacy Phone Call booking (pre-rule data): unbuffered row, synced to Google
// BEFORE the phone_call marker existed (its event looks like any main event).
async function legacyPhoneCall(leadId, day, hhmm, { withTravel = false } = {}) {
  const start = at(day, hhmm);
  const type = (await rows("SELECT id FROM appointment_types WHERE name = 'Consultation'"))[0].id;
  const tag = `${seq++}${Date.now()}`;
  const a = (await rows(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                               idempotency_key, calendar_sync_status, google_event_id, google_travel_event_id)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '30 minutes', $5,
             tstzrange($4::timestamptz, $4::timestamptz + interval '30 minutes', '[)'), 'scheduled', $6, 'synced', $7, $8)
     RETURNING *`,
    [leadId, ownerId, type, start, TZ, `legacy-pcr-${tag}`, `legacymain${tag}`, withTravel ? `legacytravel${tag}` : null]))[0];
  const endIso = new Date(Date.parse(start) + 30 * 60000).toISOString();
  google.events.set(a.google_event_id, { id: a.google_event_id, status: 'confirmed', summary: 'Phone Call with X',
    start: { dateTime: start }, end: { dateTime: endIso }, extendedProperties: { private: { ec_appointment_id: a.id, ec_kind: 'main' } } });
  if (withTravel) {
    google.events.set(a.google_travel_event_id, { id: a.google_travel_event_id, status: 'confirmed', summary: 'Driving / Travel Time',
      start: { dateTime: endIso }, end: { dateTime: new Date(Date.parse(endIso) + 3600000).toISOString() },
      extendedProperties: { private: { ec_appointment_id: a.id, ec_kind: 'travel' } } });
  }
  return a;
}
function externalBusy(day, from, to, extra = {}) {
  const id = `external${seq++}${Date.now()}`;
  google.events.set(id, { id, status: 'confirmed', summary: 'Dentist', start: { dateTime: at(day, from) }, end: { dateTime: at(day, to) }, ...extra });
  return id;
}

let googleModulesState;

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  outbox = require('../../lib/booking/calendarOutbox');
  reminders = require('../../lib/booking/followUpReminders');
  conversion = require('../../lib/booking/legacyPhoneCallConversion');
  ({ getAvailability } = require('../../lib/booking/availabilityService'));
  // PRODUCTIZATION: this file asserts real Phone Call reminder events and
  // external-busy-blocking on Google Calendar — see ensureGoogleModulesEnabled.js.
  googleModulesState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db);
  require('../../lib/companyConfig').invalidate();
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('pc-reassign@example.com', 'PC Reassign Owner') ON CONFLICT DO NOTHING`);
  ownerId = (await rows(`SELECT id FROM owners WHERE email = 'yaron@ecconstructiongroup.com'`))[0].id;
  otherOwnerId = (await rows(`SELECT id FROM owners WHERE email = 'pc-reassign@example.com'`))[0].id;
  token = require('../../lib/authService').issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  app.use('/api/public/capture', require('../../routes/publicCapture'));
  app.use('/api/v1/system', require('../../routes/systemHealth'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  server.close();
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, googleModulesState);
  require('../../lib/companyConfig').invalidate();
  await db.pool.end();
});
test.beforeEach(async () => {
  if (skip) return;
  google.reset();
  await db.query(`UPDATE calendar_outbox SET next_attempt_at = '2999-01-01' WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()`);
});

test('A/B/C/M. Phone Call at 10:00 → one free reminder event on Google; 10:00 stays available; a real appointment books at the same minute', { skip }, async () => {
  const day = pickDay();
  const callLead = await phoneCall(day, '10:00');
  assert.deepStrictEqual(await apptsOf(callLead), [], 'no appointments row');
  await reconcile();
  const [ev, ...more] = liveReminders(callLead);
  assert.ok(ev, 'C: the reminder event exists on Google Calendar');
  assert.deepStrictEqual(more, [], 'exactly one');
  assert.strictEqual(ev.transparency, 'transparent');
  assert.strictEqual(ev.extendedProperties.private.ec_blocking, 'false');
  assert.strictEqual(utcOf(ev.start), Date.parse(at(day, '10:00')));
  // B/C: the Google listing contains the reminder, yet no slot is blocked.
  const listed = await gClient.listEvents('cal', at(day, '00:00'), at(day, '23:59'));
  assert.ok(listed.some((e) => e.id === ev.id), 'availability reads the reminder from Google');
  const av = await avail(day);
  assert.deepStrictEqual(av.blocked_slots, [], 'B: 10:00 (and every slot) stays available');
  const pub = await api('GET', `/api/public/capture/availability?date=${day}&owner=yaron@ecconstructiongroup.com`, undefined, null);
  assert.strictEqual(pub.status, 200);
  assert.ok(!pub.body.blocked_slots.includes('10:00'), 'the UI availability endpoint agrees');
  assert.ok(pub.body.busy_windows.every((w) => Object.keys(w).sort().join() === 'end,source,start'), 'no titles leak from the public endpoint');
  // A/M: same owner, same minute — a real Site Visit books (write path incl. Google pre-check).
  const visit = await capture({ appointment_date: day, appointment_time: '10:00' });
  assert.strictEqual((await apptsOf(visit)).length, 1);
});

test('D/E. A genuine external Google busy event still blocks ±1h and rejects a booking; a real appointment blocks 1h before + duration + 1h after', { skip }, async () => {
  const day = pickDay();
  externalBusy(day, '13:00', '14:00');
  const av = await avail(day);
  assert.deepStrictEqual(av.blocked_slots, ['11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30']);
  const r = await capture({ appointment_date: day, appointment_time: '13:00' }, 409);
  assert.match(JSON.stringify(r), /conflict/i, 'rejected as a slot conflict');
  // E: a real Site Visit 09:00–10:00 stores busy 08:00–11:00.
  const v = await capture({ appointment_date: day, appointment_time: '09:00' });
  const [a] = await apptsOf(v);
  const ok = (await rows(`SELECT lower(busy_range) = start_at - interval '1 hour' AND upper(busy_range) = end_at + interval '1 hour' AS ok FROM appointments WHERE id = $1`, [a.id]))[0].ok;
  assert.strictEqual(ok, true);
  const av2 = await avail(day);
  for (const s of ['08:30', '09:00', '10:00', '10:30']) assert.ok(av2.blocked_slots.includes(s), `${s} blocked by the Site Visit`);
  assert.ok(!av2.blocked_slots.includes('11:00') && !av2.blocked_slots.includes('07:00'), 'boundary 11:00 is free');
});

test('F. A Phone Call never produces travel: no outbox rows, no travel event, no buffer', { skip }, async () => {
  const day = pickDay();
  const id = await phoneCall(day, '15:00');
  await reconcile();
  await drain();
  assert.deepStrictEqual(await rows('SELECT o.id FROM calendar_outbox o JOIN appointments a ON a.id = o.appointment_id WHERE a.lead_id = $1', [id]), []);
  const all = [...google.events.values()].filter((e) => e.status !== 'cancelled' && JSON.stringify(e).includes(id));
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].extendedProperties.private.ec_kind, 'followup_reminder');
  assert.ok(!/travel/i.test(all[0].summary));
});

test('G/I. Reschedule and owner reassignment update the SAME event (no duplicate)', { skip }, async () => {
  const day = pickDay();
  const id = await phoneCall(day, '10:00');
  await reconcile();
  const [first] = liveReminders(id);
  const r = await api('PUT', `/api/v1/leads/${id}/follow-up`, { follow_up_time: '15:30', follow_up_notes: 'moved' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await reconcile();
  const after = liveReminders(id);
  assert.strictEqual(after.length, 1, 'G: still one event');
  assert.strictEqual(after[0].id, first.id, 'G: same event id, updated in place');
  assert.strictEqual(utcOf(after[0].start), Date.parse(at(day, '15:30')));
  assert.ok((await avail(day)).blocked_slots.length === 0, 'the new time does not block either');
  const o = await api('PUT', `/api/v1/leads/${id}`, { owner_id: otherOwnerId });
  assert.strictEqual(o.status, 200, JSON.stringify(o.body));
  await reconcile();
  const moved = liveReminders(id);
  assert.strictEqual(moved.length, 1, 'I: one event after reassignment');
  assert.strictEqual(moved[0].id, first.id);
  assert.deepStrictEqual(moved[0].attendees, [{ email: 'pc-reassign@example.com' }], 'I: now on the new owner');
  const st = (await rows('SELECT * FROM followup_calendar_reminders WHERE lead_id = $1', [id]))[0];
  assert.strictEqual(st.owner_email, 'pc-reassign@example.com');
});

test('H. Complete / clear / retype / delete removes the future reminder; a later Phone Call gets a fresh event', { skip }, async () => {
  const day = pickDay();
  const [a, b, c, d] = [await phoneCall(day, '09:00'), await phoneCall(day, '09:30'), await phoneCall(day, '11:00'), await phoneCall(day, '11:30')];
  await reconcile();
  for (const id of [a, b, c, d]) assert.strictEqual(liveReminders(id).length, 1);
  const firstId = liveReminders(a)[0].id;
  assert.strictEqual((await api('PUT', `/api/v1/leads/${a}/follow-up`, { follow_up_status: 'completed' })).status, 200);
  assert.strictEqual((await api('PUT', `/api/v1/leads/${b}/follow-up`, { follow_up_date: null, follow_up_type: null, follow_up_time: null })).status, 200);
  assert.strictEqual((await api('PUT', `/api/v1/leads/${c}/follow-up`, { follow_up_type: 'Email' })).status, 200);
  const del = await api('DELETE', `/api/v1/leads/${d}`);
  assert.ok([200, 204].includes(del.status), JSON.stringify(del.body));
  const s = await reconcile();
  assert.ok(s.removed >= 4, JSON.stringify(s));
  for (const id of [a, b, c, d]) assert.deepStrictEqual(liveReminders(id), [], `reminder for ${id} removed`);
  // Re-opening a Phone Call for lead a creates a NEW event (a deleted id is never reused).
  assert.strictEqual((await api('PUT', `/api/v1/leads/${a}/follow-up`, { follow_up_status: 'pending', follow_up_time: '16:00' })).status, 200);
  await reconcile();
  const again = liveReminders(a);
  assert.strictEqual(again.length, 1);
  assert.notStrictEqual(again[0].id, firstId);
});

test('J. Reconciliation is idempotent and retries a failed Google write without duplicates', { skip }, async () => {
  const day = pickDay();
  const id = await phoneCall(day, '12:00');
  google.failNext = 1000;
  const s1 = await reconcile();
  assert.ok(s1.errors >= 1);
  const st = (await rows('SELECT * FROM followup_calendar_reminders WHERE lead_id = $1', [id]))[0];
  assert.ok(st.last_error && st.next_attempt_at, 'failure recorded with backoff');
  google.failNext = 0;
  const skipped = await reconcile();
  assert.ok(!google.calls.some(([, eid]) => eid === st.google_event_id), 'backoff respected');
  assert.ok(skipped.errors === 0);
  await reconcile(new Date(Date.now() + 2 * 3600000)); // past the backoff
  assert.strictEqual(liveReminders(id).length, 1);
  google.calls = [];
  const s3 = await reconcile();
  assert.ok(!google.calls.some(([, eid]) => eid === liveReminders(id)[0].id), 'no Google call when nothing changed');
  assert.ok(s3.unchanged >= 1);
  assert.strictEqual(liveReminders(id).length, 1);
});

test('K. A legacy Phone Call row never blocks, never gets an event re-created, and is converted (backed up, reversible) to one reminder', { skip }, async () => {
  const day = pickDay();
  const id = await capture({});
  const legacy = await legacyPhoneCall(id, day, '10:00', { withTravel: true });
  // Its pre-marker Google event (and the invalid travel) never blocks.
  assert.deepStrictEqual((await avail(day)).blocked_slots, []);
  await capture({ appointment_date: day, appointment_time: '10:00' }); // same-time real appointment allowed
  // The outbox never creates / re-creates a main event for it.
  const c = await db.pool.connect();
  try { await c.query('BEGIN'); await outbox.enqueueCreate(c, { ...legacy, version: 3 }, { first_name: 'X' }, 'yaron@ecconstructiongroup.com', false); await c.query('COMMIT'); } finally { c.release(); }
  assert.deepStrictEqual(await rows(`SELECT id FROM calendar_outbox WHERE appointment_id = $1 AND action IN ('create_main','create_travel')`, [legacy.id]), []);
  google.events.delete(legacy.google_event_id);
  const rc = await outbox.reconcileSyncedAppointments(db.pool, { batchSize: 100000 });
  assert.ok(rc.checked >= 0);
  assert.deepStrictEqual(await rows(`SELECT id FROM calendar_outbox WHERE appointment_id = $1 AND action = 'create_main'`, [legacy.id]), [], 'reconciliation does not regenerate it');
  // Conversion: backup first, then the lead's follow-up, cancel the row + its Google artifacts.
  const stats = await conversion.convertLegacyPhoneCallAppointments(db.pool, { limit: 100000 });
  assert.ok(stats.converted >= 1, JSON.stringify(stats));
  const rec = (await rows('SELECT * FROM legacy_phone_call_conversions WHERE appointment_id = $1', [legacy.id]))[0];
  assert.strictEqual(rec.action, 'converted');
  assert.strictEqual(rec.appointment_before.status, 'scheduled');
  const lead = (await rows('SELECT * FROM leads WHERE id = $1', [id]))[0];
  assert.deepStrictEqual([lead.follow_up_type, lead.follow_up_date, lead.follow_up_time, lead.follow_up_status], ['Phone Call', day, '10:00', 'pending']);
  assert.strictEqual((await rows('SELECT status FROM appointments WHERE id = $1', [legacy.id]))[0].status, 'cancelled');
  await drain();
  await reconcile();
  const live = [...google.events.values()].filter((e) => e.status !== 'cancelled' && (JSON.stringify(e).includes(legacy.id) || JSON.stringify(e).includes(id)));
  assert.deepStrictEqual(live.map((e) => e.extendedProperties.private.ec_kind), ['followup_reminder'], 'exactly one calendar presence: the reminder; travel gone');
  // Idempotent: a second pass finds nothing.
  const again = await conversion.convertLegacyPhoneCallAppointments(db.pool, { limit: 100000 });
  assert.ok(!(await rows('SELECT 1 FROM appointments WHERE id = $1 AND status = $2', [legacy.id, 'scheduled'])).length);
  assert.strictEqual(again.errors, 0);
  // Reversible: report-only changes nothing; APPLY=1 restores exactly.
  const script = path.join(__dirname, '../../scripts/revertLegacyPhoneCallConversion.js');
  const env = { ...process.env, DATABASE_URL: DB_URL, APPOINTMENT_ID: legacy.id };
  const dry = JSON.parse(spawnSync(process.execPath, [script], { env, encoding: 'utf8' }).stdout);
  assert.deepStrictEqual([dry.mode, dry.reverted], ['REPORT-ONLY', 1]);
  assert.strictEqual((await rows('SELECT status FROM appointments WHERE id = $1', [legacy.id]))[0].status, 'cancelled');
  const applied = JSON.parse(spawnSync(process.execPath, [script], { env: { ...env, APPLY: '1' }, encoding: 'utf8' }).stdout);
  assert.strictEqual(applied.reverted, 1);
  assert.strictEqual((await rows('SELECT status FROM appointments WHERE id = $1', [legacy.id]))[0].status, 'scheduled');
  const restored = (await rows('SELECT * FROM leads WHERE id = $1', [id]))[0];
  assert.strictEqual(restored.follow_up_type, null);
  assert.strictEqual((await rows('SELECT action FROM legacy_phone_call_conversions WHERE appointment_id = $1', [legacy.id]))[0].action, 'reverted');
  // Even restored, the legacy row still never blocks.
  // (10:00 itself is legitimately blocked by the real appointment booked above.)
  assert.ok((await avail(day)).busy_windows.every((w) => w.appointment_id !== legacy.id && w.ec_appointment_id !== legacy.id));
});

test('K2. Ambiguous legacy rows (lead with a different active follow-up) are recorded and left untouched', { skip }, async () => {
  const day = pickDay();
  const id = await capture({ follow_up_date: day, follow_up_time: '08:30', follow_up_type: 'Email' });
  const legacy = await legacyPhoneCall(id, day, '14:00');
  await conversion.convertLegacyPhoneCallAppointments(db.pool, { limit: 100000 });
  const rec = (await rows('SELECT * FROM legacy_phone_call_conversions WHERE appointment_id = $1', [legacy.id]))[0];
  assert.deepStrictEqual([rec.action, rec.reason], ['ambiguous', 'lead_has_different_active_follow_up']);
  assert.strictEqual((await rows('SELECT status FROM appointments WHERE id = $1', [legacy.id]))[0].status, 'scheduled', 'untouched');
  const lead = (await rows('SELECT follow_up_type, follow_up_time FROM leads WHERE id = $1', [id]))[0];
  assert.deepStrictEqual([lead.follow_up_type, lead.follow_up_time], ['Email', '08:30']);
  assert.ok(!(await avail(day)).blocked_slots.includes('14:00'), 'still never blocks');
  const again = await conversion.convertLegacyPhoneCallAppointments(db.pool, { limit: 100000 });
  assert.strictEqual(again.errors, 0);
  assert.strictEqual((await rows('SELECT count(*)::int AS n FROM legacy_phone_call_conversions WHERE appointment_id = $1', [legacy.id]))[0].n, 1);
  // Admin-only read-only investigation: provenance without PII, changes nothing.
  const before = JSON.stringify(await rows('SELECT * FROM appointments WHERE id = $1', [legacy.id]));
  const inv = await api('GET', '/api/v1/system/phone-calls/ambiguous');
  assert.strictEqual(inv.status, 200, JSON.stringify(inv.body));
  const row = inv.body.rows.find((r) => r.ref === legacy.id.slice(0, 8));
  assert.ok(row, 'the ambiguous row is investigated');
  assert.strictEqual(row.legacy_appointment.start, `${day} 14:00`);
  assert.deepStrictEqual([row.lead.follow_up.type, row.lead.follow_up.date, row.lead.follow_up.time], ['Email', day, '08:30']);
  assert.strictEqual(row.google_event.exists, true);
  const pii = (await rows('SELECT last_name, phone FROM leads WHERE id = $1', [id]))[0];
  const text = JSON.stringify(inv.body);
  for (const v of [pii.last_name, pii.phone, id]) assert.ok(!text.includes(v), `no PII / full ids (${v})`);
  assert.strictEqual(JSON.stringify(await rows('SELECT * FROM appointments WHERE id = $1', [legacy.id])), before, 'read-only');
  assert.strictEqual((await api('GET', '/api/v1/system/phone-calls/ambiguous', undefined, null)).status, 401);
});

test('L. Multiple Phone Calls at the same time are allowed, each with its own reminder, and a real appointment still books then', { skip }, async () => {
  const day = pickDay();
  const ids = [await phoneCall(day, '11:00'), await phoneCall(day, '11:00'), await phoneCall(day, '11:00')];
  await reconcile();
  for (const id of ids) assert.strictEqual(liveReminders(id).length, 1);
  assert.deepStrictEqual((await avail(day)).blocked_slots, []);
  await capture({ appointment_date: day, appointment_time: '11:00' });
});

test('Integrity report: aggregate only, no PII, and it proves zero blocking / travel / duplicates', { skip }, async () => {
  const day = pickDay();
  const id = await phoneCall(day, '10:00');
  await reconcile();
  externalBusy(day, '16:00', '17:00');
  const { phoneCallIntegrity } = require('../../lib/booking/phoneCallIntegrity');
  const rep = await phoneCallIntegrity({ now: new Date(Date.parse(at(day, '00:00')) - 86400000) });
  assert.strictEqual(rep.google.reminder_leads_with_duplicates, 0);
  assert.strictEqual(rep.google.reminder_events_not_transparent, 0);
  assert.strictEqual(rep.google.travel_events_for_phone_calls, 0);
  assert.ok(rep.phone_call_slot_probes.length >= 1);
  for (const p of rep.phone_call_slot_probes) assert.strictEqual(p.phone_call_attributable_blockers, 0);
  assert.ok(rep.external_busy_probes.some((p) => p.expected_blocked_slots > 0 && p.actually_blocked === p.expected_blocked_slots));
  assert.deepStrictEqual(rep.classifier_probe, { external_opaque_blocked_slots: 7, same_event_as_crm_reminder_blocked_slots: 0 });
  const text = JSON.stringify(rep);
  const lead = (await rows('SELECT first_name, last_name, phone FROM leads WHERE id = $1', [id]))[0];
  for (const v of [lead.last_name, lead.phone, id, 'Dentist', day]) assert.ok(!text.includes(v), `report must not contain ${v}`);
  assert.strictEqual((await api('GET', '/api/v1/system/phone-calls', undefined, null)).status, 401, 'no token → 401');
  const repTok = require('../../lib/authService').issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a3', email: 'rep@example.com', role: 'sales_rep' });
  assert.strictEqual((await api('GET', '/api/v1/system/phone-calls', undefined, repTok)).status, 403, 'non-admin → 403');
  const http = await api('GET', '/api/v1/system/phone-calls');
  assert.strictEqual(http.status, 200);
  assert.ok(!JSON.stringify(http.body).match(/[0-9a-f]{8}-[0-9a-f]{4}-/), 'no record ids');
  assert.strictEqual(typeof http.body.legacy_phone_call_rows.active_future, 'number');
});
