/* eslint-disable no-undef */
'use strict';

/**
 * smsConsentIntake.int.test.js — REAL-Postgres, real-HTTP proof of the
 * "CRM New Lead Intake: Appointment SMS Consent" feature end to end:
 *
 *   - POST /api/public/capture (the real New Lead intake endpoint,
 *     routes/publicCapture.js — used by crm-frontend/src/pages/LeadCapture.jsx
 *     both publicly and internally via ?returnToCRM=true) with the
 *     representative's consent checkbox checked actually grants consent and
 *     fires the real confirmation SMS, through the real HTTP body parsing and
 *     validation layer (lib/captureValidation.js), not just a direct
 *     createBooking() call (see test/integration/smsAppointmentLifecycle.int
 *     .test.js for that lower-level proof).
 *   - PUT /api/v1/leads/:id/sms-consent (authorized later change from Lead
 *     Detail) — grant with evidence, the STOP opt-out guard, and revoke.
 *
 * Twilio is faked (require.cache injection of lib/smsClient); Google
 * Calendar/Maps and the new-lead alert email are faked at their own
 * boundaries (same pattern as leadIntakeConcurrency.int.test.js) so the real
 * booking transaction, calendar outbox enqueue and post-commit confirmation
 * SMS all run for real. Skipped without TEST_DATABASE_URL.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'sms-consent-test-jwt-secret-32-chars-ok';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
}

const RUN_FOR_SID = `ci${Date.now().toString(36)}`;
const fakeTwilio = {
  sent: [],
  sendMessage: async ({ to, body }) => {
    fakeTwilio.sent.push({ to, body });
    return { ok: true, sid: `SM-${RUN_FOR_SID}-${fakeTwilio.sent.length}`, status: 'queued', errorCode: null, errorMessage: null };
  },
  verifyTwilioSignature: () => true,
  missingConfig: () => [],
  getCredentials: () => ({ accountSid: 'ACtest', authToken: 'test', messagingServiceSid: null, from: '+15550008888' }),
};

if (DB_URL) {
  const stub = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  stub('lib/smsClient', fakeTwilio);
  stub('lib/booking/googleCalendarClient', {
    getAccessToken: async () => 'fake',
    createOrUpdateEvent: async (_t, _c, b) => ({ id: b.id }),
    updateEvent: async (_t, _c, id) => ({ id }),
    cancelEvent: async () => ({ ok: true }),
    getEvent: async () => ({ exists: false }),
    listByExt: async () => [], listEvents: async () => [],
  });
  stub('lib/googleMapsClient', {
    isConfigured: () => false,
    normalizeAddress: (a, c) => [a, c].filter(Boolean).join(', '),
    geocodeAddress: async () => null, computeRoute: async () => null,
  });
  stub('lib/captureAlerts', { sendNewLeadAlert: async () => {}, ALERT_RECIPIENTS: [] });
}

let db, server, base, ownerEmail, assignedRepName, adminToken, smsModuleState;
let seq = 0;
let apptHourSeq = 8; // spaced 3h apart per capture call so the 1h buffer rule never collides slots across tests

function uniquePhone() {
  seq++;
  return `424${String((Date.now() % 1e5) * 13 + seq * 104729).slice(-7).padStart(7, '0')}`;
}

async function api(method, p, body, headers = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty */ }
  return { status: res.status, body: json };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  smsModuleState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db, ['sms']);
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();

  // lib/captureValidation.js#resolveOwnerEmail derives owner_email from
  // assigned_rep's FIRST WORD only (lowercased + @domain) — an owner_email
  // in the request body is never trusted, so the owner's email here and
  // the assigned_rep used in captureBody() below must be the same single
  // token for the public-capture tests to actually hit this owner.
  const ownerLocal = `smsci${Date.now().toString(36)}`;
  ownerEmail = `${ownerLocal}@ecconstructiongroup.com`;
  assignedRepName = ownerLocal.charAt(0).toUpperCase() + ownerLocal.slice(1);
  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`, [ownerEmail, assignedRepName]);

  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  adminToken = issueAccessToken({ id: '00000000-0000-0000-0000-0000000000c1', email: 'yaron@ecconstructiongroup.com', role: 'admin' });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/public/capture', require(path.join(ROOT, 'routes/publicCapture')));
  app.use('/api/v1/leads', require(path.join(ROOT, 'routes/leads')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, smsModuleState);
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();
});

function captureBody(overrides) {
  const d = new Date(Date.now() + 10 * 86400000);
  const date = d.toISOString().slice(0, 10);
  const hour = apptHourSeq;
  apptHourSeq += 3;
  const time = `${String(hour % 24).padStart(2, '0')}:00`;
  return {
    first_name: 'Consent', last_name: `Test${Date.now()}`,
    phone: uniquePhone(), project_type: 'Kitchen', source: 'Referral',
    assigned_rep: assignedRepName,
    appointment_date: date, appointment_time: time,
    ...overrides,
  };
}

// ── POST /api/public/capture — the real New Lead intake HTTP path ─────────

test('POST /api/public/capture: checkbox checked -> real HTTP intake grants consent and the real confirmation SMS fires', { skip }, async () => {
  const phone = uniquePhone();
  const sentBefore = fakeTwilio.sent.length;
  const r = await api('POST', '/api/public/capture', captureBody({ phone, sms_consent_confirmed: true }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const leadId = r.body.lead.id;

  const got = await waitFor(() => fakeTwilio.sent.length > sentBefore);
  assert.ok(got, 'the real HTTP intake path must trigger the real confirmation SMS when the box was checked');

  const leadRow = (await db.query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
  assert.strictEqual(leadRow.sms_consent, true);
  assert.strictEqual(leadRow.sms_consent_recorded_by, ownerEmail);
  assert.match(leadRow.sms_consent_source, /Philippines intake representative/);

  const note = (await db.query(
    `SELECT * FROM activities WHERE lead_id = $1 AND content LIKE 'SMS consent confirmed%'`, [leadId]
  )).rows[0];
  assert.ok(note, 'expected an audit-trail activity note');
});

test('POST /api/public/capture: checkbox left unchecked -> lead and appointment save normally, no consent, no SMS', { skip }, async () => {
  const phone = uniquePhone();
  const sentBefore = fakeTwilio.sent.length;
  const r = await api('POST', '/api/public/capture', captureBody({ phone, sms_consent_confirmed: false }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.appointment, 'the appointment must still be created normally');
  await new Promise((res) => setTimeout(res, 300));
  assert.strictEqual(fakeTwilio.sent.length, sentBefore);
  const leadRow = (await db.query('SELECT sms_consent FROM leads WHERE id = $1', [r.body.lead.id])).rows[0];
  assert.notStrictEqual(leadRow.sms_consent, true);
});

test('POST /api/public/capture: no appointment in this submission -> a checked box is ignored, never silently granted', { skip }, async () => {
  const phone = uniquePhone();
  const r = await api('POST', '/api/public/capture', captureBody({
    phone, sms_consent_confirmed: true, appointment_date: '', appointment_time: '',
  }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const leadRow = (await db.query('SELECT sms_consent FROM leads WHERE id = $1', [r.body.lead.id])).rows[0];
  assert.notStrictEqual(leadRow.sms_consent, true);
});

// ── PUT /api/v1/leads/:id/sms-consent — authorized later change ────────────

async function createPlainLead(phone) {
  const r = (await db.query(
    `INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Consent Edit Owner', true)
       ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    [ownerEmail]
  )).rows[0];
  const lead = (await db.query(
    `INSERT INTO leads (first_name, last_name, phone, owner_id, status, source, project_type)
     VALUES ('Edit', 'Consent', $1, $2, 'New', 'Referral', 'Kitchen') RETURNING *`,
    [phone, r.id]
  )).rows[0];
  return lead;
}

