/* eslint-disable no-undef */
'use strict';

/**
 * currentActionRouting.int.test.js — REAL-Postgres proof of the FINAL
 * AUTHORITATIVE CURRENT-ACTION RULE (lib/booking/currentAction.js) against
 * the exact production shapes that required the correction: Muhammad Khan,
 * Jamey Corey, Mario Ibanez. Current work — including Daily Map/routing
 * stops — is derived ENTIRELY from the Follow-Up / Next Update; the
 * Appointment is historical/reference data only and is NEVER a route-stop
 * fallback, even when no active Follow-Up exists at all (routes/routing.js's
 * /daily-schedule no longer queries the `appointments` table at all).
 * Exercises the real HTTP API (routes/leads.js, routes/routing.js) end to
 * end — no mocks beyond Google Maps (stubbed so routing never needs network
 * access). Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
  const p = require.resolve('../../lib/googleMapsClient');
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      isConfigured: () => true,
      normalizeAddress: (a, c) => [a, c].filter(Boolean).join(', '),
      geocodeAddress: async () => null,
      computeRoute: async () => null,
    },
  };
  const captureAlertsPath = require.resolve('../../lib/captureAlerts');
  require.cache[captureAlertsPath] = {
    id: captureAlertsPath, filename: captureAlertsPath, loaded: true,
    exports: { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] },
  };
}

let base, server, db, token, pickDay;
let ipSeq = 1;
async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.11.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`,
      authorization: 'Bearer ' + token,
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
async function createLead(first, last, extra) {
  const r = await api('POST', '/api/v1/leads', {
    first_name: first, last_name: `${last}${++seq}${Date.now() % 100000}`, phone: randomPhone(),
    project_type: 'Kitchen', source: 'Referral', property_address: '1 Main St', city: 'Los Angeles',
    assigned_rep: 'Yaron Drilevich', ...extra,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.lead.id;
}
async function setAppointment(leadId, date, time) {
  const r = await api('PUT', `/api/v1/leads/${leadId}/appointment`, { appointment_date: date, appointment_time: time, appointment_type: 'Meeting' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
}
async function setFollowUp(leadId, date, time, type) {
  const r = await api('PUT', `/api/v1/leads/${leadId}/follow-up`, { follow_up_date: date, follow_up_time: time, follow_up_type: type, follow_up_status: 'pending' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
}
async function scheduleFor(date) {
  const r = await api('GET', `/api/v1/routing/daily-schedule?date=${date}&owner=all`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body.schedule || [];
}

test.before(async () => {
  if (skip) return;
  const express = require('express');
  db = require('../../db/client');
  pickDay = await require('./freeDays').loadFreeDayPicker(db);
  const { issueAccessToken } = require('../../lib/authService');
  await db.query(`INSERT INTO owners (email, display_name) VALUES ('yaron@ecconstructiongroup.com', 'Yaron Drilevich') ON CONFLICT DO NOTHING`);
  token = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000a1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/v1/leads', require('../../routes/leads'));
  app.use('/api/v1/routing', require('../../routes/routing'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  server.close();
  await db.pool.end();
});

test('MUHAMMAD KHAN: Appointment 9:00 AM + active Meeting Follow-Up 10:00 AM (same day) — My Day/routing shows ONLY the 10:00 AM Follow-Up, never the 9:00 AM Appointment', { skip }, async () => {
  const day = pickDay();
  const id = await createLead('Muhammad', 'Khan');
  await setAppointment(id, day, '09:00');
  await setFollowUp(id, day, '10:00', 'Meeting');

  const schedule = await scheduleFor(day);
  const stops = schedule.filter((s) => s.id === id);
  assert.strictEqual(stops.length, 1, JSON.stringify(schedule));
  assert.strictEqual(stops[0].is_meeting_followup, true);
  assert.strictEqual(stops[0].follow_up_time, '10:00');

  // The Appointment record itself is never deleted — Lead Detail still has it.
  const lead = (await api('GET', `/api/v1/leads/${id}`)).body.lead;
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.appointment_time, '09:00');
});

test('JAMEY COREY: historical Appointment + active Meeting Follow-Up on a LATER day — the later day shows ONLY the Follow-Up; the Appointment\'s OWN day has NO route stop at all (no fallback)', { skip }, async () => {
  const apptDay = pickDay();
  const followUpDay = pickDay();
  const id = await createLead('Jamey', 'Corey');
  await setAppointment(id, apptDay, '18:00');
  await setFollowUp(id, followUpDay, '12:00', 'Meeting');

  const followUpDaySchedule = await scheduleFor(followUpDay);
  const followUpStops = followUpDaySchedule.filter((s) => s.id === id);
  assert.strictEqual(followUpStops.length, 1, JSON.stringify(followUpDaySchedule));
  assert.strictEqual(followUpStops[0].is_meeting_followup, true);

  // On the Appointment's OWN day (a different day than the Follow-Up), there
  // is NO route stop at all — the Appointment is historical/reference data
  // only and is never a fallback source of current work/route stops.
  if (apptDay !== followUpDay) {
    const apptDaySchedule = await scheduleFor(apptDay);
    const apptStops = apptDaySchedule.filter((s) => s.id === id);
    assert.strictEqual(apptStops.length, 0, JSON.stringify(apptDaySchedule));
  }
});

test('MARIO IBANEZ: a current Appointment with NO active Follow-Up produces NO route stop at all (the Appointment never fills in)', { skip }, async () => {
  const day = pickDay();
  const id = await createLead('Mario', 'Ibanez');
  await setAppointment(id, day, '14:00');

  const schedule = await scheduleFor(day);
  const stops = schedule.filter((s) => s.id === id);
  assert.strictEqual(stops.length, 0, JSON.stringify(schedule));

  // The Appointment record itself is still there — Lead Detail is unaffected.
  const lead = (await api('GET', `/api/v1/leads/${id}`)).body.lead;
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.appointment_time, '14:00');
});

test('a same-day Phone Call Follow-Up is never a route stop (non-physical), and the Appointment is never a route stop either — zero stops total', { skip }, async () => {
  const day = pickDay();
  const id = await createLead('Call', 'Independent');
  await setAppointment(id, day, '14:00');
  await setFollowUp(id, day, '09:00', 'Phone Call');

  const schedule = await scheduleFor(day);
  const stops = schedule.filter((s) => s.id === id);
  assert.strictEqual(stops.length, 0, JSON.stringify(schedule));
});

test('completing the active Meeting Follow-Up removes the route stop entirely — the Appointment never restores as the stop (no fallback lifecycle)', { skip }, async () => {
  const day = pickDay();
  const id = await createLead('Reopen', 'Case');
  await setAppointment(id, day, '09:00');
  await setFollowUp(id, day, '10:00', 'Meeting');
  assert.strictEqual((await scheduleFor(day)).filter((s) => s.id === id)[0].is_meeting_followup, true);

  const complete = await api('PUT', `/api/v1/leads/${id}/follow-up`, { follow_up_status: 'completed' });
  assert.strictEqual(complete.status, 200, JSON.stringify(complete.body));

  const schedule = await scheduleFor(day);
  const stops = schedule.filter((s) => s.id === id);
  assert.strictEqual(stops.length, 0, JSON.stringify(schedule), 'no stop at all once the Follow-Up is completed — the Appointment never becomes current');
});

test('repeated calls to /daily-schedule are idempotent (no state mutation) for an Appointment + active Meeting Follow-Up pair', { skip }, async () => {
  const day = pickDay();
  const id = await createLead('Idem', 'Potent');
  await setAppointment(id, day, '09:00');
  await setFollowUp(id, day, '10:00', 'Meeting');

  const first = await scheduleFor(day);
  const second = await scheduleFor(day);
  const pick = (schedule) => schedule.filter((s) => s.id === id).map((s) => ({ is_meeting_followup: s.is_meeting_followup, follow_up_time: s.follow_up_time }));
  assert.deepStrictEqual(pick(first), pick(second));
  const lead = (await api('GET', `/api/v1/leads/${id}`)).body.lead;
  assert.strictEqual(lead.appointment_date, day);
  assert.strictEqual(lead.follow_up_date, day);
});
