/* eslint-disable no-undef */
'use strict';

/**
 * reconcileSmsMessageStatus.int.test.js — REAL-Postgres proof of
 * scripts/reconcileSmsMessageStatus.js, the catch-up tool for an outbound
 * sms_messages row stuck at a non-terminal status because its Twilio
 * delivery-status callback was never received (the October 2026 incident
 * window, before TWILIO_WEBHOOK_BASE_URL was correctly configured — see
 * lib/smsClient.js#webhookBaseUrl's header). Twilio itself is faked
 * (require.cache injection of lib/smsClient, the same convention
 * test/integration/sms.int.test.js already uses) — no real network call is
 * ever made. Skipped without TEST_DATABASE_URL.
 */
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

const fakeTwilio = {
  responses: {},
  missingConfig: () => [],
  getCredentials: () => ({ accountSid: 'ACtest', authToken: 'test', messagingServiceSid: null, from: '+15550001111' }),
  getMessageStatus: async (sid) => fakeTwilio.responses[sid] || { ok: true, status: 'delivered', errorCode: null, errorMessage: null },
  sendMessage: async () => { throw new Error('reconcileSmsMessageStatus must never send a message'); },
  verifyTwilioSignature: () => true,
  webhookBaseUrl: () => 'https://fake-backend.example.com',
  webhookBaseUrlSource: () => 'TWILIO_WEBHOOK_BASE_URL',
};

let db, smsService, reconcile, ownerId;
const RUN = `rc${Date.now().toString(36)}`;

