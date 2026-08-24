/* eslint-disable no-undef */
/**
 * railwayEmailSender.test.js — Tests for the shared server-side Railway email
 * transport helper used by migrated Base44 backend functions.
 */
const { execSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = '/tmp/railwayEmailSender_bundled.cjs';
const KEYS_OUT = '/tmp/backendIdempotencyKeys_bundled.cjs';

execSync(`npx esbuild base44/shared/railwayEmailSender.ts --bundle --format=cjs --outfile=${OUT} --platform=node 2>&1`, { cwd: ROOT, stdio: 'pipe', timeout: 30000 });
execSync(`npx esbuild base44/shared/backendIdempotencyKeys.ts --bundle --format=cjs --outfile=${KEYS_OUT} --platform=node 2>&1`, { cwd: ROOT, stdio: 'pipe', timeout: 30000 });

// ── Mock state ──────────────────────────────────────────────────────────────
let mockResponse = { ok: true, status: 200, body: { ok: true, gmailMessageId: 'msg_123', idempotent: false, claimId: 'claim_1' } };
let fetchCallCount = 0;
let lastFetchRequest = null;
let fetchShouldAbort = false;
let customFetchImpl = null;

global.fetch = async (url, opts) => {
  if (customFetchImpl) return customFetchImpl(url, opts);
  fetchCallCount++;
  lastFetchRequest = { url, opts };
  if (fetchShouldAbort) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
  return { ok: mockResponse.ok, status: mockResponse.status, json: async () => mockResponse.body, text: async () => JSON.stringify(mockResponse.body) };
};

global.Deno = { env: { get(key) { if (key === 'QB_PROXY_URL') return 'https://railway.test.internal'; if (key === 'QB_PROXY_SECRET') return 'test-proxy-secret'; return undefined; } } };

delete require.cache[OUT]; delete require.cache[KEYS_OUT];
const { sendViaRailway, sendToEachViaRailway } = require(OUT);
const { BackendIdempotencyKeys } = require(KEYS_OUT);

// ── Sequential test runner ──────────────────────────────────────────────────
let passed = 0, failed = 0;
const tests = [];

function test(name, fn) { tests.push({ name, fn, async: false }); }
function asyncTest(name, fn) { tests.push({ name, fn, async: true }); }

function reset() {
  fetchCallCount = 0; lastFetchRequest = null; fetchShouldAbort = false; customFetchImpl = null;
  mockResponse = { ok: true, status: 200, body: { ok: true, gmailMessageId: 'msg_123', idempotent: false, claimId: 'claim_1' } };
}

// ── Tests ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  Railway Email Sender — Shared Helper Tests');
console.log('═══════════════════════════════════════════════════════════════\n');

asyncTest('successful Railway delivery returns ok result', async () => {
  const r = await sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'k1', role: 'test' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.gmailMessageId, 'msg_123');
  assert.strictEqual(fetchCallCount, 1);
});

asyncTest('401 response throws error (no fallback)', async () => {
  mockResponse = { ok: false, status: 401, body: { error: 'Unauthorized' } };
  await assert.rejects(() => sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'k401' }), /401/);
  assert.strictEqual(fetchCallCount, 1);
});

asyncTest('400 response throws error', async () => {
  mockResponse = { ok: false, status: 400, body: { error: 'missing' } };
  await assert.rejects(() => sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'k400' }), /400/);
});

asyncTest('500 response throws error (no fallback to Base44)', async () => {
  mockResponse = { ok: false, status: 500, body: { error: 'failed' } };
  await assert.rejects(() => sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'k500' }), /500/);
  assert.strictEqual(fetchCallCount, 1);
});

asyncTest('timeout throws timed-out message', async () => {
  fetchShouldAbort = true;
  await assert.rejects(() => sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'kt' }), /timed out/);
});

