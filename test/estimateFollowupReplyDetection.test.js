/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupReplyDetection.test.js — pure unit coverage (no real
 * Postgres, no real Gmail) for lib/estimateFollowupReplyDetection.js's pure
 * logic: bounce/autoresponder/self-loop filtering, email-address
 * extraction, the tri-state checkpoint status computation, and the
 * fail-closed isReplyMonitoringHealthy() gate's DB-stubbed branches.
 *
 * The full end-to-end correlation/pause/notify/ambiguous-logging behavior
 * (real history.list polling, real DB writes) is covered separately,
 * against real Postgres, in
 * test/integration/estimateFollowupAutomaticDetection.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function freshModule() {
  delete require.cache[require.resolve('../lib/estimateFollowupReplyDetection')];
  delete require.cache[require.resolve('../lib/estimateFollowupReplyNotify')];
  return require('../lib/estimateFollowupReplyDetection');
}

const MAILBOX = process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';

test('extractEmailAddress: parses "Name <email>" and bare addresses', () => {
  const m = freshModule();
  assert.strictEqual(m.extractEmailAddress('Jane Doe <jane@example.com>'), 'jane@example.com');
  assert.strictEqual(m.extractEmailAddress('jane@example.com'), 'jane@example.com');
  assert.strictEqual(m.extractEmailAddress(''), '');
  assert.strictEqual(m.extractEmailAddress(null), '');
});

test('looksLikeAutomatedOrBounce: flags mailer-daemon/postmaster/no-reply From addresses', () => {
  const m = freshModule();
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'mailer-daemon@google.com', subject: 'hi' }), true);
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'postmaster@example.com', subject: 'hi' }), true);
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'no-reply@example.com', subject: 'hi' }), true);
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'do-not-reply@example.com', subject: 'hi' }), true);
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'bounces@example.com', subject: 'hi' }), true);
});

test('looksLikeAutomatedOrBounce: flags our own sending address (self-loop)', () => {
  const m = freshModule();
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: MAILBOX, subject: 'hi' }), true);
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: `Name <${MAILBOX}>`, subject: 'hi' }), true);
});

test('looksLikeAutomatedOrBounce: flags Auto-Submitted header unless exactly "no"', () => {
  const m = freshModule();
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'jane@example.com', subject: 'hi', autoSubmitted: 'auto-replied' }), true);
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'jane@example.com', subject: 'hi', autoSubmitted: 'no' }), false);
});

test('looksLikeAutomatedOrBounce: flags Precedence: bulk/junk/list', () => {
  const m = freshModule();
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'jane@example.com', subject: 'hi', precedence: 'bulk' }), true);
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'jane@example.com', subject: 'hi', precedence: 'junk' }), true);
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'jane@example.com', subject: 'hi', precedence: 'list' }), true);
});

test('looksLikeAutomatedOrBounce: flags common automated-subject patterns', () => {
  const m = freshModule();
  for (const subject of [
    'Automatic reply: Out of office', 'Auto-Reply', 'Out of Office until Monday',
    'Undeliverable: your estimate', 'Delivery Status Notification (Failure)',
    'Mail delivery failed: returning message to sender', 'Message blocked',
    'Undelivered Mail Returned to Sender', 'Returned mail: see transcript',
  ]) {
    assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'jane@example.com', subject }), true, `expected "${subject}" to be flagged`);
  }
});

test('looksLikeAutomatedOrBounce: a genuine customer reply is never flagged', () => {
  const m = freshModule();
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: 'Jane Customer <jane@example.com>', subject: 'Re: your estimate — I have a question' }), false);
});

test('looksLikeAutomatedOrBounce: an empty/missing From address is treated as unusable, not a genuine reply', () => {
  const m = freshModule();
  assert.strictEqual(m.looksLikeAutomatedOrBounce({ from: '', subject: 'hi' }), true);
});

