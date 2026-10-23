/* eslint-disable no-undef */
'use strict';

/**
 * sms.int.test.js — REAL-Postgres proof of the Twilio SMS integration:
 * lib/smsService.js's send/receive/opt-out/matching logic, and routes/sms.js's
 * ownership scoping + webhook handling. Twilio itself is faked (require.cache
 * injection of lib/smsClient, the same pattern used for the Google Calendar
 * fake-client tests elsewhere in this suite) — no real network call is ever
 * made. Skipped without TEST_DATABASE_URL.
 */
process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'sms-test-jwt-secret-at-least-32-characters-long';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
const ROOT = path.join(__dirname, '..', '..');

if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

// routes/sms.js's real POST handler has no `now` override (unlike the direct
// smsService.sendSms() tests below) — it always uses the real wall clock, so
// an HTTP-path send test is quiet-hours-flaky for ~11 real hours of every day
// (reproduced: failed at 21:31 PDT, past the 21:00 cutoff). Pin Date to a
// fixed mid-afternoon Pacific instant for exactly the HTTP tests that need a
// send to succeed, via node:test's built-in Date mock — never a global env
// override, which would also defeat the dedicated quiet-hours-rejection test
// below.
const BUSINESS_HOURS_MS = new Date('2099-06-15T20:00:00Z').getTime(); // ~1pm Pacific
async function withBusinessHours(t, fn) {
  t.mock.timers.enable({ apis: ['Date'], now: BUSINESS_HOURS_MS });
  try { return await fn(); } finally { t.mock.timers.reset(); }
}

// Fake Twilio: sendMessage always "succeeds" with a deterministic incrementing
// sid unless the test pre-arms a specific failure via fakeTwilio.nextResult.
// The sid is RUN-scoped (never a bare "SM1", "SM2", ...): twilio_sid is UNIQUE
// in the schema, and this suite runs against one persistent disposable
// database across many invocations — a bare counter restarting at 1 every
// process collides with a prior run's rows, and sendSms's own
// `ON CONFLICT (twilio_sid) DO NOTHING RETURNING *` then silently returns no
// row at all on that collision.
const RUN_FOR_SID = `sms${Date.now().toString(36)}`;
const fakeTwilio = {
  sent: [],
  nextResult: null,
  sendMessage: async ({ to, body }) => {
    fakeTwilio.sent.push({ to, body });
    if (fakeTwilio.nextResult) { const r = fakeTwilio.nextResult; fakeTwilio.nextResult = null; return r; }
    return { ok: true, sid: `SM-${RUN_FOR_SID}-${fakeTwilio.sent.length}`, status: 'queued', errorCode: null, errorMessage: null };
  },
  verifyTwilioSignature: () => true, // webhook signature checked separately at the unit level (test/smsClient.test.js)
  missingConfig: () => [],
  getCredentials: () => ({ accountSid: 'ACtest', authToken: 'test', messagingServiceSid: null, from: '+15550001111' }),
};

let db, smsService, ownerId, server, base, smsModuleState;
const RUN = `sms${Date.now().toString(36)}`;

test.before(async () => {
  if (skip) return;
  const smsClientPath = require.resolve(path.join(ROOT, 'lib/smsClient'));
  require.cache[smsClientPath] = { id: smsClientPath, filename: smsClientPath, loaded: true, exports: fakeTwilio };

  db = require(path.join(ROOT, 'db/client'));
  smsService = require(path.join(ROOT, 'lib/smsService'));

  // routes/sms.js gates every route (authenticated + webhook) on the `sms`
  // module being enabled, same convention as meta/website_intake.
  const { ensureGoogleModulesEnabled } = require('./ensureGoogleModulesEnabled');
  smsModuleState = await ensureGoogleModulesEnabled(db, ['sms']);
  require('../../lib/companyConfig').invalidate();

  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'SMS Test Owner', true) ON CONFLICT DO NOTHING`, [`${RUN}.owner@ecconstructiongroup.com`]);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;

  const express = require('express');
  const app = express();
  app.use(express.json());
  const smsRoutes = require(path.join(ROOT, 'routes/sms'));
  app.use('/api/v1', smsRoutes.router);
  app.use('/api/v1/sms-webhook', smsRoutes.webhookRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (skip) return;
  server.close();
  const { restoreGoogleModules } = require('./ensureGoogleModulesEnabled');
  await restoreGoogleModules(db, smsModuleState);
  require('../../lib/companyConfig').invalidate();
  await db.pool.end();
});

// Every phone number used in this file must be unique PER RUN of the file —
// this suite reuses one persistent disposable database across many runs
// (standalone + inside the full `npm run test:integration` pass), and
// matchLeadByPhone's whole point is to react to how many leads share a given
// number. A static literal phone would accumulate duplicate leads across
// separate runs and silently turn an "exactly one match" fixture into an
// ambiguous one on the SECOND run against the same database.
const PHONE_SEED = Date.now() % 9000000;
let phoneSeq = 0;
function freshPhone() {
  phoneSeq += 1;
  return `310${(PHONE_SEED + phoneSeq) % 9000000 + 1000000}`;
}

async function lead(key, { phone, smsConsent = true } = {}) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, sms_consent, created_at)
     VALUES ($1, $2, $3, 'New', $4, $5, '2099-01-01') RETURNING id`,
    [key, RUN, ownerId, phone || freshPhone(), smsConsent]
  );
  return r.rows[0].id;
}

