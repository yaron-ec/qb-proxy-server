/* eslint-disable no-undef */
'use strict';

/**
 * smsAppointmentLifecycle.int.test.js — REAL-Postgres, real-`bookingService
 * .createBooking()` proof that the automated booking-confirmation SMS
 * actually fires through the real production code path (not just the
 * extracted, already-unit-tested `sendBookingConfirmationSmsBestEffort`
 * function in isolation — see test/bookingSmsConfirmation.test.js and
 * test/reminderEngineSms.test.js, which this file complements rather than
 * duplicates). Two prior test-file header comments referenced this exact
 * filename as already providing this coverage before it existed — the kind
 * of doc/code mismatch CLAUDE.md's "Verification requirements" section
 * warns about; this file makes that claim true.
 *
 * Twilio is faked at the lib/smsClient boundary (same pattern as
 * sms.int.test.js); Google Calendar/Maps and the new-lead alert email are
 * faked at their own boundaries (same pattern as leadIntakeConcurrency.int
 * .test.js) so createBooking()'s real transaction, lock order, calendar
 * outbox enqueue and post-commit confirmation-SMS hook all run for real.
 * No real network call is ever made. Skipped without TEST_DATABASE_URL.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'sms-lifecycle-test-jwt-secret-32chars-ok';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
  // Wide-open quiet-hours window so this suite's pass/fail never depends on
  // the wall-clock time it happens to run at — quiet-hours gating itself is
  // covered on its own merits elsewhere (test/smsService.test.js,
  // test/reminderEngineQuietHoursDeferral.test.js).
  process.env.SMS_QUIET_HOURS_START = '0';
  process.env.SMS_QUIET_HOURS_END = '24';
}

const RUN_FOR_SID = `lc${Date.now().toString(36)}`;
const fakeTwilio = {
  sent: [],
  sendMessage: async ({ to, body }) => {
    fakeTwilio.sent.push({ to, body });
    return { ok: true, sid: `SM-${RUN_FOR_SID}-${fakeTwilio.sent.length}`, status: 'queued', errorCode: null, errorMessage: null };
  },
  verifyTwilioSignature: () => true,
  missingConfig: () => [],
  getCredentials: () => ({ accountSid: 'ACtest', authToken: 'test', messagingServiceSid: null, from: '+15550009999' }),
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

let db, createBooking, ownerId, apptTypeId, smsModuleState;
let seq = 0;
const RUN = `lc${Date.now().toString(36)}`;

function uniquePhone() {
  seq++;
  return `310${String((Date.now() % 1e5) * 13 + seq * 104729).slice(-7).padStart(7, '0')}`;
}

async function insertLead({ phone, smsConsent }) {
  seq++;
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, phone, source, project_type, owner_id, status, sms_consent)
     VALUES ($1, $2, $3, 'Referral', 'Kitchen', $4, 'New', $5)
     RETURNING *`,
    [`Sms${seq}`, `Lifecycle${RUN}`, phone, ownerId, smsConsent]
  );
  return r.rows[0];
}

// The confirmation SMS is a fire-and-forget post-commit hook — createBooking()
// itself resolves before that async call necessarily finishes. Poll briefly
// rather than assert immediately.
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
  ({ createBooking } = require(path.join(ROOT, 'lib/booking/bookingService')));
  smsModuleState = await require('./ensureGoogleModulesEnabled').ensureGoogleModulesEnabled(db, ['sms']);
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();

  await db.query(
    `INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'SMS Lifecycle Owner', true) ON CONFLICT DO NOTHING`,
    [`${RUN}.owner@ecconstructiongroup.com`]
  );
  ownerId = (await db.query('SELECT id FROM owners WHERE email = $1', [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;
  apptTypeId = (await db.query("SELECT id FROM appointment_types WHERE name = 'Consultation'")).rows[0].id;
});

test.after(async () => {
  if (skip) return;
  await require('./ensureGoogleModulesEnabled').restoreGoogleModules(db, smsModuleState);
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();
});

test('a real createBooking() for a consented lead sends exactly one booking-confirmation SMS through the real production path', { skip }, async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  try {
    const lead = await insertLead({ phone: uniquePhone(), smsConsent: true });
    const sentBefore = fakeTwilio.sent.length;
    const startAt = new Date(Date.now() + 3 * 86400000).toISOString();
    const result = await createBooking({
      idempotency_key: `lifecycle-${RUN}-${lead.id}`,
      lead_id: lead.id, owner_email: `${RUN}.owner@ecconstructiongroup.com`,
      start_at: startAt, appointment_type_id: apptTypeId, actor: 'test',
    });
    assert.strictEqual(result.idempotent, false);
    assert.ok(result.appointment);

    const got = await waitFor(() => fakeTwilio.sent.length > sentBefore);
    assert.ok(got, 'expected the fake Twilio client to receive exactly one confirmation SMS call');
    assert.strictEqual(fakeTwilio.sent.length, sentBefore + 1, 'must send exactly once, never more');
    const sms = fakeTwilio.sent[fakeTwilio.sent.length - 1];
    assert.match(sms.to, new RegExp(lead.phone.replace(/\D/g, '').slice(-10) + '$'));
    // Not asserting the literal company name: this suite runs against a
    // shared disposable DB whose company_settings row other test files may
    // have configured differently — the exact wording is already pinned in
    // test/smsTemplates.test.js. Here the point is that the REAL code path
    // actually calls the template and sends it.
    assert.match(sms.body, /Your appointment with .+ is confirmed for/);
    assert.match(sms.body, /Reply STOP to opt out\.$/);

    const row = (await db.query(
      `SELECT * FROM sms_messages WHERE lead_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1`,
      [lead.id]
    )).rows[0];
    assert.ok(row, 'expected the send to be persisted to sms_messages');
    assert.strictEqual(row.sent_by, 'system:booking_confirmation');
  } finally {
    delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  }
});

test('a replayed (idempotent) booking for the same idempotency_key never sends a second confirmation SMS', { skip }, async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  try {
    const lead = await insertLead({ phone: uniquePhone(), smsConsent: true });
    const key = `lifecycle-replay-${RUN}-${lead.id}`;
    const startAt = new Date(Date.now() + 4 * 86400000).toISOString();
    const input = {
      idempotency_key: key, lead_id: lead.id, owner_email: `${RUN}.owner@ecconstructiongroup.com`,
      start_at: startAt, appointment_type_id: apptTypeId, actor: 'test',
    };
    const first = await createBooking(input);
    assert.strictEqual(first.idempotent, false);
    const sentAfterFirst = await waitFor(() => fakeTwilio.sent.some((s) => s.to.endsWith(lead.phone.replace(/\D/g, '').slice(-10))));
    assert.ok(sentAfterFirst);
    const countAfterFirst = fakeTwilio.sent.length;

    const second = await createBooking(input);
    assert.strictEqual(second.idempotent, true, 'a replayed request with the same idempotency_key must be recognized as idempotent');
    await new Promise((r) => setTimeout(r, 300)); // give any (incorrect) second send a chance to appear
    assert.strictEqual(fakeTwilio.sent.length, countAfterFirst, 'a replayed booking must never trigger a second confirmation SMS');
  } finally {
    delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  }
});

test('a lead without SMS consent never receives a confirmation SMS, even with the kill switch on', { skip }, async () => {
  process.env.SMS_AUTOMATED_REMINDERS_ENABLED = 'true';
  try {
    const lead = await insertLead({ phone: uniquePhone(), smsConsent: false });
    const startAt = new Date(Date.now() + 5 * 86400000).toISOString();
    const sentBefore = fakeTwilio.sent.length;
    await createBooking({
      idempotency_key: `lifecycle-noconsent-${RUN}-${lead.id}`,
      lead_id: lead.id, owner_email: `${RUN}.owner@ecconstructiongroup.com`,
      start_at: startAt, appointment_type_id: apptTypeId, actor: 'test',
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(fakeTwilio.sent.length, sentBefore, 'no consent -> no send, through the real code path');
  } finally {
    delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  }
});

test('SMS_AUTOMATED_REMINDERS_ENABLED unset -> a real booking never sends, confirming the kill switch actually gates the live path', { skip }, async () => {
  delete process.env.SMS_AUTOMATED_REMINDERS_ENABLED;
  const lead = await insertLead({ phone: uniquePhone(), smsConsent: true });
  const startAt = new Date(Date.now() + 6 * 86400000).toISOString();
  const sentBefore = fakeTwilio.sent.length;
  await createBooking({
    idempotency_key: `lifecycle-disabled-${RUN}-${lead.id}`,
    lead_id: lead.id, owner_email: `${RUN}.owner@ecconstructiongroup.com`,
    start_at: startAt, appointment_type_id: apptTypeId, actor: 'test',
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(fakeTwilio.sent.length, sentBefore, 'deploying/merging this code must never itself start sending — the kill switch must be explicitly set true');
});