test('computeStatus: no checkpoint row or no last_success_at is always unhealthy', () => {
  const m = freshModule();
  assert.strictEqual(m.computeStatus(null), 'unhealthy');
  assert.strictEqual(m.computeStatus({ last_success_at: null, consecutive_failures: 0 }), 'unhealthy');
});

test('computeStatus: a very recent success with zero failures is healthy', () => {
  const m = freshModule();
  const status = m.computeStatus({ last_success_at: new Date().toISOString(), consecutive_failures: 0 });
  assert.strictEqual(status, 'healthy');
});

test('computeStatus: stale beyond STALE_AFTER_MS or >=2 consecutive failures is degraded (not unhealthy)', () => {
  const m = freshModule();
  const staleButNotUnhealthy = new Date(Date.now() - (m.STALE_AFTER_MS + 60000)).toISOString();
  assert.strictEqual(m.computeStatus({ last_success_at: staleButNotUnhealthy, consecutive_failures: 0 }), 'degraded');
  assert.strictEqual(m.computeStatus({ last_success_at: new Date().toISOString(), consecutive_failures: 2 }), 'degraded');
});

test('computeStatus: stale beyond DEGRADED_AFTER_MS or >=5 consecutive failures is unhealthy', () => {
  const m = freshModule();
  const veryStale = new Date(Date.now() - (m.DEGRADED_AFTER_MS + 60000)).toISOString();
  assert.strictEqual(m.computeStatus({ last_success_at: veryStale, consecutive_failures: 0 }), 'unhealthy');
  assert.strictEqual(m.computeStatus({ last_success_at: new Date().toISOString(), consecutive_failures: 5 }), 'unhealthy');
});

test('isReplyMonitoringHealthy: disabled feature reports unhealthy with the exact reason, regardless of checkpoint state', async () => {
  delete process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED;
  const restoreDb = stub('../db/client', { query: async () => ({ rows: [{ status: 'healthy', last_success_at: new Date().toISOString(), consecutive_failures: 0 }] }) });
  try {
    const m = freshModule();
    const health = await m.isReplyMonitoringHealthy();
    assert.strictEqual(health.healthy, false);
    assert.strictEqual(health.reason, 'reply_detection_disabled');
  } finally { restoreDb(); }
});

test('isReplyMonitoringHealthy: enabled with no checkpoint row at all reports unhealthy', async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'true';
  const restoreDb = stub('../db/client', { query: async () => ({ rows: [] }) });
  try {
    const m = freshModule();
    const health = await m.isReplyMonitoringHealthy();
    assert.strictEqual(health.healthy, false);
    assert.strictEqual(health.reason, 'no_checkpoint');
  } finally { restoreDb(); process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'false'; }
});

test('isReplyMonitoringHealthy: enabled + a degraded checkpoint is NEVER good enough — only exactly healthy passes', async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'true';
  const staleTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // > STALE_AFTER_MS (90min), < DEGRADED_AFTER_MS (4h)
  const restoreDb = stub('../db/client', { query: async () => ({ rows: [{ status: 'degraded', last_success_at: staleTs, consecutive_failures: 0 }] }) });
  try {
    const m = freshModule();
    const health = await m.isReplyMonitoringHealthy();
    assert.strictEqual(health.healthy, false);
    assert.strictEqual(health.reason, 'checkpoint_degraded');
  } finally { restoreDb(); process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'false'; }
});

test('isReplyMonitoringHealthy: enabled + a genuinely fresh, healthy checkpoint reports healthy', async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'true';
  const restoreDb = stub('../db/client', { query: async () => ({ rows: [{ status: 'healthy', last_success_at: new Date().toISOString(), consecutive_failures: 0 }] }) });
  try {
    const m = freshModule();
    const health = await m.isReplyMonitoringHealthy();
    assert.strictEqual(health.healthy, true);
    assert.strictEqual(health.reason, 'ok');
  } finally { restoreDb(); process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'false'; }
});