function token(role, email) {
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  return issueAccessToken({ id: `00000000-0000-0000-0000-00000000000${role === 'admin' ? 1 : 2}`, email, role, full_name: 'Test User' });
}

async function api(method, p, body, bearer) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

// ── matchLeadByPhone ─────────────────────────────────────────────────────────
test('matchLeadByPhone: zero matches returns no ambiguity', { skip }, async () => {
  const r = await smsService.matchLeadByPhone('+19995550000');
  assert.strictEqual(r.leadId, null);
  assert.strictEqual(r.ambiguous, false);
});

test('matchLeadByPhone: exactly one match resolves confidently', { skip }, async () => {
  const phone = freshPhone();
  const leadId = await lead(`match-${RUN}`, { phone: `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}` });
  const r = await smsService.matchLeadByPhone(phone);
  assert.strictEqual(r.leadId, leadId);
  assert.strictEqual(r.ambiguous, false);
});

test('matchLeadByPhone: two leads sharing the same phone is ambiguous — never guessed', { skip }, async () => {
  const phone = freshPhone();
  const id1 = await lead(`dup1-${RUN}`, { phone });
  const id2 = await lead(`dup2-${RUN}`, { phone });
  const r = await smsService.matchLeadByPhone(`+1${phone}`);
  assert.strictEqual(r.leadId, null);
  assert.strictEqual(r.ambiguous, true);
  assert.deepStrictEqual(r.candidateIds.sort(), [id1, id2].sort());
});

// ── sendSms ──────────────────────────────────────────────────────────────────
test('sendSms: rejects when the lead has no SMS consent', { skip }, async () => {
  const leadId = await lead(`noconsent-${RUN}`, { smsConsent: false });
  await assert.rejects(
    () => smsService.sendSms({ leadId, body: 'hi', sentBy: 'rep@ecconstructiongroup.com' }),
    (e) => e.code === 'no_consent'
  );
});

test('sendSms: rejects when the recipient has opted out, even if consent is true', { skip }, async () => {
  const phone = freshPhone();
  const leadId = await lead(`optedout-${RUN}`, { phone, smsConsent: true });
  await smsService.recordOptOut(phone, 'STOP');
  await assert.rejects(
    () => smsService.sendSms({ leadId, body: 'hi', sentBy: 'rep@ecconstructiongroup.com' }),
    (e) => e.code === 'recipient_opted_out'
  );
});

test('sendSms: a consented, non-opted-out lead during business hours sends successfully and persists the message', { skip }, async () => {
  const leadId = await lead(`ok-${RUN}`, { smsConsent: true });
  const noon = new Date('2099-06-15T18:00:00Z'); // ~11am Pacific
  const row = await smsService.sendSms({ leadId, body: 'Your appointment is confirmed.', sentBy: 'rep@ecconstructiongroup.com', now: noon });
  assert.strictEqual(row.direction, 'outbound');
  assert.strictEqual(row.status, 'queued');
  assert.ok(row.twilio_sid);
  assert.ok(fakeTwilio.sent.some((s) => s.body === 'Your appointment is confirmed.'));
});