test('PUT /:id/sms-consent: admin grants consent with evidence -> sms_consent true, recorded_by = the authenticated caller, activity note', { skip }, async () => {
  const lead = await createPlainLead(uniquePhone());
  const r = await api('PUT', `/api/v1/leads/${lead.id}/sms-consent`, { confirmed: true, evidence_note: 'Customer confirmed by text message.' }, { authorization: 'Bearer ' + adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.lead.sms_consent, true);
  assert.strictEqual(r.body.lead.sms_consent_recorded_by, 'yaron@ecconstructiongroup.com');
  const note = (await db.query(`SELECT * FROM activities WHERE lead_id = $1 AND content LIKE '%re-confirmed%'`, [lead.id])).rows[0];
  assert.ok(note);
  assert.match(note.content, /Customer confirmed by text message\./);
});

test('PUT /:id/sms-consent: granting is refused (409) for a number that has opted out — never silently overridden', { skip }, async () => {
  const phone = uniquePhone();
  await db.query(`INSERT INTO sms_opt_outs (phone_number, opted_out, opted_out_at, last_keyword, source) VALUES ($1, true, NOW(), 'STOP', 'customer_reply')`, [phone]);
  const lead = await createPlainLead(phone);
  const r = await api('PUT', `/api/v1/leads/${lead.id}/sms-consent`, { confirmed: true }, { authorization: 'Bearer ' + adminToken });
  assert.strictEqual(r.status, 409, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'recipient_opted_out');
  const leadRow = (await db.query('SELECT sms_consent FROM leads WHERE id = $1', [lead.id])).rows[0];
  assert.notStrictEqual(leadRow.sms_consent, true);
});

test('PUT /:id/sms-consent: revoke always succeeds, including for an already-granted or opted-out lead', { skip }, async () => {
  const lead = await createPlainLead(uniquePhone());
  await db.query(`UPDATE leads SET sms_consent = true WHERE id = $1`, [lead.id]);
  const r = await api('PUT', `/api/v1/leads/${lead.id}/sms-consent`, { confirmed: false, evidence_note: 'Customer asked by phone to stop.' }, { authorization: 'Bearer ' + adminToken });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.lead.sms_consent, false);
  const note = (await db.query(`SELECT * FROM activities WHERE lead_id = $1 AND content LIKE '%revoked%'`, [lead.id])).rows[0];
  assert.ok(note);
});

test('PUT /:id/sms-consent: no auth -> 401; missing confirmed field -> 400', { skip }, async () => {
  const lead = await createPlainLead(uniquePhone());
  const noAuth = await api('PUT', `/api/v1/leads/${lead.id}/sms-consent`, { confirmed: true });
  assert.strictEqual(noAuth.status, 401);
  const noBody = await api('PUT', `/api/v1/leads/${lead.id}/sms-consent`, {}, { authorization: 'Bearer ' + adminToken });
  assert.strictEqual(noBody.status, 400);
});

test('GET /:id: serializeLead now exposes sms_consent fields (previously missing — Lead Detail always showed "no consent" regardless of the real value)', { skip }, async () => {
  const lead = await createPlainLead(uniquePhone());
  await db.query(
    `UPDATE leads SET sms_consent = true, sms_consent_at = NOW(), sms_consent_source = 'manual', sms_consent_recorded_by = 'someone@ecconstructiongroup.com' WHERE id = $1`,
    [lead.id]
  );
  const r = await api('GET', `/api/v1/leads/${lead.id}`, undefined, { authorization: 'Bearer ' + adminToken });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.lead.sms_consent, true);
  assert.strictEqual(r.body.lead.sms_consent_recorded_by, 'someone@ecconstructiongroup.com');
});
