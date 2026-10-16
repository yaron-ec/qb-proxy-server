/* eslint-disable no-undef */
'use strict';

/**
 * closedLostTransition.int.test.js — REAL-Postgres proof of the Closed Lost
 * business rule (production bug report): when a lead changes to 'Closed
 * Lost', every future customer-facing reminder/follow-up must stop, any
 * upcoming (not-yet-resolved) appointment must be cancelled in the CRM AND
 * its Google Calendar event removed, a genuinely completed appointment must
 * be preserved exactly as-is, and none of this may ever be auto-restored by
 * simply reopening the lead later.
 *
 * Google Calendar is an in-memory fake at the lib/booking/googleCalendarClient
 * boundary; everything else (routes -> leads.js -> bookingService -> calendar
 * outbox -> worker -> reminder projection -> reminder engines) is real.
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const TZ = 'America/Los_Angeles';

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

const google = { events: new Map(), failCancelFor: null, reset() { this.events.clear(); this.failCancelFor = null; } };
if (DB_URL) {
  const gPath = require.resolve('../../lib/booking/googleCalendarClient');
  require.cache[gPath] = {
    id: gPath, filename: gPath, loaded: true,
    exports: {
      getAccessToken: async () => 'fake-token',
      createOrUpdateEvent: async (_t, _c, body) => { google.events.set(body.id, { ...body, status: 'confirmed' }); return { id: body.id }; },
      updateEvent: async (_t, _c, id, body) => { google.events.set(id, { ...body, id, status: 'confirmed' }); return { id }; },
      cancelEvent: async (_t, _c, id) => {
        if (google.failCancelFor && google.failCancelFor === id) throw new Error('simulated Google API failure');
        const e = google.events.get(id); if (e) e.status = 'cancelled'; return { ok: true };
      },
      getEvent: async (_t, _c, id) => { const e = google.events.get(id); return e && e.status !== 'cancelled' ? { exists: true } : { exists: false, reason: 'missing' }; },
      listByExt: async () => [],
      listEvents: async () => [],
    },
  };
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('../../lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
  class GmailCredentialsError extends Error {}
  stub('../../lib/gmailSender', { GmailCredentialsError, refreshAccessToken: async () => 'fake-token' });
  const sentEmails = [];
  stub('../../lib/emailService', { send: async (opts) => { sentEmails.push(opts); return { ok: true, gmailMessageId: 'm' + sentEmails.length }; } });
  global.__sentEmails = sentEmails;
}

let base, server, db, token, outbox, ownerId, pickDay, googleModulesState;
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-forwarded-for': `10.7.0.${1 + Math.floor(Math.random() * 250)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}
const rows = async (sql, p) => (await db.query(sql, p)).rows;

async function drain() {
  for (let i = 0; i < 20; i++) if (!(await outbox.claimAndProcess(db.pool, 'closed-lost-worker', { batchSize: 50 })).claimed) return;
}
async function parkForeignOutbox() {
  await db.query(`UPDATE calendar_outbox SET next_attempt_at = '2999-01-01' WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()`);
}

let seq = 0;
const randomPhone = () => `${200 + Math.floor(Math.random() * 600)}${200 + Math.floor(Math.random() * 600)}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

async function createLead(extra) {
  seq++;
  const tag = `${seq}${Date.now() % 1000000}`;
  const r = await api('POST', '/api/v1/leads', {
    first_name: 'Cl', last_name: `Test${tag}`, phone: randomPhone(),
    assigned_rep: 'Yaron Drilevich', project_type: 'Kitchen', source: 'Referral',
    ...(extra && extra.email ? { ...extra, email: `cl${tag}@example.com` } : extra),
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.lead;
}
// Books via the real API, then drains the outbox once so the appointment's
// `google_event_id` is actually populated (it is written only by the worker,
// after a real — here, faked — Google create call; right after the booking
// API call returns, it is still null) — every caller needs a truly "synced"
// appointment to meaningfully assert on its calendar event later.
async function bookAppointment(leadId, date, time, type = 'Meeting') {
  const r = await api('PUT', `/api/v1/leads/${leadId}/appointment`, { appointment_date: date, appointment_time: time, appointment_type: type });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await drain();
  return (await apptsOf(leadId)).find(a => a.status === 'scheduled' || a.status === 'confirmed');
}
async function setStatus(leadId, status) {
  return api('PUT', `/api/v1/leads/${leadId}`, { status });
}
async function getLead(leadId) {
  const r = await api('GET', `/api/v1/leads/${leadId}`);
  assert.strictEqual(r.status, 200);
  return r.body.lead;
}
async function apptsOf(leadId) { return rows('SELECT * FROM appointments WHERE lead_id = $1 ORDER BY created_at', [leadId]); }
async function activeAppt(leadId) { return rows(`SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed') ORDER BY created_at DESC LIMIT 1`, [leadId]); }
async function outboxOf(apptId) { return rows('SELECT action, status, google_event_id FROM calendar_outbox WHERE appointment_id = $1 ORDER BY created_at', [apptId]); }
async function reminderLeadOf(lead) { return (await rows('SELECT * FROM reminder_leads WHERE id = $1', [lead.external_ref || lead.id]))[0]; }
async function activitiesOf(leadId) { return rows('SELECT content FROM activities WHERE lead_id = $1 ORDER BY created_at', [leadId]); }

// Insert an appointment row directly (fixture) — used to set up states the
// HTTP API itself cannot produce (an already-'completed' appointment, or a
// 'scheduled' one whose start time is already in the past).
async function insertAppointmentFixture(leadId, { status = 'scheduled', startOffsetMs = 7 * 86400000 } = {}) {
  const type = (await rows("SELECT id FROM appointment_types WHERE name = 'Consultation'"))[0].id;
  const start = new Date(Date.now() + startOffsetMs).toISOString();
  const a = (await rows(
    `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status,
                               idempotency_key, calendar_sync_status, google_event_id)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 hour', $5,
             tstzrange($4::timestamptz, $4::timestamptz + interval '1 hour', '[)'), $6, $7, 'synced', $8)
     RETURNING *`,
    [leadId, ownerId, type, start, TZ, status, `fixture-${Date.now()}-${Math.random()}`, `fixture-main-${seq}-${Date.now()}`]
  ))[0];
  google.events.set(a.google_event_id, { id: a.google_event_id, status: 'confirmed', summary: 'fixture' });
  return a;
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  outbox = require('../../lib/booking/calendarOutbox');
  // Captured and restored in test.after — leaving a placeholder
  // company_settings row behind (when none existed yet) would pollute every
  // other integration-test file sharing this same disposable database (see
  // test/integration/ensureGoogleModulesEnabled.js's own header).
  googleModulesState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db);
  require('../../lib/companyConfig').invalidate();
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  ownerId = (await rows(`SELECT id FROM owners WHERE email = 'yaron@ecconstructiongroup.com'`))[0].id;
  token = require('../../lib/authService').issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  server.close();
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, googleModulesState);
  require('../../lib/companyConfig').invalidate();
  await db.pool.end();
});
test.beforeEach(async () => { if (!skip) { google.reset(); await parkForeignOutbox(); global.__sentEmails.length = 0; } });

test('1. Upcoming appointment -> Closed Lost -> CRM cancelled + Google Calendar event removed + zero future reminders', { skip }, async () => {
  const lead = await createLead({});
  const day = pickDay();
  const appt = await bookAppointment(lead.id, day, '14:00', 'Meeting');
  assert.strictEqual(appt.status, 'scheduled');

  const r = await setStatus(lead.id, 'Closed Lost');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.lead.appointment, null, 'the active appointment is gone from the response');

  const [cancelled] = await apptsOf(lead.id);
  assert.strictEqual(cancelled.status, 'cancelled', 'CRM appointment row is cancelled, not deleted');

  await drain();
  const googleEvent = google.events.get(cancelled.google_event_id);
  assert.strictEqual(googleEvent.status, 'cancelled', 'the Google Calendar event was actually removed');

  const rl = await reminderLeadOf(lead);
  assert.strictEqual(rl.follow_up_date, null);
  assert.strictEqual(rl.appointment_date, null, 'reminder_leads projection cleared — the appointment reminder engine has nothing left to fire on');

  const acts = await activitiesOf(lead.id);
  assert.ok(acts.some(a => /Closed Lost/.test(a.content) && /cancelled/.test(a.content)), 'audit trail note recorded');
});

test('2. Completed appointment -> Closed Lost -> appointment preserved in history + follow-up cleared + zero future reminders', { skip }, async () => {
  const lead = await createLead({});
  const completed = await insertAppointmentFixture(lead.id, { status: 'completed', startOffsetMs: -14 * 86400000 });
  // A lingering follow-up on the lead (e.g. "check in after the visit") must
  // still be cleared even though there's no active appointment to cancel.
  await api('PUT', `/api/v1/leads/${lead.id}/follow-up`, { follow_up_date: pickDay(), follow_up_time: '10:00', follow_up_type: 'Phone Call' });

  const beforeEventsCount = google.events.size;
  const r = await setStatus(lead.id, 'Closed Lost');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const [row] = await apptsOf(lead.id);
  assert.strictEqual(row.id, completed.id);
  assert.strictEqual(row.status, 'completed', 'a genuinely completed appointment is NEVER touched by the Closed Lost transition');
  assert.strictEqual(row.version, completed.version, 'not even a version bump — truly untouched');
  assert.deepStrictEqual(await outboxOf(completed.id), [], 'no cancel enqueued for a completed appointment');
  await drain();
  assert.strictEqual(google.events.size, beforeEventsCount, 'no Google Calendar call was ever made for the completed appointment\'s event');
  assert.strictEqual(google.events.get(completed.google_event_id).status, 'confirmed', 'its calendar event is untouched — preserved as history');

  const l = await getLead(lead.id);
  assert.deepStrictEqual([l.follow_up_date, l.follow_up_time, l.follow_up_type], [null, null, null], 'the lingering follow-up was cleared');
  const rl = await reminderLeadOf(lead);
  assert.strictEqual(rl.follow_up_date, null);
});

test('3. Past but not-yet-resolved appointment (still scheduled) -> Closed Lost -> cancelled, never assumed completed', { skip }, async () => {
  const lead = await createLead({});
  const pastScheduled = await insertAppointmentFixture(lead.id, { status: 'scheduled', startOffsetMs: -3 * 86400000 });

  const r = await setStatus(lead.id, 'Closed Lost');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const [row] = await apptsOf(lead.id);
  assert.strictEqual(row.id, pastScheduled.id);
  assert.strictEqual(row.status, 'cancelled', 'a past-due but never-resolved appointment is cancelled, not silently treated as completed');
  await drain();
  assert.strictEqual(google.events.get(pastScheduled.google_event_id).status, 'cancelled');
});

test('4. Reschedule then Closed Lost: only the CURRENT active appointment is cancelled; the superseded "rescheduled" row is untouched', { skip }, async () => {
  const lead = await createLead({});
  const day1 = pickDay();
  const first = await bookAppointment(lead.id, day1, '09:00', 'Meeting');
  const day2 = pickDay();
  const rescheduleRes = await api('PUT', `/api/v1/leads/${lead.id}/appointment`, { appointment_date: day2, appointment_time: '11:00', appointment_type: 'Meeting' });
  assert.strictEqual(rescheduleRes.status, 200, JSON.stringify(rescheduleRes.body));

  const all = await apptsOf(lead.id);
  assert.strictEqual(all.length, 2);
  const oldRow = all.find(a => a.id === first.id);
  const newRow = all.find(a => a.id !== first.id);
  assert.strictEqual(oldRow.status, 'rescheduled');
  assert.strictEqual(newRow.status, 'scheduled');

  const r = await setStatus(lead.id, 'Closed Lost');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const after = await apptsOf(lead.id);
  const oldAfter = after.find(a => a.id === first.id);
  const newAfter = after.find(a => a.id !== first.id);
  assert.strictEqual(oldAfter.status, 'rescheduled', 'the already-superseded row is never touched a second time');
  assert.strictEqual(oldAfter.version, oldRow.version, 'no version bump on the superseded row');
  assert.strictEqual(newAfter.status, 'cancelled', 'only the one row that was actually active gets cancelled');
});

test('5. Already-sent reminders + a concurrent-style second worker pass: zero additional sends after Closed Lost, and the crmRepository safety-net excludes the lead even independent of projection clearing', { skip }, async () => {
  const lead = await createLead({ email: 'placeholder@example.com' });
  // A real appointment ~30 minutes out puts the engine's '30min' window
  // eligible RIGHT NOW (diff against the window target is ~0, inside the
  // 25-minute eligibility band) — proving a genuinely "already fired"
  // reminder, not just an absence of one.
  const soon = new Date(Date.now() + 30 * 60000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(soon).map(p => [p.type, p.value]));
  const apptDate = `${parts.year}-${parts.month}-${parts.day}`;
  const apptTime = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  await bookAppointment(lead.id, apptDate, apptTime, 'Meeting');

  const { processReminders } = require('../../lib/reminderEngine');
  const before = global.__sentEmails.length;
  await processReminders({ dryRun: false, triggeredBy: 'test' });
  assert.ok(global.__sentEmails.length > before, 'precondition: the engine genuinely sent a reminder for this appointment before Closed Lost');

  const r = await setStatus(lead.id, 'Closed Lost');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const afterClose = global.__sentEmails.length;
  await processReminders({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(global.__sentEmails.length, afterClose, 'a second engine run after Closed Lost sends nothing new for this lead, even though it already had a live, firing reminder moments earlier');

  // Safety-net check: even if we pretend the projection were still stale
  // (simulating a lead that was already Closed Lost before this fix shipped),
  // the crmRepository join-based filter excludes it on leads.status alone.
  await db.query(
    `UPDATE reminder_leads SET appointment_date = $2, appointment_time = $3, appointment_type = 'Meeting' WHERE id = $1`,
    [lead.external_ref || lead.id, apptDate, apptTime]
  );
  const crmRepository = require('../../lib/crmRepository');
  const eligible = await crmRepository.listEligibleLeads();
  assert.ok(!eligible.some(l => l.id === (lead.external_ref || lead.id)), 'crmRepository excludes a Closed Lost lead regardless of what its stale projection still holds');
});

test('6. Google Calendar cancellation failure is retried safely — CRM status is correct immediately; the calendar event is NOT silently marked removed until it actually succeeds', { skip }, async () => {
  const lead = await createLead({});
  const day = pickDay();
  const appt = await bookAppointment(lead.id, day, '15:00', 'Meeting');

  google.failCancelFor = appt.google_event_id || (await apptsOf(lead.id))[0].google_event_id;
  const r = await setStatus(lead.id, 'Closed Lost');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const [row] = await apptsOf(lead.id);
  assert.strictEqual(row.status, 'cancelled', 'the CRM-side cancellation always succeeds immediately — it never waits on the external call');

  await drain();
  const failedRow = (await outboxOf(row.id)).find(o => o.action === 'cancel_main');
  assert.strictEqual(failedRow.status, 'failed', 'a failed Google call leaves the outbox row in the retry-eligible "failed" state — never falsely marked synced');
  assert.notStrictEqual(google.events.get(row.google_event_id).status, 'cancelled', 'the event was NOT actually removed yet — no false success');

  // Retry succeeds.
  google.failCancelFor = null;
  await db.query(`UPDATE calendar_outbox SET next_attempt_at = NOW() WHERE appointment_id = $1`, [row.id]);
  await drain();
  const retriedRow = (await outboxOf(row.id)).find(o => o.action === 'cancel_main');
  assert.strictEqual(retriedRow.status, 'synced');
  assert.strictEqual(google.events.get(row.google_event_id).status, 'cancelled');
});

test('7. Repeated Closed Lost transition (duplicate request / webhook replay) is idempotent: no error, no duplicate audit note, no second cancel attempt', { skip }, async () => {
  const lead = await createLead({});
  const day = pickDay();
  await bookAppointment(lead.id, day, '13:00', 'Meeting');

  const r1 = await setStatus(lead.id, 'Closed Lost');
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  const actsAfterFirst = await activitiesOf(lead.id);

  // Replay: same transition requested again (e.g. a retried webhook, or a
  // duplicate button click) while the lead is ALREADY Closed Lost.
  const r2 = await setStatus(lead.id, 'Closed Lost');
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  assert.strictEqual(r2.body.closed_lost_appointment_cancel_failures, undefined, 'the replay is never reported as a failure');

  const actsAfterSecond = await activitiesOf(lead.id);
  assert.strictEqual(actsAfterSecond.length, actsAfterFirst.length, 'no second "Closed Lost" audit note — this was not a re-entry');

  const [row] = await apptsOf(lead.id);
  assert.strictEqual(row.status, 'cancelled');

  // Also exercise the legacy upsert-by-external-ref entry point hitting the
  // SAME lead — a second, different route replaying the same transition.
  const byExternal = await api('PUT', `/api/v1/leads/by-external/${lead.id}`, { status: 'Closed Lost' });
  assert.strictEqual(byExternal.status, 200, JSON.stringify(byExternal.body));
  const actsAfterThird = await activitiesOf(lead.id);
  assert.strictEqual(actsAfterThird.length, actsAfterFirst.length, 'a replay through the OTHER canonical write path is equally idempotent');
});

test('8. Reopening a Closed Lost lead never auto-restores the cancelled appointment or the cleared follow-up — only an explicit new reschedule works again', { skip }, async () => {
  const lead = await createLead({});
  const day = pickDay();
  const appt = await bookAppointment(lead.id, day, '16:00', 'Meeting');
  await setStatus(lead.id, 'Closed Lost');
  const [cancelledRow] = await apptsOf(lead.id);
  assert.strictEqual(cancelledRow.status, 'cancelled');

  // Reopen.
  const reopen = await setStatus(lead.id, 'New');
  assert.strictEqual(reopen.status, 200, JSON.stringify(reopen.body));

  const [stillCancelled] = await apptsOf(lead.id);
  assert.strictEqual(stillCancelled.id, appt.id);
  assert.strictEqual(stillCancelled.status, 'cancelled', 'reopening never resurrects the cancelled appointment');
  const l = await getLead(lead.id);
  assert.strictEqual(l.appointment, null);
  assert.deepStrictEqual([l.follow_up_date, l.follow_up_time, l.follow_up_type], [null, null, null], 'reopening never restores the cleared follow-up');
  const rl = await reminderLeadOf(lead);
  assert.strictEqual(rl.appointment_date, null);
  assert.strictEqual(rl.follow_up_date, null);

  // Explicit reschedule after reopening works completely normally.
  const day2 = pickDay();
  const newAppt = await bookAppointment(lead.id, day2, '10:00', 'Meeting');
  assert.strictEqual(newAppt.status, 'scheduled');
  const rl2 = await reminderLeadOf(lead);
  assert.strictEqual(rl2.appointment_date, day2, 'an explicitly rescheduled appointment resumes normal reminder projection');
});

// ── Generalized terminal-lost-status coverage (production bug: lead "Rita
// Wilcher" was marked 'Lost', not the literal 'Closed Lost' this file's
// original 8 scenarios exercised — 'Lost' is the real, live-UI-reachable
// status; 'Closed Lost' turned out to be unreachable through any current
// dropdown. lib/leadStatus.js was generalized to a TERMINAL_LOST_STATUSES
// set so every equivalent "lead is dead" status gets the same treatment.) ──

test("9. The real-world 'Lost' status (not just the literal 'Closed Lost') triggers the identical cancellation — regression for production bug (lead \"Rita Wilcher\")", { skip }, async () => {
  const lead = await createLead({});
  const day = pickDay();
  const appt = await bookAppointment(lead.id, day, '14:00', 'Meeting');
  assert.strictEqual(appt.status, 'scheduled');

  const r = await setStatus(lead.id, 'Lost');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.lead.appointment, null, 'the active appointment is gone from the response');

  const [cancelled] = await apptsOf(lead.id);
  assert.strictEqual(cancelled.status, 'cancelled', 'CRM appointment row is cancelled for the real-world "Lost" status, exactly as for "Closed Lost"');

  await drain();
  assert.strictEqual(google.events.get(cancelled.google_event_id).status, 'cancelled', 'the Google Calendar event (and its Driving/Travel Time block, if any) is actually removed');

  const rl = await reminderLeadOf(lead);
  assert.strictEqual(rl.follow_up_date, null);
  assert.strictEqual(rl.appointment_date, null, 'reminder_leads projection cleared for "Lost", same as "Closed Lost"');

  const acts = await activitiesOf(lead.id);
  assert.ok(acts.some(a => /Lost/.test(a.content) && /cancelled/.test(a.content)), 'audit trail note recorded');

  const crmRepository = require('../../lib/crmRepository');
  const eligible = await crmRepository.listEligibleLeads();
  assert.ok(!eligible.some(l => l.id === (lead.external_ref || lead.id)), 'crmRepository safety-net excludes a "Lost" lead too, not just "Closed Lost"');
});

test("10. 'DNQ' and 'Cancelled' (the remaining TERMINAL_LOST_STATUSES values) also cancel the active appointment", { skip }, async () => {
  for (const status of ['DNQ', 'Cancelled']) {
    const lead = await createLead({});
    const day = pickDay();
    await bookAppointment(lead.id, day, '09:30', 'Meeting');

    const r = await setStatus(lead.id, status);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const [row] = await apptsOf(lead.id);
    assert.strictEqual(row.status, 'cancelled', `appointment is cancelled when status becomes '${status}'`);
    await drain();
    assert.strictEqual(google.events.get(row.google_event_id).status, 'cancelled', `Google Calendar event removed for '${status}'`);
  }
});

test("11. Moving BETWEEN two terminal-lost statuses (e.g. 'Lost' -> 'DNQ') is not a fresh re-entry — no duplicate audit note, no second cancel attempt", { skip }, async () => {
  const lead = await createLead({});
  const day = pickDay();
  await bookAppointment(lead.id, day, '12:00', 'Meeting');

  const r1 = await setStatus(lead.id, 'Lost');
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  const actsAfterFirst = await activitiesOf(lead.id);
  const [cancelledRow] = await apptsOf(lead.id);
  assert.strictEqual(cancelledRow.status, 'cancelled');

  const r2 = await setStatus(lead.id, 'DNQ');
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  const actsAfterSecond = await activitiesOf(lead.id);
  assert.strictEqual(actsAfterSecond.length, actsAfterFirst.length, 'no second terminal-lost audit note when moving between two terminal statuses');

  const [rowAfter] = await apptsOf(lead.id);
  assert.strictEqual(rowAfter.status, 'cancelled');
  assert.strictEqual(rowAfter.version, cancelledRow.version, 'no second cancel attempt — the already-cancelled row is untouched');
});