test.before(async () => {
  if (skip) return;
  const smsClientPath = require.resolve(path.join(ROOT, 'lib/smsClient'));
  require.cache[smsClientPath] = { id: smsClientPath, filename: smsClientPath, loaded: true, exports: fakeTwilio };

  db = require(path.join(ROOT, 'db/client'));
  smsService = require(path.join(ROOT, 'lib/smsService'));
  reconcile = require(path.join(ROOT, 'scripts/reconcileSmsMessageStatus'));

  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Reconcile Test Owner', true) ON CONFLICT DO NOTHING`, [`${RUN}.owner@ecconstructiongroup.com`]);
  ownerId = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@ecconstructiongroup.com`])).rows[0].id;
});
test.after(async () => {
  if (skip) return;
  await db.pool.end();
});

let phoneSeq = 0;
function freshPhone() {
  phoneSeq += 1;
  return `310${(Date.now() % 9000000 + phoneSeq) % 9000000 + 1000000}`;
}

async function stuckOutboundRow({ status = 'queued', ageMinutes = 30 }) {
  const leadR = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, sms_consent, created_at)
     VALUES ('Stuck', $1, $2, 'New', $3, true, '2099-01-01') RETURNING id`,
    [RUN, ownerId, freshPhone()]
  );
  const sid = `SM-${RUN}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db.query(
    `INSERT INTO sms_messages (lead_id, direction, from_number, to_number, body, twilio_sid, status, sent_by, created_at)
     VALUES ($1, 'outbound', '+15550001111', '+13105551234', 'reconcile test', $2, $3, 'rep@ecconstructiongroup.com', NOW() - ($4 || ' minutes')::interval)`,
    [leadR.rows[0].id, sid, status, String(ageMinutes)]
  );
  return sid;
}

test('report mode (no --apply): finds a stuck row, reports needs_update, never writes', { skip }, async () => {
  const sid = await stuckOutboundRow({ status: 'queued', ageMinutes: 30 });
  fakeTwilio.responses[sid] = { ok: true, status: 'delivered', errorCode: null, errorMessage: null };

  const { summary, results } = await reconcile.main({ apply: false, json: true, minutes: 10 });
  const mine = results.find((r) => r.twilio_sid === sid);
  assert.ok(mine, 'expected the stuck row to be found');
  assert.strictEqual(mine.outcome, 'needs_update');
  assert.strictEqual(mine.normalized_status, 'delivered');

  const row = (await db.query('SELECT status FROM sms_messages WHERE twilio_sid = $1', [sid])).rows[0];
  assert.strictEqual(row.status, 'queued', 'report mode must never write');
});

test('--apply (with the correct confirm-host): writes the real Twilio-reported status', { skip }, async () => {
  const sid = await stuckOutboundRow({ status: 'queued', ageMinutes: 30 });
  fakeTwilio.responses[sid] = { ok: true, status: 'delivered', errorCode: null, errorMessage: null };

  const host = new URL(DB_URL).hostname;
  const { results } = await reconcile.main({ apply: true, confirmHost: host, json: true, minutes: 10 });
  const mine = results.find((r) => r.twilio_sid === sid);
  assert.strictEqual(mine.outcome, 'updated');

  const row = (await db.query('SELECT status FROM sms_messages WHERE twilio_sid = $1', [sid])).rows[0];
  assert.strictEqual(row.status, 'delivered');
});

test('--apply without the correct confirm-host refuses and changes nothing', { skip }, async () => {
  const sid = await stuckOutboundRow({ status: 'queued', ageMinutes: 30 });
  fakeTwilio.responses[sid] = { ok: true, status: 'delivered', errorCode: null, errorMessage: null };

  await assert.rejects(
    () => reconcile.main({ apply: true, confirmHost: 'wrong-host', json: true, minutes: 10 }),
    (e) => e.code === 'confirm_host_required'
  );
  const row = (await db.query('SELECT status FROM sms_messages WHERE twilio_sid = $1', [sid])).rows[0];
  assert.strictEqual(row.status, 'queued', 'a refused apply must never write');
});

test('a row still within the grace window (genuinely in flight) is never touched', { skip }, async () => {
  const sid = await stuckOutboundRow({ status: 'queued', ageMinutes: 1 });
  fakeTwilio.responses[sid] = { ok: true, status: 'delivered', errorCode: null, errorMessage: null };

  const { results } = await reconcile.main({ apply: false, json: true, minutes: 10 });
  assert.ok(!results.some((r) => r.twilio_sid === sid), 'a message only 1 minute old must not be flagged (10-minute grace window)');
});

test('a row already terminal in the DB is never checked at all', { skip }, async () => {
  const sid = await stuckOutboundRow({ status: 'delivered', ageMinutes: 30 });
  fakeTwilio.responses[sid] = { ok: true, status: 'failed', errorCode: '99', errorMessage: 'should never be applied' };

  const { results } = await reconcile.main({ apply: true, confirmHost: new URL(DB_URL).hostname, json: true, minutes: 10 });
  assert.ok(!results.some((r) => r.twilio_sid === sid), 'an already-terminal row must never be re-checked or overwritten');

  const row = (await db.query('SELECT status FROM sms_messages WHERE twilio_sid = $1', [sid])).rows[0];
  assert.strictEqual(row.status, 'delivered');
});

test('a row that genuinely matches Twilio\'s current status is reported unchanged, never written', { skip }, async () => {
  const sid = await stuckOutboundRow({ status: 'sent', ageMinutes: 30 });
  fakeTwilio.responses[sid] = { ok: true, status: 'sent', errorCode: null, errorMessage: null };

  const { results } = await reconcile.main({ apply: true, confirmHost: new URL(DB_URL).hostname, json: true, minutes: 10 });
  const mine = results.find((r) => r.twilio_sid === sid);
  assert.strictEqual(mine.outcome, 'unchanged');
});

test('a failed live Twilio lookup is reported as check_failed, never crashes the whole run', { skip }, async () => {
  const sid = await stuckOutboundRow({ status: 'queued', ageMinutes: 30 });
  fakeTwilio.responses[sid] = { ok: false, reason: 'twilio_http_404' };

  const { results } = await reconcile.main({ apply: false, json: true, minutes: 10 });
  const mine = results.find((r) => r.twilio_sid === sid);
  assert.strictEqual(mine.outcome, 'check_failed');
  assert.strictEqual(mine.reason, 'twilio_http_404');
});

test('never sends a message — reconciliation is read-only toward Twilio', { skip }, async () => {
  await stuckOutboundRow({ status: 'queued', ageMinutes: 30 });
  // fakeTwilio.sendMessage throws if ever called — main() completing without
  // throwing proves it was never invoked.
  await reconcile.main({ apply: true, confirmHost: new URL(DB_URL).hostname, json: true, minutes: 10 });
});