asyncTest('duplicate idempotency key returns idempotent result', async () => {
  mockResponse = { ok: true, status: 200, body: { ok: true, gmailMessageId: 'msg_orig', idempotent: true, claimId: 'c1' } };
  const r = await sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'dup' });
  assert.strictEqual(r.idempotent, true);
  assert.strictEqual(r.gmailMessageId, 'msg_orig');
});

asyncTest('recipient is preserved in request body', async () => {
  await sendViaRailway({ to: 'michelle@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'kr' });
  assert.strictEqual(JSON.parse(lastFetchRequest.opts.body).to, 'michelle@ec.com');
});

asyncTest('subject is preserved in request body', async () => {
  const subject = '📥 New Incoming Lead: John Doe — Los Angeles';
  await sendViaRailway({ to: 'y@ec.com', subject, htmlBody: '<p>H</p>', idempotencyKey: 'ks' });
  assert.strictEqual(JSON.parse(lastFetchRequest.opts.body).subject, subject);
});

asyncTest('htmlBody is preserved in request body', async () => {
  const html = '<html><body><h1>Test</h1></body></html>';
  await sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: html, idempotencyKey: 'kb' });
  assert.strictEqual(JSON.parse(lastFetchRequest.opts.body).htmlBody, html);
});

asyncTest('no Gmail API call — only Railway /internal/email/send', async () => {
  await sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'kng' });
  assert.strictEqual(fetchCallCount, 1);
  assert.ok(lastFetchRequest.url.includes('/internal/email/send'));
  assert.ok(!lastFetchRequest.url.includes('gmail.googleapis.com'));
});

asyncTest('idempotency key is passed to Railway in request body', async () => {
  const key = 'notify-new-lead:lead_123:2026-08-04T10:00:00Z';
  await sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: key });
  assert.strictEqual(JSON.parse(lastFetchRequest.opts.body).idempotencyKey, key);
});

asyncTest('X-Proxy-Secret header is set from QB_PROXY_SECRET', async () => {
  await sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'ksec' });
  assert.strictEqual(lastFetchRequest.opts.headers['X-Proxy-Secret'], 'test-proxy-secret');
});

asyncTest('missing QB_PROXY_URL throws clear error', async () => {
  const orig = global.Deno.env.get;
  global.Deno.env.get = (k) => k === 'QB_PROXY_URL' ? undefined : orig(k);
  try { await assert.rejects(() => sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'ku' }), /QB_PROXY_URL/); }
  finally { global.Deno.env.get = orig; }
});

asyncTest('missing QB_PROXY_SECRET throws clear error', async () => {
  const orig = global.Deno.env.get;
  global.Deno.env.get = (k) => k === 'QB_PROXY_SECRET' ? undefined : orig(k);
  try { await assert.rejects(() => sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: 'ks2' }), /QB_PROXY_SECRET/); }
  finally { global.Deno.env.get = orig; }
});

asyncTest('missing idempotencyKey throws clear error', async () => {
  await assert.rejects(() => sendViaRailway({ to: 'y@ec.com', subject: 'S', htmlBody: '<p>H</p>', idempotencyKey: '' }), /idempotencyKey/);
});

asyncTest('sendToEachViaRailway sends to each recipient with unique key', async () => {
  const results = await sendToEachViaRailway(['yaron@ec.com', 'michelle@ec.com'], { subject: 'S', htmlBody: '<p>H</p>', role: 'test' }, (r) => `key-${r}`);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].to, 'yaron@ec.com');
  assert.strictEqual(results[1].to, 'michelle@ec.com');
  assert.strictEqual(fetchCallCount, 2);
});

