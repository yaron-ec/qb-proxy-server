/* eslint-disable no-undef */
'use strict';

/**
 * reminderEngineSmsSkipReason.test.js — the minimal fix making
 * lib/reminderEngine.js#markSkippedNoRecipient persist an already-known SMS
 * skip reason (no_consent, recipient_opted_out, no_phone,
 * twilio_not_configured — whatever lib/smsService.js's SmsError already
 * reported) into reminder_claims.last_error_type, instead of always
 * discarding it as NULL. The existing read-only diagnostics
 * (routes/cronJobs.js#diagnose-reminder-delivery, lib/leadDiagnostic.js)
 * already SELECT this exact column — this fix makes it actually contain
 * something useful, with no endpoint change needed.
 *
 * No DB is required: db/client is stubbed to capture the exact SQL/params
 * markSkippedNoRecipient sends, which is a direct, precise proof of what
 * gets persisted without needing a live Postgres. The call-site wiring
 * inside the SMS loop (which `sendWindowSms`/`smsService.sendSms` reason
 * actually reaches this function) is proven by a source-level test, the
 * same convention already used by bookingConfirmationEmail.test.js and
 * reminderEngineExtendedEmailWindows.test.js for exactly this kind of
 * "prove the live file's call site" guarantee.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function freshEngine() {
  delete require.cache[require.resolve('../lib/reminderEngine')];
  return require('../lib/reminderEngine');
}

test('markSkippedNoRecipient: no reason given (email\'s own zero-recipient call site) persists NULL — byte-identical to prior behavior', async () => {
  const calls = [];
  const restoreDb = stub('../db/client', { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
  try {
    const engine = freshEngine();
    await engine.markSkippedNoRecipient('claim-email-1');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].params, ['claim-email-1', null]);
    assert.match(calls[0].sql, /last_error\s*=\s*NULL/, 'last_error itself must still always be NULL — only last_error_type ever carries a reason');
    assert.match(calls[0].sql, /last_error_type\s*=\s*\$2/);
    assert.match(calls[0].sql, /status = 'skipped_no_recipient'/);
  } finally { restoreDb(); delete require.cache[require.resolve('../lib/reminderEngine')]; }
});

for (const reason of ['no_consent', 'recipient_opted_out', 'no_phone', 'twilio_not_configured']) {
  test(`markSkippedNoRecipient: persists the exact given reason "${reason}" into last_error_type`, async () => {
    const calls = [];
    const restoreDb = stub('../db/client', { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
    try {
      const engine = freshEngine();
      await engine.markSkippedNoRecipient('claim-sms-1', reason);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].params, ['claim-sms-1', reason]);
    } finally { restoreDb(); delete require.cache[require.resolve('../lib/reminderEngine')]; }
  });
}

test('markSkippedNoRecipient: an empty-string reason is treated as no reason (never persists a falsy/garbage value)', async () => {
  const calls = [];
  const restoreDb = stub('../db/client', { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
  try {
    const engine = freshEngine();
    await engine.markSkippedNoRecipient('claim-x', '');
    assert.deepStrictEqual(calls[0].params, ['claim-x', null]);
  } finally { restoreDb(); delete require.cache[require.resolve('../lib/reminderEngine')]; }
});

test('source-level: the permanent SMS-skip branch passes smsRes.reason through; every other call site is unchanged (no scope creep)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/reminderEngine.js'), 'utf8');

  // The fixed call site: the genuine, permanent SMS skip (no_consent,
  // recipient_opted_out, no_phone, twilio_not_configured, etc.) must now
  // pass the real reason through.
  assert.match(
    source,
    /await markSkippedNoRecipient\(smsClaim\.id, smsRes\.reason\);/,
    'the permanent SMS-skip branch must persist smsRes.reason into last_error_type'
  );

  // Email's own zero-recipient call site must remain exactly as it was —
  // no reason argument, preserving existing email semantics untouched.
  assert.match(
    source,
    /await markSkippedNoRecipient\(claim\.id\);/,
    'email\'s zero-recipient skip call site must remain unchanged (no reason passed)'
  );

  // The "feature not activated" SMS branch (SMS_AUTOMATED_REMINDERS_ENABLED
  // off, or enabled_modules.sms off) has no SmsError-based reason to report
  // and is deliberately NOT in scope for this fix — must remain unchanged.
  // There must be exactly one call site with no second argument for the SMS
  // claim (the "not activated" branch) distinct from the one that now passes
  // smsRes.reason.
  const smsClaimNoReasonCallSites = source.match(/await markSkippedNoRecipient\(smsClaim\.id\);/g) || [];
  assert.strictEqual(
    smsClaimNoReasonCallSites.length, 1,
    'exactly one SMS call site (the "feature not activated" branch) must remain unchanged with no reason argument'
  );

  // The quiet-hours-exhausted ("expired — no compliant sending window
  // remained") branch is also deliberately out of scope — still uses
  // markSkippedNoRecipient with no second argument.
  assert.match(
    source,
    /no compliant sending window remained[^`]*`\);\s*\n\s*\}\s*\n\s*continue;/,
    'the quiet-hours-exhausted branch\'s own distinct log message must remain unchanged'
  );

  // The success path (markSent) must be completely untouched by this fix.
  assert.match(
    source,
    /await markSent\(smsClaim\.id, \[\]\);/,
    'the successful-SMS-send branch must remain unchanged'
  );

  // reminder_claims.last_error_type is read by both existing read-only
  // diagnostics — confirms this fix needs no new endpoint (requirement 6).
  // November 2026: diagnose-reminder-delivery's query/response logic was
  // extracted verbatim into lib/reminderDeliveryDiagnostics.js (so the new
  // CRM-admin-authenticated reminder-diagnostics route can reuse it) — the
  // exposure of last_error_type moved with it, unchanged, not removed.
  const sharedDiagnosticsSource = fs.readFileSync(path.join(__dirname, '../lib/reminderDeliveryDiagnostics.js'), 'utf8');
  assert.match(sharedDiagnosticsSource, /last_error_type:\s*c\.last_error_type/, 'the shared diagnostics logic (used by both diagnose-reminder-delivery and the new admin route) must expose last_error_type');
  const leadDiagnosticSource = fs.readFileSync(path.join(__dirname, '../lib/leadDiagnostic.js'), 'utf8');
  assert.match(leadDiagnosticSource, /last_error_type/, 'leadDiagnostic must already select last_error_type');
});

test('source-level: claim keys, lease/dedup primitives, and quiet-hours retry logic are untouched by this fix', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/reminderEngine.js'), 'utf8');
  // Sanity checks that the surrounding dedup/retry/reschedule-safety
  // machinery (requirement 4) was not touched by this change.
  assert.match(source, /ON CONFLICT \(reminder_key\) DO NOTHING/, 'claim dedup primitive must be unchanged');
  assert.match(source, /status IN \('processing', 'failed'\)/, 'lease-expiry retry condition must be unchanged');
  assert.match(source, /markFailed\(smsClaim\.id, 'quiet_hours'/, 'quiet-hours retryable handling must be unchanged');
  assert.match(source, /function smsReminderKey/, 'the SMS claim-key namespace function must still exist, unchanged');
});
