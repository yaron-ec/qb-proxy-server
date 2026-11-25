/* eslint-disable no-undef */
'use strict';

/**
 * reminderEngineSmsSkipActivity.test.js — regression coverage for the
 * "no SMS visibility on the lead" production finding (John Dominguez,
 * November 24 2026): both the 12h and 2h automated SMS reminders for his
 * appointment were correctly, deliberately skipped
 * (`[engine] ⊘ sms 12h skipped (no_consent)` / `⊘ sms 2h skipped
 * (no_consent)` — confirmed directly from real Railway production logs,
 * not guessed) because `leads.sms_consent` was not `true` for this lead.
 * No Twilio API call was ever made — this was never a delivery bug.
 *
 * The real gap: a skipped automated SMS reminder left ZERO trace on the
 * lead's own activity feed — only `reminder_claims.last_error_type`
 * (visible only via the admin-only reminder-diagnostics tool). The two
 * generic "Reminder sent" notes the operator saw were the EMAIL reminder's
 * own activity notes (a separate, independent channel) — there was no
 * corresponding note (or anything else) explaining that SMS was skipped
 * and why, violating the mandatory rule that a skip reason must be
 * recorded on the lead with full visibility for the lead owner.
 *
 * Fix: lib/reminderEngine.js#writeSmsSkippedActivity writes a plain,
 * best-effort 'note' activity (never a fabricated sms_messages/Text
 * Message row — no Twilio call was made, so there is no real message to
 * record there) on every PERMANENT SMS skip, never on a retryable
 * quiet_hours deferral (which can fire many times per appointment — see
 * the Jerry Rossi production log shape, 20+ retries over ~10 hours — and
 * must never spam the activity feed) and never on the "feature not
 * activated" branch (an installation-level fact, not a per-lead one).
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

test('describeSmsSkipReason: maps every known SmsError code to a human-readable label', () => {
  const engine = freshEngine();
  assert.strictEqual(engine.describeSmsSkipReason('no_consent'), 'no SMS consent on file');
  assert.strictEqual(engine.describeSmsSkipReason('recipient_opted_out'), 'this phone number has opted out of SMS (STOP)');
  assert.strictEqual(engine.describeSmsSkipReason('customer_reminders_disabled'), 'customer reminders are disabled for this lead');
  assert.strictEqual(engine.describeSmsSkipReason('no_phone'), 'no phone number on file');
});

test('describeSmsSkipReason: an unmapped/future reason still renders legibly, never throws', () => {
  const engine = freshEngine();
  assert.strictEqual(engine.describeSmsSkipReason('some_future_reason'), 'skipped (some_future_reason)');
});

test('writeSmsSkippedActivity: reproduces the exact John Dominguez production shape (12h, no_consent)', async () => {
  const calls = [];
  const restoreDb = stub('../db/client', { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
  try {
    const engine = freshEngine();
    await engine.writeSmsSkippedActivity('329d1fa5-f3d9-49c0-a7a2-2bbdf4b88251', '12h', 'no_consent');
    assert.strictEqual(calls.length, 1);
    const [leadId, type, content, author, source, metadataJson] = calls[0].params;
    assert.strictEqual(leadId, '329d1fa5-f3d9-49c0-a7a2-2bbdf4b88251');
    assert.strictEqual(type, 'note', 'a skipped SMS is never a fabricated Text Message activity — no Twilio call was made');
    assert.strictEqual(content, 'Automated SMS reminder (12h) was not sent — no SMS consent on file');
    assert.strictEqual(author, 'system');
    assert.strictEqual(source, 'manual', 'this codebase\'s own established convention for a system-authored note (activities.source has no "system" value)');
    const metadata = JSON.parse(metadataJson);
    assert.strictEqual(metadata.channel, 'sms');
    assert.strictEqual(metadata.reminder_key, '12h');
    assert.strictEqual(metadata.skip_reason, 'no_consent');
    assert.ok(metadata.skipped_at);
  } finally { restoreDb(); delete require.cache[require.resolve('../lib/reminderEngine')]; }
});

test('writeSmsSkippedActivity: the 2h window renders its own distinct content', async () => {
  const calls = [];
  const restoreDb = stub('../db/client', { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
  try {
    const engine = freshEngine();
    await engine.writeSmsSkippedActivity('lead-1', '2h', 'recipient_opted_out');
    assert.strictEqual(calls[0].params[2], 'Automated SMS reminder (2h) was not sent — this phone number has opted out of SMS (STOP)');
  } finally { restoreDb(); delete require.cache[require.resolve('../lib/reminderEngine')]; }
});

test('writeSmsSkippedActivity: a DB failure is swallowed (best-effort, never throws, never blocks the caller)', async () => {
  const restoreDb = stub('../db/client', { query: async () => { throw new Error('connection reset'); } });
  try {
    const engine = freshEngine();
    await assert.doesNotReject(engine.writeSmsSkippedActivity('lead-1', '12h', 'no_consent'));
  } finally { restoreDb(); delete require.cache[require.resolve('../lib/reminderEngine')]; }
});

test('source-level: the permanent SMS-skip branch writes a visible activity; the retryable quiet_hours branch never does (never spam the feed on every retry)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/reminderEngine.js'), 'utf8');

  // The permanent skip branch (no_consent/opted_out/no_phone/etc.) calls
  // writeSmsSkippedActivity with the real reason, right alongside the
  // existing last_error_type persistence.
  assert.match(
    source,
    /await markSkippedNoRecipient\(smsClaim\.id, smsRes\.reason\);\s*\n\s*await writeSmsSkippedActivity\(lead\.id, smsWin\.key, smsRes\.reason\);/,
    'the permanent SMS-skip branch must write a visible activity with the real reason'
  );

  // The quiet_hours RETRYABLE branch (markFailed with the 900s backoff)
  // must NEVER call writeSmsSkippedActivity — a lead with many deferrals
  // (the real Jerry Rossi production shape: 20+ retries over ~10 hours)
  // must never get 20+ activity notes for the same still-pending reminder.
  const quietHoursIdx = source.indexOf("markFailed(smsClaim.id, 'quiet_hours'");
  assert.ok(quietHoursIdx !== -1, 'expected the quiet_hours retryable branch to exist');
  const quietHoursBranch = source.slice(quietHoursIdx, quietHoursIdx + 300);
  assert.ok(!quietHoursBranch.includes('writeSmsSkippedActivity'), 'the retryable quiet_hours branch must never write an activity — it is not a terminal outcome');

  // The "feature not activated" branch (no SmsError reason to report) also
  // never writes an activity — an installation-level fact, not a per-lead one.
  const notActivatedIdx = source.indexOf('if (!smsRes.attempted)');
  const notActivatedBranch = source.slice(notActivatedIdx, notActivatedIdx + 300);
  assert.ok(!notActivatedBranch.includes('writeSmsSkippedActivity'), 'the feature-not-activated branch must never write a per-lead activity');

  // The quiet-hours-exhausted ("appointment already started") branch DOES
  // get a visible activity too — the appointment came and went with no
  // compliant window ever found — but last_error_type for THAT specific
  // pre-existing call site stays untouched (deliberate, documented scope
  // boundary from the prior skip-reason-persistence fix).
  const expiredIdx = source.indexOf('const expired = await claimExpiredLease(smsKey, owner);');
  const expiredBranch = source.slice(expiredIdx, expiredIdx + 400);
  assert.match(expiredBranch, /await markSkippedNoRecipient\(expired\.id\);/, 'last_error_type must remain untouched for this specific call site');
  assert.match(expiredBranch, /await writeSmsSkippedActivity\(lead\.id, smsWin\.key, 'quiet_hours_window_exhausted'\);/);

  // The successful-send branch must remain completely untouched by this fix.
  assert.match(source, /await markSent\(smsClaim\.id, \[\]\);\s*\n\s*stats\.sms_sent\+\+;/, 'the successful-send branch must be unchanged — no activity write added there (a real sms_messages row already exists)');
});