test('sendSms: rejects outside the configured quiet hours', { skip }, async () => {
  const leadId = await lead(`quiet-${RUN}`, { smsConsent: true });
  const lateNight = new Date('2099-06-15T09:00:00Z'); // ~2am Pacific
  await assert.rejects(
    () => smsService.sendSms({ leadId, body: 'hi', sentBy: 'rep@ecconstructiongroup.com', now: lateNight }),
    (e) => e.code === 'quiet_hours'
  );
});

// ── handleInboundMessage ─────────────────────────────────────────────────────
test('handleInboundMessage: a new message from a matched lead is stored and linked', { skip }, async () => {
  const phone = freshPhone();
  const leadId = await lead(`inbound-${RUN}`, { phone });
  const result = await smsService.handleInboundMessage({ messageSid: `SM-in-${RUN}-1`, from: `+1${phone}`, to: '+15550001111', body: 'When can we meet?' });
  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(result.row.lead_id, leadId);
  assert.strictEqual(result.row.direction, 'inbound');
  assert.strictEqual(result.keyword, null);
});

test('handleInboundMessage: STOP records an opt-out and is reflected on the message row', { skip }, async () => {
  const phone = freshPhone();
  const leadId = await lead(`stopflow-${RUN}`, { phone, smsConsent: true });
  const result = await smsService.handleInboundMessage({ messageSid: `SM-in-${RUN}-2`, from: `+1${phone}`, to: '+15550001111', body: 'STOP' });
  assert.strictEqual(result.keyword, 'STOP');
  assert.strictEqual(await smsService.isOptedOut(phone), true);
  // Immediately blocks a subsequent send to the same lead.
  await assert.rejects(
    () => smsService.sendSms({ leadId, body: 'hi', sentBy: 'rep@ecconstructiongroup.com' }),
    (e) => e.code === 'recipient_opted_out'
  );
});

test('handleInboundMessage: START clears a prior opt-out', { skip }, async () => {
  const phone = freshPhone();
  await smsService.recordOptOut(phone, 'STOP');
  await smsService.handleInboundMessage({ messageSid: `SM-in-${RUN}-3`, from: `+1${phone}`, to: '+15550001111', body: 'START' });
  assert.strictEqual(await smsService.isOptedOut(phone), false);
});

test('handleInboundMessage: a redelivered webhook (same MessageSid) is idempotent — no duplicate row, no double keyword processing', { skip }, async () => {
  const phone = freshPhone();
  const sid = `SM-in-${RUN}-4`;
  await smsService.recordOptIn(phone, 'START'); // ensure NOT opted out beforehand
  const first = await smsService.handleInboundMessage({ messageSid: sid, from: `+1${phone}`, to: '+15550001111', body: 'STOP' });
  assert.strictEqual(first.duplicate, false);
  const countAfterFirst = (await db.query('SELECT count(*)::int AS c FROM sms_messages WHERE twilio_sid = $1', [sid])).rows[0].c;
  assert.strictEqual(countAfterFirst, 1);
  const second = await smsService.handleInboundMessage({ messageSid: sid, from: `+1${phone}`, to: '+15550001111', body: 'STOP' });
  assert.strictEqual(second.duplicate, true);
  const countAfterSecond = (await db.query('SELECT count(*)::int AS c FROM sms_messages WHERE twilio_sid = $1', [sid])).rows[0].c;
  assert.strictEqual(countAfterSecond, 1, 'a redelivered webhook must never create a second row');
});

test('handleInboundMessage: an inbound message matching MULTIPLE leads is stored unmatched with candidates, never guessed', { skip }, async () => {
  const phone = freshPhone();
  const id1 = await lead(`ambig1-${RUN}`, { phone });
  const id2 = await lead(`ambig2-${RUN}`, { phone });
  const result = await smsService.handleInboundMessage({ messageSid: `SM-in-${RUN}-5`, from: `+1${phone}`, to: '+15550001111', body: 'Hello' });
  assert.strictEqual(result.row.lead_id, null);
  assert.strictEqual(result.row.ambiguous_match, true);
  assert.deepStrictEqual((result.row.candidate_lead_ids || []).sort(), [id1, id2].sort());
});

// ── handleStatusCallback ─────────────────────────────────────────────────────
test('handleStatusCallback: updates the matching outbound row by twilio_sid', { skip }, async () => {
  const leadId = await lead(`status-${RUN}`, { smsConsent: true });
  const row = await smsService.sendSms({ leadId, body: 'hi there', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  const updated = await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'delivered' });
  assert.strictEqual(updated.status, 'delivered');
});