asyncTest('sendToEachViaRailway captures per-recipient failure without throwing', async () => {
  let callNum = 0;
  customFetchImpl = async () => {
    callNum++;
    if (callNum === 1) return { ok: false, status: 500, json: async () => ({ error: 'err' }), text: async () => '{}' };
    return { ok: true, status: 200, json: async () => ({ ok: true, gmailMessageId: 'ok', idempotent: false }), text: async () => '{}' };
  };
  const results = await sendToEachViaRailway(['fail@ec.com', 'ok@ec.com'], { subject: 'S', htmlBody: '<p>H</p>' }, (r) => `key-${r}`);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].ok, false);
  assert.ok(results[0].error);
  assert.strictEqual(results[1].ok, true);
});

// ── Synchronous idempotency key tests ───────────────────────────────────────
console.log('  ── Idempotency Key Determinism ──');

test('newLeadNotification key is deterministic', () => {
  const k1 = BackendIdempotencyKeys.newLeadNotification('lead_123', '2026-08-04T10:00:00Z');
  const k2 = BackendIdempotencyKeys.newLeadNotification('lead_123', '2026-08-04T10:00:00Z');
  assert.strictEqual(k1, k2);
  assert.strictEqual(k1, 'notify-new-lead:lead_123:2026-08-04T10-00-00Z');
});

test('newLeadNotification key differs for different leads', () => {
  const k1 = BackendIdempotencyKeys.newLeadNotification('lead_123', '2026-08-04T10:00:00Z');
  const k2 = BackendIdempotencyKeys.newLeadNotification('lead_456', '2026-08-04T10:00:00Z');
  assert.ok(k1 !== k2);
});

test('crmActivityNotification key is deterministic', () => {
  assert.strictEqual(BackendIdempotencyKeys.crmActivityNotification('Lead', 'lead_1', 'act_1'), 'notify-crm-activity:Lead:lead_1:act_1');
});

test('statusChangeNotification key is deterministic', () => {
  assert.strictEqual(BackendIdempotencyKeys.statusChangeNotification('Lead', 'lead_1', 'New', 'Sold'), 'notify-status-change:Lead:lead_1:New:Sold');
});

test('statusChangeNotification key differs for different transitions', () => {
  const k1 = BackendIdempotencyKeys.statusChangeNotification('Lead', 'lead_1', 'New', 'Sold');
  const k2 = BackendIdempotencyKeys.statusChangeNotification('Lead', 'lead_1', 'New', 'Lost');
  assert.ok(k1 !== k2);
});

test('projectStatusEmail key is deterministic', () => {
  assert.strictEqual(BackendIdempotencyKeys.projectStatusEmail('proj_1', 'In Progress', '2026-08-04T12:00:00Z'), 'project-status-email:proj_1:In-Progress:2026-08-04T12-00-00Z');
});

test('appointmentReminder key is deterministic', () => {
  assert.strictEqual(BackendIdempotencyKeys.appointmentReminder('lead_1', '1234567890000', '24h:customer'), 'appointment-reminder:lead_1:1234567890000:24h-customer');
});

test('appointmentReminder key differs for customer vs staff', () => {
  const kc = BackendIdempotencyKeys.appointmentReminder('lead_1', '1234567890000', '2h:customer');
  const ks = BackendIdempotencyKeys.appointmentReminder('lead_1', '1234567890000', '2h:staff:y@ec.com');
  assert.ok(kc !== ks);
});

test('no Date.now or Math.random in idempotency keys', () => {
  const k1 = BackendIdempotencyKeys.newLeadNotification('lead_1', '2026-01-01T00:00:00Z');
  const k2 = BackendIdempotencyKeys.newLeadNotification('lead_1', '2026-01-01T00:00:00Z');
  assert.strictEqual(k1, k2);
});

// ── Run all tests sequentially ───────────────────────────────────────────────
(async () => {
  for (const { name, fn, async: isAsync } of tests) {
    reset();
    try {
      if (isAsync) await fn();
      else fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${name}`);
      console.error(`     ${e.message}`);
    }
  }
  console.log('\n───────────────────────────────────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('───────────────────────────────────────────────────────────────\n');
  if (failed > 0) process.exit(1);
})();