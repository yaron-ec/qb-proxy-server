/* eslint-disable no-undef */
'use strict';

/**
 * phoneCallFollowUp.int.test.js — REAL-Postgres proof that a Phone Call
 * FOLLOW-UP keeps its customer reminder email AND never blocks the calendar.
 * Skipped without TEST_DATABASE_URL.
 *
 * Business rule (decided — do not change):
 *   REMINDER: a Phone Call follow-up sends its existing reminder emails (owner +
 *             Michelle + the customer) via lib/phoneCallReminders.js.
 *   CALENDAR: it is NOT an appointment — no blocking window, no 1h-before or
 *             1h-after buffer, no Driving/Travel Time, no Google Calendar event,
 *             and a real Appointment can be booked at exactly the same time.
 * Sending the reminder must never create/mutate an appointment or make
 * availability treat the follow-up as one.
 *
 * Only the email transport (lib/emailService, lib/gmailSender) and Google
 * Calendar are faked; the reminder engines, projection and booking run for real.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');
const TZ = 'America/Los_Angeles';

const sent = [];
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  class GmailCredentialsError extends Error {}
  stub('lib/gmailSender', { GmailCredentialsError, refreshAccessToken: async () => 'fake-token' });
  stub('lib/emailService', {
    send: async (msg) => { sent.push(msg); return { ok: true, gmailMessageId: `m${sent.length}` }; },
  });
  stub('lib/booking/googleCalendarClient', {
    getAccessToken: async () => 'fake', createOrUpdateEvent: async (_t, _c, b) => ({ id: b.id }),
    updateEvent: async (_t, _c, id) => ({ id }), cancelEvent: async () => ({ ok: true }),
    getEvent: async () => ({ exists: false }), listByExt: async () => [], listEvents: async () => [],
  });
  stub('lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
}

let base, server, db, token, ownerId;
async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-forwarded-for': `10.6.0.${1 + Math.floor(Math.random() * 250)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

// Pacific wall-clock date/time `minutes` from now.
function laIn(minutes) {
  const d = new Date(Date.now() + minutes * 60000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require(path.join(ROOT, 'db/client'));
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = 'yaron@ecconstructiongroup.com'`)).rows[0].id;
  // This test books a real appointment at "now + 55 min" TODAY; an earlier run
  // against the same disposable database would otherwise occupy that slot.
  await cancelOwnAppointments();
  token = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  app.use('/api/public/capture', require(path.join(ROOT, 'routes/publicCapture')));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

async function cancelOwnAppointments() {
  await db.query(`UPDATE appointments SET status = 'cancelled'
                   WHERE status IN ('scheduled', 'confirmed')
                     AND lead_id IN (SELECT id FROM leads WHERE last_name LIKE 'Caller%' AND first_name = 'Pat')`);
}

test.after(async () => {
  if (skip) return;
  await cancelOwnAppointments();
  server.close();
  await db.pool.end();
});

test('P1. Phone Call follow-up: customer reminder email still sent, calendar never blocked, real Appointment books at the same time', { skip }, async () => {
  // A call 55 minutes out → the 1h reminder window opened 5 minutes ago.
  const call = laIn(55);
  const tag = `Caller${Date.now() % 1e7}`;
  const email = `${tag.toLowerCase()}@example.com`;
  const { getAvailability } = require(path.join(ROOT, 'lib/booking/availabilityService'));
  const avBefore = await getAvailability({ owner_id: ownerId, date: call.date, timezone: TZ, duration_minutes: 60 });

  const r = await api('POST', '/api/public/capture', {
    first_name: 'Pat', last_name: tag, email, phone: `213${String(Date.now() % 1e7).padStart(7, '0')}`,
    project_type: 'Kitchen', source: 'Referral', assigned_rep: 'Yaron Drilevich',
    follow_up_date: call.date, follow_up_time: call.time, follow_up_type: 'Phone Call',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.appointment, null);
  const leadId = r.body.lead.id;

  // 1–5. No blocking window, no buffer, no travel, no calendar event.
  const counts = async () => ({
    appointments: Number((await db.query('SELECT count(*) n FROM appointments WHERE lead_id = $1', [leadId])).rows[0].n),
    outbox: Number((await db.query('SELECT count(*) n FROM calendar_outbox o JOIN appointments a ON a.id = o.appointment_id WHERE a.lead_id = $1', [leadId])).rows[0].n),
  });
  assert.deepStrictEqual(await counts(), { appointments: 0, outbox: 0 });
  const avAfterCreate = await getAvailability({ owner_id: ownerId, date: call.date, timezone: TZ, duration_minutes: 60 });
  assert.deepStrictEqual(avAfterCreate.busy_windows, avBefore.busy_windows, 'no busy window, no 1h-before/after buffer');
  assert.deepStrictEqual(avAfterCreate.blocked_slots, avBefore.blocked_slots);

  // 6. The reminder/email still works (the decided behaviour): owner + Michelle + customer.
  const { processPhoneCallReminders } = require(path.join(ROOT, 'lib/phoneCallReminders'));
  const run = await processPhoneCallReminders({ dryRun: false, triggeredBy: 'int-test' });
  assert.strictEqual(run.ok, true, JSON.stringify(run));
  const mine = sent.filter(m => String(m.idempotencyKey || '').includes(leadId));
  const customer = mine.filter(m => m.to === email);
  assert.strictEqual(customer.length, 1, 'customer Phone Call reminder email sent');
  assert.match(customer[0].subject, /^Phone Call Reminder in 1 hour — EC Construction Group$/);
  assert.ok(mine.some(m => m.to === 'yaron@ecconstructiongroup.com'), 'owner reminder');
  assert.ok(mine.some(m => m.to === 'michelle@ecconstructiongroup.com'), 'Michelle copied');
  const claim = (await db.query(`SELECT status FROM reminder_claims WHERE reminder_key LIKE $1`, [`phone_reminder:%:1h:${call.date}`])).rows;
  assert.ok(claim.some(c => c.status === 'sent'));

  // …and the APPOINTMENT reminder engine sends nothing for it (it is not an appointment).
  const { processReminders } = require(path.join(ROOT, 'lib/reminderEngine'));
  const before = sent.length;
  await processReminders({ dryRun: false, triggeredBy: 'int-test' });
  assert.strictEqual(sent.slice(before).filter(m => String(m.idempotencyKey || '').includes(leadId) || m.to === email).length, 0,
    'no appointment reminder for a follow-up');

  // 7–8. Sending the reminder created/mutated no appointment and changed no availability.
  assert.deepStrictEqual(await counts(), { appointments: 0, outbox: 0 });
  const avAfterSend = await getAvailability({ owner_id: ownerId, date: call.date, timezone: TZ, duration_minutes: 60 });
  assert.deepStrictEqual(avAfterSend.busy_windows, avBefore.busy_windows);
  const lead = (await api('GET', `/api/v1/leads/${leadId}`)).body.lead;
  assert.strictEqual(lead.appointment, null);
  assert.deepStrictEqual([lead.follow_up_type, lead.follow_up_date, lead.follow_up_time], ['Phone Call', call.date, call.time]);
  const rl = (await db.query('SELECT appointment_date, appointment_type FROM reminder_leads WHERE id = $1', [leadId])).rows[0];
  assert.deepStrictEqual(rl, { appointment_date: null, appointment_type: null });

  // A real Appointment at exactly the call time is allowed and behaves as an appointment.
  const book = await api('PUT', `/api/v1/leads/${leadId}/appointment`, { appointment_date: call.date, appointment_time: call.time, appointment_type: 'Meeting' });
  assert.strictEqual(book.status, 200, JSON.stringify(book.body));
  const after = (await api('GET', `/api/v1/leads/${leadId}`)).body.lead;
  assert.strictEqual(after.appointment_time, call.time);
  assert.strictEqual(after.follow_up_type, 'Phone Call', 'the follow-up is untouched');
  const appt = (await db.query('SELECT start_at, end_at, lower(busy_range) bs, upper(busy_range) be FROM appointments WHERE lead_id = $1 AND status = $2', [leadId, 'scheduled'])).rows[0];
  assert.strictEqual(new Date(appt.start_at) - new Date(appt.bs), 3600000, 'the APPOINTMENT gets its 1h-before buffer');
  assert.strictEqual(new Date(appt.be) - new Date(appt.end_at), 3600000, 'and its 1h-after buffer');
});