test('handleStatusCallback: a callback for an unknown sid is a no-op, never throws', { skip }, async () => {
  const result = await smsService.handleStatusCallback({ messageSid: 'SM-does-not-exist', status: 'failed' });
  assert.strictEqual(result, null);
});

// ── Route-level: ownership scoping + webhooks ───────────────────────────────
test('POST /leads/:id/sms: admin can send to any lead', { skip }, async (t) => {
  await withBusinessHours(t, async () => {
    const leadId = await lead(`route-admin-${RUN}`, { smsConsent: true });
    const adminToken = token('admin', 'admin@ecconstructiongroup.com');
    const r = await api('POST', `/api/v1/leads/${leadId}/sms`, { body: 'Hi from admin' }, adminToken);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.message.direction, 'outbound');
  });
});

test('POST /leads/:id/sms: a sales_rep who does NOT own the lead is forbidden (ownership scoping reused from routes/leads.js)', { skip }, async () => {
  const otherOwner = (await db.query(
    `INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Other Owner', true) ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    [`${RUN}.other@ecconstructiongroup.com`]
  )).rows[0].id;
  const leadId = (await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, sms_consent, created_at)
     VALUES ('ForbidTest', $1, $2, 'New', $3, true, '2099-01-01') RETURNING id`,
    [RUN, otherOwner, freshPhone()]
  )).rows[0].id;

  await db.query(
    `INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Rep Owner', true) ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [`${RUN}.rep@ecconstructiongroup.com`]
  );
  const repToken = token('sales_rep', `${RUN}.rep@ecconstructiongroup.com`);
  const r = await api('POST', `/api/v1/leads/${leadId}/sms`, { body: 'should not send' }, repToken);
  assert.strictEqual(r.status, 403);
});

test('GET /leads/:id/sms: returns the conversation history for an authorized caller', { skip }, async (t) => {
  await withBusinessHours(t, async () => {
    const leadId = await lead(`history-${RUN}`, { smsConsent: true });
    const adminToken = token('admin', 'admin@ecconstructiongroup.com');
    await api('POST', `/api/v1/leads/${leadId}/sms`, { body: 'first message' }, adminToken);
    const r = await api('GET', `/api/v1/leads/${leadId}/sms`, undefined, adminToken);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.items.some((m) => m.body === 'first message'));
  });
});

test('POST /sms-webhook/inbound: a STOP reply returns TwiML identifying the company and opts the number out', { skip }, async () => {
  const phone = freshPhone();
  const r = await fetch(`${base}/api/v1/sms-webhook/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ MessageSid: `SM-webhook-${RUN}-1`, From: `+1${phone}`, To: '+15550001111', Body: 'STOP' }).toString(),
  });
  assert.strictEqual(r.status, 200);
  const xml = await r.text();
  assert.ok(/<Message>/.test(xml));
  assert.strictEqual(await smsService.isOptedOut(phone), true);
});

test('POST /sms-webhook/inbound: an ordinary message gets an empty TwiML response (no auto-reply)', { skip }, async () => {
  const r = await fetch(`${base}/api/v1/sms-webhook/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ MessageSid: `SM-webhook-${RUN}-2`, From: `+1${freshPhone()}`, To: '+15550001111', Body: 'Thanks, see you then!' }).toString(),
  });
  assert.strictEqual(r.status, 200);
  const xml = await r.text();
  assert.ok(!/<Message>/.test(xml), 'an ordinary reply must not trigger any auto-reply text');
});

test('POST /sms-webhook/status: updates delivery status and always returns 204', { skip }, async () => {
  const leadId = await lead(`webhookstatus-${RUN}`, { smsConsent: true });
  const row = await smsService.sendSms({ leadId, body: 'webhook status test', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  const r = await fetch(`${base}/api/v1/sms-webhook/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ MessageSid: row.twilio_sid, MessageStatus: 'delivered' }).toString(),
  });
  assert.strictEqual(r.status, 204);
  const updated = (await db.query('SELECT status FROM sms_messages WHERE twilio_sid = $1', [row.twilio_sid])).rows[0];
  assert.strictEqual(updated.status, 'delivered');
});
