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
const FAKE_BACKEND_URL = 'https://fake-backend.example.com';
const fakeTwilio = {
  sent: [],
  nextResult: null,
  // Toggled by the webhook-rejection tests below to exercise routes/sms.js's
  // rejection-recording path (the real HMAC algorithm itself is already
  // proven correct/incorrect-by-URL at the unit level in test/smsClient.test.js
  // — this suite only needs to prove routes/sms.js's WIRING around a
  // pass/fail result, not re-derive the algorithm).
  forceSignatureFailure: false,
  sendMessage: async ({ to, body }) => {
    fakeTwilio.sent.push({ to, body });
    if (fakeTwilio.nextResult) { const r = fakeTwilio.nextResult; fakeTwilio.nextResult = null; return r; }
    return { ok: true, sid: `SM-${RUN_FOR_SID}-${fakeTwilio.sent.length}`, status: 'queued', errorCode: null, errorMessage: null };
  },
  verifyTwilioSignature: () => !fakeTwilio.forceSignatureFailure,
  missingConfig: () => [],
  getCredentials: () => ({ accountSid: 'ACtest', authToken: 'test', messagingServiceSid: null, from: '+15550001111' }),
  // October 2026 incident fix: routes/sms.js now calls smsClient.webhookBaseUrl()
  // (moved out of routes/sms.js itself) — this fake must supply it, a fixed,
  // obviously-fake BACKEND-looking URL (never the frontend's), matching the
  // post-fix TWILIO_WEBHOOK_BASE_URL source.
  webhookBaseUrl: () => FAKE_BACKEND_URL,
  webhookBaseUrlSource: () => 'TWILIO_WEBHOOK_BASE_URL',
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

// ── Production incident regression (October 2026): a real manual SMS send
// failed with "new row for relation sms_messages violates check constraint
// sms_messages_status_check" — reproduced directly against this same real
// Postgres instance (not just asserted): Twilio's initial Message-create
// response is 'accepted', not 'queued', when sending via a Messaging Service
// (TWILIO_MESSAGING_SERVICE_SID — this installation's preferred/production
// config per CLAUDE.md), and smsClient.js passes that status through
// verbatim. Fixed by db/migrations/2026-65-sms-messages-status-check-widen.sql
// widening the constraint. These tests prove the fix against the REAL
// constraint, not a mock — before the migration, each of the next two tests
// fails with exactly the reported Postgres error. ─────────────────────────
test('sendSms: a Twilio response of status="accepted" (the real Messaging-Service initial state) is persisted, not rejected by the DB', { skip }, async () => {
  const leadId = await lead(`accepted-${RUN}`, { smsConsent: true });
  fakeTwilio.nextResult = { ok: true, sid: `SM-${RUN}-accepted`, status: 'accepted', errorCode: null, errorMessage: null };
  const row = await smsService.sendSms({ leadId, body: 'Messaging Service accepted-state test', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  assert.strictEqual(row.status, 'accepted');
});

test('handleStatusCallback: a Twilio callback of status="sending" (the real intermediate state before sent/delivered) is persisted, not rejected by the DB', { skip }, async () => {
  const leadId = await lead(`sending-${RUN}`, { smsConsent: true });
  const row = await smsService.sendSms({ leadId, body: 'sending-state callback test', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  const updated = await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'sending' });
  assert.strictEqual(updated.status, 'sending');
});

test('sendSms: an UNRECOGNIZED future Twilio status never hits the DB constraint — falls back to "queued" instead of crashing', { skip }, async () => {
  const leadId = await lead(`unknownstatus-${RUN}`, { smsConsent: true });
  fakeTwilio.nextResult = { ok: true, sid: `SM-${RUN}-unknown`, status: 'some_future_twilio_status', errorCode: null, errorMessage: null };
  const row = await smsService.sendSms({ leadId, body: 'defense in depth test', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  assert.strictEqual(row.status, 'queued', 'an unrecognized status must fall back to a safe, already-allowed value, never crash');
});

test('handleStatusCallback: an UNRECOGNIZED future Twilio status leaves the row\'s existing status unchanged (never guessed, never crashes) but still records the error fields', { skip }, async () => {
  const leadId = await lead(`unknowncallback-${RUN}`, { smsConsent: true });
  const row = await smsService.sendSms({ leadId, body: 'unknown callback status test', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  const updated = await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'some_future_twilio_status', errorCode: '99999', errorMessage: 'unexpected' });
  assert.strictEqual(updated.status, row.status, 'status must be left exactly as it was, not overwritten with an unrecognized value');
  assert.strictEqual(updated.error_code, '99999', 'error fields must still update even when the status itself is left unchanged');
});

test('the live sms_messages_status_check constraint matches lib/smsService.js#KNOWN_SMS_STATUSES exactly — permanent drift guard between the migration and the code', { skip }, async () => {
  const r = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'sms_messages_status_check'`
  );
  const def = r.rows[0].def;
  const dbStatuses = new Set((def.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)));
  assert.deepStrictEqual(dbStatuses, smsService.KNOWN_SMS_STATUSES, 'db/migrations/2026-65-sms-messages-status-check-widen.sql and lib/smsService.js#KNOWN_SMS_STATUSES have drifted apart');
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

// October 2026 production report acceptance criterion: "No duplicate
// notifications." A genuinely CONCURRENT delivery of the same MessageSid
// (not a sequential retry — those always see the row via handleInboundMessage's
// leading SELECT) previously made the LOSING request ALSO report
// duplicate:false, which would have fired the rep-notification email and the
// Yaron SMS forward a second time for one customer message. Deterministic
// proof: smsService.insertInboundMessage is the post-SELECT half of
// handleInboundMessage (see its own comment — split out specifically so this
// is testable without relying on fragile real-world concurrency timing,
// which a Promise.all attempt against a fast local Postgres proved too
// unreliable to trigger reliably in CI). Planting a competing row directly
// deterministically reproduces "the SELECT found nothing, but something else
// already won the INSERT by the time it ran."
test('insertInboundMessage: when the ON CONFLICT DO NOTHING INSERT loses to a row that already exists (a genuinely concurrent delivery), duplicate:true is reported — never duplicate:false', { skip }, async () => {
  const phone = freshPhone();
  const sid = `SM-race-${RUN}`;
  const leadId = await lead(`race-${RUN}`, { phone });
  // Plant the "winner" row directly, simulating the other concurrent
  // delivery's INSERT having already committed.
  const planted = (await db.query(
    `INSERT INTO sms_messages (lead_id, direction, from_number, to_number, body, twilio_sid, status, keyword)
     VALUES ($1, 'inbound', $2, $3, $4, $5, 'received', NULL) RETURNING *`,
    [leadId, `+1${phone}`, '+15550001111', 'concurrent delivery test', sid]
  )).rows[0];

  const result = await smsService.insertInboundMessage({ messageSid: sid, from: `+1${phone}`, to: '+15550001111', body: 'concurrent delivery test' });
  assert.strictEqual(result.duplicate, true, 'losing the INSERT race must be reported as a duplicate, not a fresh message');
  assert.strictEqual(result.row.id, planted.id, 'the loser still gets the real (winning) row back, for its own TwiML logic');

  const count = (await db.query('SELECT count(*)::int AS c FROM sms_messages WHERE twilio_sid = $1', [sid])).rows[0].c;
  assert.strictEqual(count, 1, 'still exactly one row');
});

// Best-effort real-world sanity check alongside the deterministic proof
// above — genuinely parallel calls must still end up with exactly one
// non-duplicate and one row, even if the precise internal race window
// isn't guaranteed to be hit on every run.
test('handleInboundMessage: two genuinely concurrent deliveries of the SAME MessageSid still converge on exactly one row, never two', { skip }, async () => {
  const phone = freshPhone();
  const sid = `SM-race2-${RUN}`;
  const args = { messageSid: sid, from: `+1${phone}`, to: '+15550001111', body: 'concurrent delivery test 2' };
  const [a, b] = await Promise.all([
    smsService.handleInboundMessage(args),
    smsService.handleInboundMessage(args),
  ]);
  assert.strictEqual(a.row.id, b.row.id, 'both calls must resolve to the SAME persisted row');
  const count = (await db.query('SELECT count(*)::int AS c FROM sms_messages WHERE twilio_sid = $1', [sid])).rows[0].c;
  assert.strictEqual(count, 1);
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

// ── Out-of-order/duplicate status-callback regression guard (October 2026
// production report: a reconciled message's status must never flicker
// backward if a stale callback for an earlier state arrives late). ─────────
test('handleStatusCallback: a late-arriving EARLIER status (e.g. "sent" after "delivered" was already recorded) is ignored — the row stays at its more-advanced status', { skip }, async () => {
  const leadId = await lead(`outoforder-${RUN}`, { smsConsent: true });
  const row = await smsService.sendSms({ leadId, body: 'out of order test', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'delivered' });
  const stale = await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'sent' });
  assert.strictEqual(stale.status, 'delivered', 'a late "sent" callback must never regress an already-"delivered" row');
});

test('handleStatusCallback: a genuine FORWARD transition (queued -> sending -> delivered) is always applied', { skip }, async () => {
  const leadId = await lead(`forwardorder-${RUN}`, { smsConsent: true });
  const row = await smsService.sendSms({ leadId, body: 'forward order test', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'sending' });
  const delivered = await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'delivered' });
  assert.strictEqual(delivered.status, 'delivered');
});

test('handleStatusCallback: a DIFFERENT terminal status (e.g. a late correction to "failed") is still applied, never blocked as a "regression"', { skip }, async () => {
  const leadId = await lead(`terminalcorrection-${RUN}`, { smsConsent: true });
  const row = await smsService.sendSms({ leadId, body: 'terminal correction test', sentBy: 'rep@ecconstructiongroup.com', now: new Date('2099-06-15T18:00:00Z') });
  await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'sent' });
  const corrected = await smsService.handleStatusCallback({ messageSid: row.twilio_sid, status: 'failed', errorCode: '30003', errorMessage: 'Unreachable' });
  assert.strictEqual(corrected.status, 'failed');
  assert.strictEqual(corrected.error_code, '30003');
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

// ── Error handling: never leak a raw Postgres error to the CRM UI ──────────
// Production incident fix: routes/sms.js's catch blocks used to respond with
// `{ error: e.message }` for any non-SmsError failure — e.message for a
// Postgres driver error is the literal server-side message (e.g. this
// incident's own "new row for relation sms_messages violates check
// constraint sms_messages_status_check", or here, a malformed-UUID input
// error). Full detail still goes to server logs (console.error); the client
// now only ever sees a generic, actionable message.
test('POST /leads/:id/sms: a genuine unexpected DB error (malformed id) never leaks the raw Postgres message to the response', { skip }, async (t) => {
  await withBusinessHours(t, async () => {
    const adminToken = token('admin', 'admin@ecconstructiongroup.com');
    const r = await api('POST', `/api/v1/leads/not-a-valid-uuid/sms`, { body: 'hi' }, adminToken);
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.body.error, 'unexpected_error');
    const serialized = JSON.stringify(r.body);
    assert.ok(!/invalid input syntax/i.test(serialized), 'raw Postgres error text must never reach the response body');
    assert.ok(!/relation|constraint|column/i.test(serialized), 'no raw SQL/schema vocabulary must ever reach the response body');
  });
});

test('GET /leads/:id/sms: a genuine unexpected DB error (malformed id) never leaks the raw Postgres message to the response', { skip }, async () => {
  const adminToken = token('admin', 'admin@ecconstructiongroup.com');
  const r = await api('GET', `/api/v1/leads/not-a-valid-uuid/sms`, undefined, adminToken);
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.error, 'unexpected_error');
  const serialized = JSON.stringify(r.body);
  assert.ok(!/invalid input syntax/i.test(serialized), 'raw Postgres error text must never reach the response body');
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

// ── Inbound-webhook signature-rejection diagnostics (October 2026 incident:
// a real inbound reply from Michelle Roitman's test lead never appeared in
// the CRM because every inbound webhook silently 401'd — see
// lib/smsClient.js#webhookBaseUrl's header). These prove routes/sms.js's
// rejection-recording path: a signature failure is never just a bare log
// line again — it's a durable, queryable row with the EXACT URL our server
// expected, directly comparable against Twilio Console's configured
// webhook URL. ──────────────────────────────────────────────────────────
test('POST /sms-webhook/inbound: a signature failure is recorded in sms_webhook_rejections with the exact expected URL and the message\'s MessageSid/From (extracted even though the signature was rejected)', { skip }, async () => {
  fakeTwilio.forceSignatureFailure = true;
  try {
    const r = await fetch(`${base}/api/v1/sms-webhook/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'bogus' },
      body: new URLSearchParams({ MessageSid: `SM-rejecttest-${RUN}`, From: '+13239611116', To: '+18185930874', Body: 'Hi' }).toString(),
    });
    assert.strictEqual(r.status, 401);
  } finally {
    fakeTwilio.forceSignatureFailure = false;
  }
  const rej = (await db.query('SELECT * FROM sms_webhook_rejections WHERE message_sid = $1', [`SM-rejecttest-${RUN}`])).rows[0];
  assert.ok(rej, 'expected a recorded rejection row');
  assert.strictEqual(rej.path, 'inbound');
  assert.strictEqual(rej.computed_url, `${FAKE_BACKEND_URL}/api/v1/sms-webhook/inbound`);
  assert.strictEqual(rej.has_signature_header, true);
  assert.strictEqual(rej.from_number, '+13239611116');
});

test('POST /sms-webhook/status: a signature failure is ALSO recorded, under path=\'status\'', { skip }, async () => {
  fakeTwilio.forceSignatureFailure = true;
  try {
    const r = await fetch(`${base}/api/v1/sms-webhook/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ MessageSid: `SM-rejecttest-status-${RUN}`, MessageStatus: 'delivered' }).toString(),
    });
    assert.strictEqual(r.status, 401);
  } finally {
    fakeTwilio.forceSignatureFailure = false;
  }
  const rej = (await db.query('SELECT * FROM sms_webhook_rejections WHERE message_sid = $1', [`SM-rejecttest-status-${RUN}`])).rows[0];
  assert.ok(rej, 'expected a recorded rejection row');
  assert.strictEqual(rej.path, 'status');
  assert.strictEqual(rej.computed_url, `${FAKE_BACKEND_URL}/api/v1/sms-webhook/status`);
  assert.strictEqual(rej.has_signature_header, false, 'this request sent no X-Twilio-Signature header at all');
});

test('a correctly-signed inbound webhook never writes a rejection row (sanity: forceSignatureFailure actually gates this path, not something else)', { skip }, async () => {
  const before = (await db.query(`SELECT COUNT(*)::int AS c FROM sms_webhook_rejections`)).rows[0].c;
  const r = await fetch(`${base}/api/v1/sms-webhook/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ MessageSid: `SM-nofail-${RUN}`, From: freshPhone(), To: '+18185930874', Body: 'Hello' }).toString(),
  });
  assert.strictEqual(r.status, 200);
  const after = (await db.query(`SELECT COUNT(*)::int AS c FROM sms_webhook_rejections`)).rows[0].c;
  assert.strictEqual(after, before, 'a successfully-verified webhook must never add a rejection row');
});

test('smsService.getInboundWebhookHealth: reports inbound recency AND rejection counts independently of outbound-send credential presence', { skip }, async () => {
  const health = await smsService.getInboundWebhookHealth();
  assert.ok(health.recency);
  assert.ok(health.recency.total_leads_received > 0, 'this suite has already received multiple real inbound messages by this point');
  assert.ok(health.recency.last_lead_received_at, 'expected a timestamp, not null, given the above');
  assert.ok(health.delivery_failures);
  assert.ok(health.delivery_failures.total > 0, 'the rejection tests above should have added at least 2 rows');
});
