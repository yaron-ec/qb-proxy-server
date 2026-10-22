/* eslint-disable no-undef */
'use strict';

/**
 * reminderEngineQuietHoursDeferral.test.js — source-level proof of the
 * approved quiet-hours deferral policy (October 2026) in
 * lib/reminderEngine.js#processReminders' SMS claim loop. The full loop is
 * entangled with a live Gmail token refresh and the reminder worker's own
 * process lifecycle, so — matching this repo's existing convention for this
 * exact kind of cron logic (test/qbEstimateSyncCapacity.test.js) — this
 * proves the WIRING is correct via source inspection, while the underlying
 * primitives it reuses (claimFresh/claimExpiredLease/markFailed/markSent/
 * markSkippedNoRecipient) are the SAME ones the pre-existing email reminder
 * suite already exercises extensively against real Postgres.
 *
 * Policy, as approved:
 *   - A quiet-hours rejection is RETRYABLE (markFailed + a short backoff),
 *     never terminal — "determine the next legally permitted sending time."
 *   - Retrying never continues past the appointment's own start time —
 *     "send only if ... the appointment has not started."
 *   - A retry that lands well after the window's natural target uses
 *     non-misleading ("deferred") wording — "adjust the wording."
 *   - Every OTHER rejection reason (opt-out, no consent, etc.) stays
 *     terminal, exactly as before this change.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reminderEngine.js'), 'utf8');

function smsLoopBody() {
  const start = SOURCE.indexOf('for (const smsWin of REMINDER_WINDOWS)');
  assert.ok(start !== -1, 'expected to find the independent SMS claim loop');
  const end = SOURCE.indexOf('\n  const dur = Date.now() - startedAt;', start);
  assert.ok(end !== -1);
  return SOURCE.slice(start, end);
}

test('a quiet_hours rejection is retried via markFailed (RETRYABLE), never terminal', () => {
  const body = smsLoopBody();
  const idx = body.indexOf("smsRes.reason === 'quiet_hours'");
  assert.ok(idx !== -1, 'expected an explicit quiet_hours branch');
  const branch = body.slice(idx, idx + 700);
  assert.match(branch, /markFailed\(smsClaim\.id, 'quiet_hours'/, 'quiet_hours must use markFailed (retryable), not markSkippedNoRecipient (terminal)');
});

test('every non-quiet_hours rejection reason stays terminal (markSkippedNoRecipient), unchanged from before this policy', () => {
  const body = smsLoopBody();
  const elseIdx = body.lastIndexOf('} else {');
  assert.ok(elseIdx !== -1);
  const branch = body.slice(elseIdx, elseIdx + 400);
  assert.match(branch, /markSkippedNoRecipient\(smsClaim\.id\)/);
});

test('retrying never continues past the appointment start time — an expired, still-retryable claim is explicitly closed out, not retried forever', () => {
  const body = smsLoopBody();
  assert.match(body, /now >= appt\.ms/, 'expected an explicit "appointment already started" check');
  const idx = body.indexOf('now >= appt.ms');
  const branch = body.slice(idx, idx + 600);
  assert.match(branch, /claimExpiredLease\(smsKey, owner\)/);
  assert.match(branch, /markSkippedNoRecipient/);
});

test('a retry attempt well past the window\'s natural target is flagged "deferred" and passed into sendWindowSms for non-misleading wording', () => {
  const body = smsLoopBody();
  assert.match(body, /const isDeferred = now > targetMs \+ 25 \* 60 \* 1000/);
  assert.match(body, /sendWindowSms\(lead, smsWin, appt, \{ deferred: isDeferred \}\)/);
});

test('the SMS claim loop is independent of the email `wins` match — not nested inside the email for-loop', () => {
  const smsLoopIdx = SOURCE.indexOf('for (const smsWin of REMINDER_WINDOWS)');
  // The real-send-path email loop immediately preceding the SMS loop (the
  // dry-run path earlier in the file has its own, unrelated "for (const w
  // of wins)" used only for stats — lastIndexOf finds the closest one,
  // i.e. the real-send loop this SMS loop is a sibling of).
  const emailWinsLoopIdx = SOURCE.lastIndexOf('for (const w of wins) {', smsLoopIdx);
  assert.ok(emailWinsLoopIdx !== -1 && emailWinsLoopIdx < smsLoopIdx, 'the SMS loop must appear AFTER the real-send email wins loop, as a sibling, not nested within it');
  const between = SOURCE.slice(emailWinsLoopIdx, smsLoopIdx);
  // The email loop's own closing "}" (at the per-lead loop's indentation,
  // "    }\n") must appear before the SMS loop starts — i.e. the SMS loop
  // is NOT textually inside the email loop's braces.
  assert.match(between, /\n {4}\}\n/, 'expected the email wins loop to close before the SMS loop begins');
});
