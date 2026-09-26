/* eslint-disable no-undef */
'use strict';

/**
 * appointmentFollowUp.int.test.js — REAL-Postgres end-to-end test of the
 * New Lead → Appointment → Follow-Up flow (HTTP → routes → bookingService →
 * calendar outbox → worker → reminder projection).
 *
 * Runs only when TEST_DATABASE_URL points at a DISPOSABLE database that has
 * had `node db/migrate.js` applied (the full migration chain). Skipped
 * otherwise, so the default `npm test` (no Postgres) is unaffected:
 *
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5432/crm_int \
 *     node --test test/integration/appointmentFollowUp.int.test.js
 *
 * Google Calendar is replaced by an in-memory fake at the
 * lib/booking/googleCalendarClient boundary (the only module that talks to
 * Google), so event creation, id persistence, retry, dead-letter, reschedule,
 * cancel and duplicate prevention are exercised through the real outbox code.
 *
 * Numbered cases map to the required checks:
 *   1 appointment only · 2 follow-up only · 3 both · 4 neither · 5 reopen
 *   6 edit appointment · 7 edit follow-up · 8 refresh persistence
 *   9 appointment/meeting never contradict · 10 calendar sync success
 *   11 sync failure surfaced + retried · 12 no duplicate events
 *   13 availability/buffer rules · 14 reminder timing = real start
 *   15 backend validation
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

// ── Fake Google Calendar at the client boundary ──────────────────────────────
const google = {
  events: new Map(),      // id → event body (+ status)
  createCalls: 0,
  failCreates: 0,         // next N create/update calls throw a 500
  reset() { this.events.clear(); this.createCalls = 0; this.failCreates = 0; },
};
if (DB_URL) {
  const gPath = require.resolve('../../lib/booking/googleCalendarClient');
  require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      createOrUpdateEvent: async (_t, _cal, body) => {
        google.createCalls++;
        if (google.failCreates > 0) { google.failCreates--; throw new Error('Calendar create 500: backendError'); }
        const existed = google.events.has(body.id) && google.events.get(body.id).status !== 'cancelled';
        google.events.set(body.id, { ...body, status: 'confirmed' });
        return { id: body.id, alreadyExisted: existed };
      },
      updateEvent: async (_t, _cal, id, body) => {
        if (google.failCreates > 0) { google.failCreates--; throw new Error('Calendar update 500: backendError'); }
        google.events.set(id, { ...body, id, status: 'confirmed' });
        return { id };
      },
      cancelEvent: async (_t, _cal, id) => {
        const e = google.events.get(id);
        if (e) e.status = 'cancelled';
        return { ok: true, alreadyGone: !e };
      },
      getEvent: async (_t, _cal, id) => {
        const e = google.events.get(id);
        return e && e.status !== 'cancelled' ? { exists: true } : { exists: false, reason: 'missing' };
      },
      listByExt: async () => [],
      listEvents: async () => [],
    },
  };
}

let base, server, db, token, repToken, outbox;
const ADMIN = { id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' };
let ipSeq = 1;

async function api(method, path, body, tok) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.0.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`, // rate limiter is per-IP
      ...(tok === null ? {} : { authorization: 'Bearer ' + (tok || token) }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

let seq = 0;
let lastPayload = null;
function capturePayload(extra) {
  seq++;
  return lastPayload = {
    first_name: 'Int', last_name: `Test${seq}${Date.now() % 100000}`,
    phone: `555${String(1000000 + seq * 7919 + (Date.now() % 1000)).slice(-7)}`,
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich',
    ...extra,
  };
}

// A far-future business day per test so slots never collide across cases.
// Random per-run base so re-running against the same database never
// collides with appointments left by an earlier run.
let dayOffset = Math.floor(Math.random() * 20000) * 3;
function uniqueDay() {
  dayOffset += 3;
  const d = new Date(Date.UTC(2032, 0, 5 + dayOffset));
  return d.toISOString().slice(0, 10);
}

async function drainOutbox() {
  // Run the real worker loop until nothing is claimable.
  for (let i = 0; i < 20; i++) {
    const r = await outbox.claimAndProcess(db.pool, 'int-test-worker', { batchSize: 50 });
    if (!r.claimed) return;
  }
}

async function getLead(id) {
  const r = await api('GET', `/api/v1/leads/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.lead;
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  outbox = require('../../lib/booking/calendarOutbox');
  const { issueAccessToken } = require('../../lib/authService');
  await db.query(
    `INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich')
     ON CONFLICT DO NOTHING`);
  token = issueAccessToken(ADMIN);
  repToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000b2', email: 'someone.else@ecconstructiongroup.com', role: 'sales_rep' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  app.use('/api/public/capture', require('../../routes/publicCapture'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

// ── 1–5: New Lead combinations + reopen ──────────────────────────────────────
test('1. New Lead with appointment only → Appointment set, Follow-up empty, no mirror', { skip }, async () => {
  const day = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '16:00' }), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const lead = await getLead(r.body.lead.id);
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.appointment_time, '16:00');
  assert.strictEqual(lead.appointment_type, 'Meeting');
  assert.strictEqual(lead.appointment.status, 'scheduled');
  assert.strictEqual(lead.follow_up_date, null, 'appointment must not be mirrored into follow-up');
  assert.strictEqual(lead.follow_up_type, null);
  assert.strictEqual(lead.status, 'Appointment Scheduled');
});

test('2. New Lead with follow-up only → no appointment row, follow-up persisted', { skip }, async () => {
  const r = await api('POST', '/api/public/capture', capturePayload({
    follow_up_date: '2031-03-02', follow_up_time: '10:15', follow_up_type: 'Phone Call', follow_up_notes: 'Call back re: budget',
  }), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.appointment, null);
  const lead = await getLead(r.body.lead.id);
  assert.strictEqual(lead.appointment, null);
  assert.strictEqual(lead.appointment_date, null);
  assert.strictEqual(lead.follow_up_date, '2031-03-02');
  assert.strictEqual(lead.follow_up_time, '10:15');
  assert.strictEqual(lead.follow_up_type, 'Phone Call');
  assert.strictEqual(lead.follow_up_notes, 'Call back re: budget');
  assert.strictEqual(lead.follow_up_status, 'pending');
  assert.strictEqual(lead.status, 'New');
  const appts = await db.query('SELECT count(*)::int AS n FROM appointments WHERE lead_id = $1', [lead.id]);
  assert.strictEqual(appts.rows[0].n, 0);
  const ob = await db.query(
    'SELECT count(*)::int AS n FROM calendar_outbox o JOIN appointments a ON a.id = o.appointment_id WHERE a.lead_id = $1', [lead.id]);
  assert.strictEqual(ob.rows[0].n, 0, 'a follow-up never enqueues Google Calendar work');
});

let bothLeadId, bothDay;
test('3. New Lead with BOTH → independent appointment + follow-up', { skip }, async () => {
  bothDay = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({
    appointment_date: bothDay, appointment_time: '16:00', appointment_type: 'Meeting',
    follow_up_date: '2031-04-10', follow_up_time: '09:30', follow_up_type: 'Text', follow_up_notes: 'Send proposal link',
  }), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  bothLeadId = r.body.lead.id;
  const lead = await getLead(bothLeadId);
  assert.strictEqual(lead.appointment_date, bothDay);
  assert.strictEqual(lead.appointment_time, '16:00');
  assert.strictEqual(lead.follow_up_date, '2031-04-10');
  assert.strictEqual(lead.follow_up_time, '09:30');
  assert.strictEqual(lead.follow_up_type, 'Text');
  assert.strictEqual(lead.follow_up_notes, 'Send proposal link');
});

test('4. New Lead with neither → plain lead, status New, nothing scheduled', { skip }, async () => {
  const r = await api('POST', '/api/public/capture', capturePayload({}), null);
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const lead = await getLead(r.body.lead.id);
  assert.strictEqual(lead.appointment, null);
  assert.strictEqual(lead.follow_up_date, null);
  assert.strictEqual(lead.status, 'New');
});

test('5. Reopen: list + detail + by-external/detail all return the same appointment and follow-up', { skip }, async () => {
  const one = await getLead(bothLeadId);
  const detail = await api('GET', `/api/v1/leads/by-external/${bothLeadId}/detail`);
  assert.strictEqual(detail.status, 200);
  const list = await api('GET', '/api/v1/leads?limit=5000');
  const fromList = list.body.items.find(l => l.id === bothLeadId);
  for (const l of [detail.body.lead, fromList]) {
    assert.strictEqual(l.appointment_date, one.appointment_date);
    assert.strictEqual(l.appointment_time, one.appointment_time);
    assert.strictEqual(l.appointment_id, one.appointment_id);
    assert.strictEqual(l.follow_up_date, one.follow_up_date);
    assert.strictEqual(l.follow_up_notes, one.follow_up_notes);
  }
});

// ── 6–9: edits + consistency ─────────────────────────────────────────────────
test('6. Edit appointment (reschedule + change kind) updates every representation atomically', { skip }, async () => {
  const before = await getLead(bothLeadId);
  const r = await api('PUT', `/api/v1/leads/${bothLeadId}/appointment`, {
    appointment_date: bothDay, appointment_time: '13:00', appointment_type: 'Phone Call',
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.action, 'appointment_rescheduled');
  const lead = r.body.lead;
  assert.strictEqual(lead.appointment_time, '13:00');
  assert.strictEqual(lead.appointment_type, 'Phone Call');
  assert.notStrictEqual(lead.appointment_id, before.appointment_id, 'reschedule creates the new active row');
  // Exactly one active appointment; the old one is 'rescheduled'.
  const rows = (await db.query('SELECT status FROM appointments WHERE lead_id = $1 ORDER BY created_at', [bothLeadId])).rows;
  assert.deepStrictEqual(rows.map(r => r.status), ['rescheduled', 'scheduled']);
  // Phone Call: no travel buffer.
  const a = (await db.query('SELECT lower(busy_range) = start_at AS no_buffer FROM appointments WHERE id = $1', [lead.appointment_id])).rows[0];
  assert.strictEqual(a.no_buffer, true);
  // The follow-up was NOT touched by the appointment edit.
  assert.strictEqual(lead.follow_up_date, '2031-04-10');
  assert.strictEqual(lead.follow_up_type, 'Text');
});

test('7. Edit follow-up (partial + full) never touches the appointment', { skip }, async () => {
  const before = await getLead(bothLeadId);
  let r = await api('PUT', `/api/v1/leads/${bothLeadId}/follow-up`, { follow_up_status: 'completed' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.lead.follow_up_status, 'completed');
  assert.strictEqual(r.body.lead.follow_up_date, '2031-04-10', 'partial edit keeps the date');
  r = await api('PUT', `/api/v1/leads/${bothLeadId}/follow-up`, {
    follow_up_date: '2031-05-01', follow_up_time: '11:45', follow_up_type: 'Email', follow_up_notes: 'Revised', follow_up_status: 'pending',
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const lead = r.body.lead;
  assert.deepStrictEqual(
    [lead.follow_up_date, lead.follow_up_time, lead.follow_up_type, lead.follow_up_notes, lead.follow_up_status],
    ['2031-05-01', '11:45', 'Email', 'Revised', 'pending']);
  assert.strictEqual(lead.appointment_id, before.appointment_id);
  assert.strictEqual(lead.appointment_time, before.appointment_time);
  // Legacy follow-up-shaped body sent to /appointment is saved as follow-up only.
  r = await api('PUT', `/api/v1/leads/${bothLeadId}/appointment`, { follow_up_date: '2031-05-02', follow_up_time: '08:00', follow_up_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.deprecated);
  assert.strictEqual(r.body.lead.follow_up_date, '2031-05-02');
  assert.strictEqual(r.body.lead.appointment_id, before.appointment_id, 'legacy follow-up body must not move the appointment');
  // Clear the follow-up entirely.
  r = await api('PUT', `/api/v1/leads/${bothLeadId}/follow-up`, { follow_up_date: null, follow_up_time: null, follow_up_type: null });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.lead.follow_up_date, null);
  assert.strictEqual(r.body.lead.follow_up_notes, null);
  assert.strictEqual(r.body.lead.appointment_id, before.appointment_id);
});

test('8. Refresh persistence: a fresh read after the edits returns the saved values', { skip }, async () => {
  await api('PUT', `/api/v1/leads/${bothLeadId}/follow-up`, {
    follow_up_date: '2031-06-01', follow_up_time: '14:00', follow_up_type: 'Phone Call', follow_up_notes: 'After refresh',
  });
  const lead = await getLead(bothLeadId);
  assert.strictEqual(lead.follow_up_date, '2031-06-01');
  assert.strictEqual(lead.follow_up_notes, 'After refresh');
  assert.strictEqual(lead.appointment_time, '13:00');
  const row = (await db.query('SELECT follow_up_date, follow_up_notes FROM leads WHERE id = $1', [bothLeadId])).rows[0];
  assert.strictEqual(row.follow_up_date, '2031-06-01');
});

test('9. Appointment and Meeting cannot contradict: every surface derives from the one appointments row', { skip }, async () => {
  const lead = await getLead(bothLeadId);
  const row = (await db.query('SELECT * FROM appointments WHERE id = $1', [lead.appointment_id])).rows[0];
  const { serializeAppointment } = require('../../lib/booking/appointmentView');
  const s = serializeAppointment(row);
  assert.strictEqual(lead.appointment_date, s.date);
  assert.strictEqual(lead.appointment_time, s.time);
  assert.strictEqual(lead.appointment_type, s.kind);
  assert.strictEqual(lead.google_calendar_sync_status, s.calendar_sync_status);
  // The pending Google event body describes the same instant and kind.
  const ob = (await db.query(
    "SELECT payload FROM calendar_outbox WHERE appointment_id = $1 AND action = 'create_main'", [row.id])).rows[0];
  assert.ok(ob.payload.start.dateTime.startsWith(`${s.date}T${s.time}`));
  assert.ok(ob.payload.summary.startsWith('Phone Call with'));
  // The reminder projection carries the same appointment.
  const rid = lead.external_ref || lead.id;
  const rl = (await db.query('SELECT appointment_date, appointment_time, appointment_type FROM reminder_leads WHERE id = $1', [rid])).rows[0];
  assert.deepStrictEqual([rl.appointment_date, rl.appointment_time, rl.appointment_type], [s.date, s.time, s.kind]);
});

// ── 10–12: Google Calendar via the real outbox ───────────────────────────────
test('10. Calendar sync success → google_event_id persisted, status synced, travel event for Meetings', { skip }, async () => {
  google.reset();
  const day = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '10:00' }), null);
  assert.strictEqual(r.status, 201);
  let lead = await getLead(r.body.lead.id);
  assert.strictEqual(lead.google_calendar_sync_status, 'pending');
  await drainOutbox();
  lead = await getLead(r.body.lead.id);
  assert.strictEqual(lead.google_calendar_sync_status, 'synced');
  assert.ok(lead.google_event_id);
  const ev = google.events.get(lead.google_event_id);
  assert.ok(ev, 'event exists in Google');
  assert.strictEqual(ev.start.dateTime, `${day}T10:00:00`);
  assert.strictEqual(ev.start.timeZone, 'America/Los_Angeles');
  assert.ok(lead.google_travel_event_id && google.events.has(lead.google_travel_event_id), 'Meeting gets a travel event');
});

test('11. Calendar sync failure is surfaced (retrying → failed) and a manual re-sync recovers', { skip }, async () => {
  google.reset();
  const day = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '11:00', appointment_type: 'Phone Call' }), null);
  const id = r.body.lead.id;
  google.failCreates = 1;
  await outbox.claimAndProcess(db.pool, 'int-test-worker', { batchSize: 50 });
  let lead = await getLead(id);
  assert.strictEqual(lead.google_calendar_sync_status, 'retrying', 'transient failure is visible, not an endless "Syncing"');
  assert.match(lead.google_calendar_sync_error, /500/);
  // Exhaust the retries (force next_attempt_at to now each round).
  google.failCreates = 99;
  for (let i = 0; i < 6; i++) {
    await db.query("UPDATE calendar_outbox SET next_attempt_at = NOW() WHERE appointment_id = $1", [lead.appointment_id]);
    await outbox.claimAndProcess(db.pool, 'int-test-worker', { batchSize: 50 });
  }
  lead = await getLead(id);
  assert.strictEqual(lead.google_calendar_sync_status, 'failed');
  const dead = (await db.query("SELECT status FROM calendar_outbox WHERE appointment_id = $1 AND action = 'create_main'", [lead.appointment_id])).rows[0];
  assert.strictEqual(dead.status, 'dead');
  // Manual re-sync re-enqueues the SAME appointment (no move, no new row).
  google.failCreates = 0;
  const rs = await api('POST', `/api/v1/leads/by-external/${id}/sync-calendar`);
  assert.strictEqual(rs.status, 200, JSON.stringify(rs.body));
  assert.strictEqual(rs.body.appointment_id, lead.appointment_id);
  await drainOutbox();
  lead = await getLead(id);
  assert.strictEqual(lead.google_calendar_sync_status, 'synced');
  assert.strictEqual(lead.google_calendar_sync_error, null);
});

test('12. No duplicate events: retries, re-syncs and reschedule leave exactly one live main event', { skip }, async () => {
  google.reset();
  const day = uniqueDay();
  const r = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '09:00' }), null);
  const id = r.body.lead.id;
  const firstPayload = lastPayload;
  await drainOutbox();
  // Exact same submit again (double click) → idempotent, no second appointment.
  const dup = await api('POST', '/api/public/capture', { ...firstPayload }, null);
  assert.strictEqual(dup.status, 200, JSON.stringify(dup.body));
  assert.strictEqual(dup.body.idempotent, true);
  assert.strictEqual(dup.body.lead.id, id);
  await api('POST', `/api/v1/leads/by-external/${id}/sync-calendar`);
  await api('POST', `/api/v1/leads/by-external/${id}/sync-calendar`);
  await drainOutbox();
  const live = () => [...google.events.values()].filter(e => e.status !== 'cancelled'
    && e.extendedProperties.private.ec_kind === 'main'
    && e.description.includes(`CRM Appointment ID:`)
    && e.start.dateTime.startsWith(day));
  assert.strictEqual(live().length, 1, 're-syncs adopt the deterministic event id');
  // Reschedule within the day: old event cancelled, one new live event.
  const up = await api('PUT', `/api/v1/leads/${id}/appointment`, { appointment_date: day, appointment_time: '15:00', appointment_type: 'Meeting' });
  assert.strictEqual(up.status, 200, JSON.stringify(up.body));
  await drainOutbox();
  const l = live();
  assert.strictEqual(l.length, 1, 'exactly one live main event after reschedule');
  assert.strictEqual(l[0].start.dateTime, `${day}T15:00:00`);
  // Cancel removes it.
  const c = await api('PUT', `/api/v1/leads/${id}/appointment`, { cancel: true });
  assert.strictEqual(c.status, 200);
  assert.strictEqual(c.body.lead.appointment, null);
  await drainOutbox();
  assert.strictEqual(live().length, 0);
  // Same-time save is a no-op (no new row, no new outbox rows).
  const again2 = await api('PUT', `/api/v1/leads/${id}/appointment`, { appointment_date: day, appointment_time: '15:00' });
  assert.strictEqual(again2.body.action, 'appointment_created');
  const n1 = (await db.query('SELECT count(*)::int n FROM calendar_outbox o JOIN appointments a ON a.id=o.appointment_id WHERE a.lead_id=$1', [id])).rows[0].n;
  const same = await api('PUT', `/api/v1/leads/${id}/appointment`, { appointment_date: day, appointment_time: '15:00' });
  assert.strictEqual(same.body.action, 'unchanged');
  const n2 = (await db.query('SELECT count(*)::int n FROM calendar_outbox o JOIN appointments a ON a.id=o.appointment_id WHERE a.lead_id=$1', [id])).rows[0].n;
  assert.strictEqual(n1, n2);
});

// ── 13: availability / buffer rules ──────────────────────────────────────────
test('13. Conflict rules: Meeting reserves 1h before + duration + 1h after; overlaps are rejected server-side', { skip }, async () => {
  const day = uniqueDay();
  const a = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '12:00' }), null);
  assert.strictEqual(a.status, 201);
  const row = (await db.query(
    "SELECT lower(busy_range) AS bs, upper(busy_range) AS be, start_at, end_at FROM appointments WHERE lead_id = $1 AND status='scheduled'",
    [a.body.lead.id])).rows[0];
  assert.strictEqual(new Date(row.start_at) - new Date(row.bs), 3600000);
  assert.strictEqual(new Date(row.be) - new Date(row.end_at), 3600000);
  // 13:30 overlaps the travel-after buffer (13:00–14:00) → 409 at capture.
  const bPayload = capturePayload({ appointment_date: day, appointment_time: '13:30' });
  const b = await api('POST', '/api/public/capture', bPayload, null);
  assert.strictEqual(b.status, 409, JSON.stringify(b.body));
  assert.strictEqual(b.body.error, 'conflict');
  // Nothing was created by the rejected submit (lead + appointment roll back together).
  const leads = (await db.query('SELECT count(*)::int n FROM leads WHERE last_name = $1', [bPayload.last_name])).rows[0].n;
  assert.strictEqual(leads, 0);
  // 14:00 starts exactly when the buffer ends → but its own 1h-before buffer overlaps → 409.
  const c = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '14:00' }), null);
  assert.strictEqual(c.status, 409);
  // 15:00 (its buffer starts 14:00 = previous buffer end) → allowed.
  const d = await api('POST', '/api/public/capture', capturePayload({ appointment_date: day, appointment_time: '15:00' }), null);
  assert.strictEqual(d.status, 201, JSON.stringify(d.body));
  // Lead Detail reschedule into a conflict → 409 slot_conflict, appointment unchanged.
  const lead = await getLead(d.body.lead.id);
  const e = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day, appointment_time: '12:30' });
  assert.strictEqual(e.status, 409);
  assert.strictEqual(e.body.error, 'slot_conflict');
  const after = await getLead(lead.id);
  assert.strictEqual(after.appointment_id, lead.appointment_id);
  assert.strictEqual(after.appointment_time, '15:00');
  // Authorized admin override books anyway and is audited.
  const f = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day, appointment_time: '12:30', admin_override: true });
  assert.strictEqual(f.status, 200, JSON.stringify(f.body));
  const ov = (await db.query('SELECT override_conflict, override_authorized, override_authorized_by FROM appointments WHERE id = $1', [f.body.lead.appointment_id])).rows[0];
  assert.deepStrictEqual([ov.override_conflict, ov.override_authorized, ov.override_authorized_by], [true, true, ADMIN.email]);
  // A non-admin cannot override.
  const g = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day, appointment_time: '12:15', admin_override: true }, repToken);
  assert.strictEqual(g.status, 403);
});

// ── 14: reminder timing ──────────────────────────────────────────────────────
test('14. Reminder timing uses the real appointment start (not the buffer, not the follow-up)', { skip }, async () => {
  const lead = await getLead(bothLeadId); // Phone Call appointment 13:00 + follow-up Phone Call 2031-06-01 14:00
  const { getAppointmentMs, computeWindowsForLead } = require('../../lib/reminderEngine');
  const { pacificToUtcMs } = require('../../lib/reminderTime');
  const rid = lead.external_ref || lead.id;
  // Switch the appointment back to a Meeting so the engine will remind.
  const r = await api('PUT', `/api/v1/leads/${bothLeadId}/appointment`, { appointment_date: bothDay, appointment_time: '16:00', appointment_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const rl = (await db.query('SELECT * FROM reminder_leads WHERE id = $1', [rid])).rows[0];
  const appt = getAppointmentMs(rl);
  const startRow = (await db.query('SELECT start_at, lower(busy_range) AS bs FROM appointments WHERE id = $1', [r.body.lead.appointment_id])).rows[0];
  assert.strictEqual(appt.ms, new Date(startRow.start_at).getTime(), 'reminder instant = appointment start_at');
  assert.notStrictEqual(appt.ms, new Date(startRow.bs).getTime(), 'not the travel-buffer start');
  assert.notStrictEqual(appt.ms, pacificToUtcMs('2031-06-01', '14:00'), 'not the follow-up');
  assert.strictEqual(appt.type, 'Meeting');
  // The 2h window fires exactly 2h before the real start.
  const wins = computeWindowsForLead(appt, Date.now() - 86400000 * 400, appt.ms - 2 * 3600000 + 60000);
  assert.deepStrictEqual(wins.map(w => w.key), ['2h']);
  // Cancelling the appointment clears the customer reminder source.
  await api('PUT', `/api/v1/leads/${bothLeadId}/appointment`, { cancel: true });
  const rl2 = (await db.query('SELECT * FROM reminder_leads WHERE id = $1', [rid])).rows[0];
  assert.strictEqual(rl2.appointment_date, null);
  const legacyOrNone = getAppointmentMs(rl2);
  assert.ok(legacyOrNone === null || legacyOrNone.type === 'Phone Call', 'no Meeting reminder without an appointment');
});

// ── 15: validation ───────────────────────────────────────────────────────────
test('15. Backend validation rejects malformed or conflicting state (400/404/409, nothing written)', { skip }, async () => {
  const cases = [
    [{ appointment_date: '2031-02-30', appointment_time: '10:00' }, /appointment_date/],
    [{ appointment_date: '2031-02-10' }, /appointment_time is required/],
    [{ appointment_time: '10:00' }, /appointment_date is required/],
    [{ appointment_date: '2031-02-10', appointment_time: '25:00' }, /appointment_time/],
    [{ appointment_date: '2031-02-10', appointment_time: '10:00', appointment_type: 'Lunch' }, /appointment_type/],
    [{ follow_up_date: '2031-02-10' }, /follow_up_type is required/],
    [{ follow_up_date: 'tomorrow', follow_up_type: 'Text' }, /follow_up_date/],
    [{ follow_up_date: '2031-02-10', follow_up_type: 'Fax' }, /follow_up_type/],
    [{ follow_up_date: '2031-02-10', follow_up_type: 'Text', follow_up_status: 'maybe' }, /follow_up_status/],
  ];
  for (const [extra, re] of cases) {
    const r = await api('POST', '/api/public/capture', capturePayload(extra), null);
    assert.strictEqual(r.status, 400, JSON.stringify(extra));
    assert.match(r.body.details.join(' '), re);
  }
  const lead = await getLead(bothLeadId);
  let r = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: '2031-13-01', appointment_time: '10:00' });
  assert.strictEqual(r.status, 400);
  r = await api('PUT', `/api/v1/leads/${lead.id}/follow-up`, { follow_up_type: 'Fax' });
  assert.strictEqual(r.status, 400);
  r = await api('PUT', `/api/v1/leads/${lead.id}/follow-up`, {});
  assert.strictEqual(r.status, 400);
  r = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { cancel: true });
  assert.strictEqual(r.status, 404, 'no active appointment to cancel');
  r = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: '2031-02-11', appointment_time: '10:00', expected_appointment_id: '00000000-0000-0000-0000-000000000000' });
  assert.strictEqual(r.status, 409, 'stale editor is rejected');
  // DB constraint backs the app validation.
  await assert.rejects(db.query("UPDATE leads SET follow_up_type = 'Fax' WHERE id = $1", [lead.id]), /leads_follow_up_type_check/);
  // Sales rep outside owner scope cannot write.
  r = await api('PUT', `/api/v1/leads/${lead.id}/follow-up`, { follow_up_date: '2031-02-10', follow_up_type: 'Text' }, repToken);
  assert.strictEqual(r.status, 403);
  // Unauthenticated → 401.
  r = await api('PUT', `/api/v1/leads/${lead.id}/follow-up`, { follow_up_date: '2031-02-10', follow_up_type: 'Text' }, null);
  assert.strictEqual(r.status, 401);
});

test('Audit classifier: exact mirror vs divergent vs follow-up only', { skip }, () => {
  const { classify } = require('../../scripts/auditAppointmentFollowUp');
  const appt = { id: 'a', start_at: '2031-01-10T00:00:00Z', end_at: '2031-01-10T01:00:00Z', status: 'scheduled',
    busy_range: '["2031-01-09 23:00:00+00","2031-01-10 02:00:00+00")', timezone: 'America/Los_Angeles' };
  assert.strictEqual(classify({ follow_up_date: '2031-01-09', follow_up_time: '16:00', follow_up_type: 'Meeting' }, [appt]).cls, 'MIRROR');
  assert.strictEqual(classify({ follow_up_date: '2031-01-09', follow_up_time: '16:00', follow_up_type: 'Meeting', follow_up_notes: 'x' }, [appt]).cls, 'DIVERGENT');
  assert.strictEqual(classify({ follow_up_date: '2031-01-12', follow_up_time: '16:00', follow_up_type: 'Meeting' }, [appt]).cls, 'DIVERGENT');
  assert.strictEqual(classify({ follow_up_date: '2031-01-09', follow_up_time: '16:00', follow_up_type: 'Phone Call' }, [appt]).cls, 'DIVERGENT');
  assert.strictEqual(classify({ follow_up_date: '2031-01-12', follow_up_type: 'Meeting' }, []).cls, 'FOLLOWUP_ONLY');
  assert.strictEqual(classify({ follow_up_date: '2031-01-12', follow_up_type: 'Text' }, [appt]), null);
  assert.strictEqual(classify({ follow_up_date: '2031-01-12', follow_up_type: 'Text' }, [appt, appt]).cls, 'MULTI_ACTIVE');
});

test('Audit classifier: ORPHANED_TYPE — a type with no date can never come from a validated save (metaWebhook conflation residue)', { skip }, () => {
  const { classify } = require('../../scripts/auditAppointmentFollowUp');
  const appt = { id: 'a', start_at: '2031-01-10T00:00:00Z', end_at: '2031-01-10T01:00:00Z', status: 'scheduled',
    busy_range: '["2031-01-09 23:00:00+00","2031-01-10 02:00:00+00")', timezone: 'America/Los_Angeles' };
  // The exact residue the pre-fix metaWebhook.js bug left behind: type set, date never touched.
  assert.strictEqual(classify({ follow_up_type: 'Meeting', follow_up_date: null }, []).cls, 'ORPHANED_TYPE');
  // Same signature even when the lead separately has a real active appointment —
  // ORPHANED_TYPE is checked before any appointment-comparison logic.
  assert.strictEqual(classify({ follow_up_type: 'Meeting', follow_up_date: null }, [appt]).cls, 'ORPHANED_TYPE');
  // Not specific to 'Meeting' — any type with no date is equally impossible via normalizeFollowUp.
  assert.strictEqual(classify({ follow_up_type: 'Phone Call', follow_up_date: null }, []).cls, 'ORPHANED_TYPE');
  // A real, dated follow-up (even mid-edit with only date cleared) is NOT this class.
  assert.strictEqual(classify({ follow_up_type: null, follow_up_date: null }, []), null);
  assert.strictEqual(classify({ follow_up_type: 'Meeting', follow_up_date: '2031-01-12' }, []).cls, 'FOLLOWUP_ONLY');
});
