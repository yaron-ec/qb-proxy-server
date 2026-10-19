/* eslint-disable no-undef */
'use strict';

/**
 * calendarAttendeesIgnoreEmailPreferences.int.test.js — REAL-Postgres proof
 * of the fix for a production incident: Michelle (michelle@ecconstructiongroup.com)
 * reported appointments previously visible on her Google Calendar — including
 * ones expected that day — had disappeared.
 *
 * ROOT CAUSE: lib/booking/calendarOutbox.js's enqueueCreate/enqueueUpdate and
 * lib/booking/followUpReminders.js's meeting representation both computed the
 * Google Calendar event's staff ATTENDEE list by calling
 * notificationPreferences.filterRecipientsForCategory(..., CATEGORIES.APPOINTMENT
 * / CATEGORIES.FOLLOW_UP) — the exact same mechanism used to decide whether a
 * staff member receives a CRM-generated EMAIL. This was dormant until
 * migration 2026-62 (part of the "Michelle: new-lead-only notifications" PR)
 * correctly disabled Michelle's 'appointment' and 'follow_up' EMAIL
 * categories — at which point it ALSO silently dropped her from the Google
 * Calendar invite's attendee list for every appointment/meeting-follow-up
 * created or updated afterward. Removing an attendee from an updated Google
 * event removes the event from their calendar entirely; a newly created
 * event never reached her to begin with.
 *
 * THE FIX: calendar attendee membership is now ALWAYS
 * notificationRecipients.getAllStaffRecipients() UNFILTERED — see
 * calendarOutbox.js's header "PERMANENT RULE". This file proves that even
 * with Michelle's 'appointment' and 'follow_up' categories explicitly
 * disabled (reproducing the exact production condition), she is STILL
 * invited to: a newly created real Appointment's main event, an updated/
 * rescheduled Appointment's main event, and an active Meeting follow-up's
 * calendar representation.
 *
 * Skipped without TEST_DATABASE_URL.
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

const MICHELLE = 'michelle@ecconstructiongroup.com';

// ── Fake Google Calendar ─────────────────────────────────────────────────
const google = { events: new Map(), reset() { this.events.clear(); } };
if (DB_URL) {
  const gPath = require.resolve('../../lib/booking/googleCalendarClient');
  require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      createOrUpdateEvent: async (_t, _c, body) => { google.events.set(body.id, { ...body, status: 'confirmed' }); return { id: body.id }; },
      updateEvent: async (_t, _c, id, body) => { google.events.set(id, { ...body, id, status: 'confirmed' }); return { id }; },
      cancelEvent: async (_t, _c, id) => { const e = google.events.get(id); if (e) e.status = 'cancelled'; return { ok: true }; },
      getEvent: async (_t, _c, id) => { const e = google.events.get(id); return e && e.status !== 'cancelled' ? { exists: true } : { exists: false, reason: 'missing' }; },
      listByExt: async () => [],
      listEvents: async () => [],
    },
  };
}

let base, server, db, token, outbox, ownerId, pickDay, googleModulesState;
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-forwarded-for': `10.9.0.${1 + Math.floor(Math.random() * 250)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

let seq = 0;
const randomPhone = () => `${200 + Math.floor(Math.random() * 600)}${200 + Math.floor(Math.random() * 600)}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
async function createLead() {
  seq++;
  const tag = `${seq}${Date.now() % 1000000}`;
  const r = await api('POST', '/api/v1/leads', {
    first_name: 'Att', last_name: `Pref${tag}`, phone: randomPhone(),
    assigned_rep: 'Yaron Drilevich', project_type: 'Kitchen', source: 'Referral',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}
async function drain() {
  for (let i = 0; i < 20; i++) if (!(await outbox.claimAndProcess(db.pool, 'attendee-pref-test-worker', { batchSize: 50 })).claimed) return;
}
function mainEventFor(appt) {
  return [...google.events.values()].find((e) =>
    e.status !== 'cancelled' && e.extendedProperties?.private?.ec_appointment_id === appt.id && e.extendedProperties?.private?.ec_kind === 'main');
}
const reconcileFollowUps = (now) => require('../../lib/booking/followUpReminders')
  .reconcileFollowUpReminders(db.pool, { google: require('../../lib/booking/googleCalendarClient'), limit: 100000, delayMs: 0, crmPublicUrl: '', ...(now ? { now } : {}) });
function liveMeetingMainEvent(leadId) {
  return [...google.events.values()].find((e) => e.status !== 'cancelled'
    && typeof e.extendedProperties?.private?.ec_appointment_id === 'string'
    && e.extendedProperties.private.ec_appointment_id.startsWith(`followup-meeting:${leadId}:`)
    && e.extendedProperties.private.ec_kind === 'main');
}

let notifRecipientsState = null;

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  outbox = require('../../lib/booking/calendarOutbox');
  googleModulesState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db);
  require('../../lib/companyConfig').invalidate();
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'yaron@ecconstructiongroup.com'`)).rows[0].id;
  token = require('../../lib/authService').issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });

  // Guarantee the precondition: Michelle is a configured staff recipient AND
  // has BOTH 'appointment' and 'follow_up' email categories explicitly
  // disabled — reproducing the exact production condition (migration
  // 2026-62), regardless of what this disposable DB's migration history or
  // an earlier test file in the same run already set.
  const existing = (await db.query('SELECT id, notification_recipients FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  const nr = (existing && existing.notification_recipients) || { to: [], cc: [] };
  const hasMichelle = (nr.to || []).includes(MICHELLE) || (nr.cc || []).includes(MICHELLE);
  if (existing && !hasMichelle) {
    notifRecipientsState = { id: existing.id, previous: nr };
    const merged = { to: nr.to || [], cc: Array.from(new Set([...(nr.cc || []), MICHELLE])) };
    await db.query('UPDATE company_settings SET notification_recipients = $1 WHERE id = $2', [JSON.stringify(merged), existing.id]);
  }
  await db.query(
    `INSERT INTO notification_preferences (user_email, category, enabled) VALUES ($1, 'appointment', false), ($1, 'follow_up', false)
     ON CONFLICT (user_email, category) DO UPDATE SET enabled = false`,
    [MICHELLE]
  );
  require('../../lib/companyConfig').invalidate();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  // Restore: re-enable Michelle's categories only if we're the ones who
  // disabled them (we always set them false above — restore to enabled by
  // deleting the rows, matching the table's documented "absence = enabled" default).
  await db.query(`DELETE FROM notification_preferences WHERE user_email = $1 AND category IN ('appointment','follow_up')`, [MICHELLE]);
  if (notifRecipientsState) {
    await db.query('UPDATE company_settings SET notification_recipients = $1 WHERE id = $2', [JSON.stringify(notifRecipientsState.previous), notifRecipientsState.id]);
  }
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, googleModulesState);
  require('../../lib/companyConfig').invalidate();
  await db.pool.end();
});
test.beforeEach(async () => { if (!skip) google.reset(); });

test('1. A newly CREATED Appointment invites Michelle even though her "appointment" email category is disabled', { skip }, async () => {
  const lead = await createLead();
  const day = pickDay();
  const r = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day, appointment_time: '14:00', appointment_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await drain();

  const apptRow = (await db.query(`SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [lead.id])).rows[0];
  const main = mainEventFor(apptRow);
  assert.ok(main, 'main event was created');
  assert.ok(main.attendees.some((a) => a.email === MICHELLE),
    'Michelle is still invited to a newly created Appointment despite her disabled "appointment" EMAIL category — calendar attendee membership must never be gated by an email preference');
});

test('2. UPDATING/rescheduling an existing Appointment keeps Michelle on the attendee list', { skip }, async () => {
  const lead = await createLead();
  const day1 = pickDay();
  const book = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day1, appointment_time: '09:00', appointment_type: 'Meeting' });
  assert.strictEqual(book.status, 200, JSON.stringify(book.body));
  await drain();

  const day2 = pickDay();
  const reschedule = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day2, appointment_time: '10:00', appointment_type: 'Meeting' });
  assert.strictEqual(reschedule.status, 200, JSON.stringify(reschedule.body));
  await drain();

  const apptRow = (await db.query(`SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed')`, [lead.id])).rows[0];
  const main = mainEventFor(apptRow);
  assert.ok(main, 'rescheduled main event exists');
  assert.ok(main.attendees.some((a) => a.email === MICHELLE),
    'Michelle remains an attendee after a reschedule (enqueueUpdate path) despite her disabled "appointment" EMAIL category — this is exactly the update path that silently removed her in the production incident');
});

test('3. An active Meeting follow-up\'s calendar representation invites Michelle even though her "follow_up" email category is disabled', { skip }, async () => {
  const lead = await createLead();
  const day = pickDay();
  const r = await api('PUT', `/api/v1/leads/${lead.id}/follow-up`, { follow_up_date: day, follow_up_time: '11:00', follow_up_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const s = await reconcileFollowUps();
  assert.ok(s.upserted >= 1, JSON.stringify(s));
  const main = liveMeetingMainEvent(lead.id);
  assert.ok(main, 'meeting follow-up main event exists');
  assert.ok(main.attendees.some((a) => a.email === MICHELLE),
    'Michelle is still invited to the Meeting follow-up\'s calendar representation despite her disabled "follow_up" EMAIL category');
});
