/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupSequence.int.test.js — REAL-Postgres, end-to-end proof of
 * the automated 14-day estimate follow-up email sequence
 * (lib/estimateFollowupEngine.js, lib/estimateFollowupEligibility.js,
 * lib/estimateFollowupTemplates.js, routes/estimateFollowups.js).
 *
 * Only the email transport (lib/emailService) is faked — everything else
 * (eligibility checks, scheduling math, claim/lease atomicity, catch-up
 * collapsing, pause/stop/unsubscribe, HTTP ownership scoping) runs for real
 * against a disposable, migrated Postgres instance. Skipped without
 * TEST_DATABASE_URL.
 *
 * Covers (mapped to the feature spec's required test scenarios):
 *   - full lifecycle: confirm-sent -> 6 steps scheduled -> due step sent
 *   - catch-up backlog collapsing (only the latest overdue step ever sends)
 *   - one estimate-followup email per lead per calendar day
 *   - auto-stop when the lead becomes terminal-lost/Sold mid-sequence
 *   - auto-stop when the estimate is no longer Pending (accepted/voided)
 *   - revised/multiple estimates: a competing active sequence is rejected
 *   - pause / resume / stop lifecycle
 *   - unsubscribe-by-token: suppresses the email + stops the sequence, and
 *     a later enroll attempt for that email is rejected
 *   - concurrent worker claim safety: two overlapping ticks never double-send
 *   - a missing business address blocks the whole tick (ConfigurationError)
 *     and is reported via the failure-alert path
 *   - role-scoped HTTP access (sales_rep own lead vs. another rep's lead)
 *   - the dry-run eligibility report never sends anything
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
  process.env.RAILWAY_JWT_SECRET = process.env.RAILWAY_JWT_SECRET || 'int-test-secret-int-test-secret-0123456789';
}

const sentEmails = [];
function stubModule(relPath, exportsObj) {
  const p = require.resolve(path.join(ROOT, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

let db, engine, eligibility, templates, ownerA, ownerB, server, base;
let companySettingsRestore = null; // { id, company_address, company_city, company_state, company_zip } — the real pre-existing singleton row's original values, restored in test.after
let companySettingsIdToCleanUp = null; // set only when THIS suite inserted the very first (now-singleton) row, so it can be fully removed afterward
const RUN = `ef${Date.now().toString(36)}`;

function token(role, email, id) {
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  return issueAccessToken({ id: id || `00000000-0000-0000-0000-00000000000${role === 'admin' ? 1 : role === 'manager' ? 2 : 3}`, email, role, full_name: 'Test User' });
}

async function makeLead({ status = 'Appointment scheduled', ownerId, email } = {}) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, email, created_at)
     VALUES ('Jane', $1, $2, $3, $4, $5, '2099-01-01') RETURNING id`,
    [RUN, ownerId || ownerA, status, `310${Math.floor(1000000 + Math.random() * 8999999)}`, email]
  );
  return r.rows[0].id;
}

async function makeEstimate(leadId, { status = 'Pending', number } = {}) {
  const r = await db.query(
    `INSERT INTO handoff_estimates (lead_id, customer_name, estimate_status, qb_estimate_number, qb_estimate_id)
     VALUES ($1, 'Jane Test', $2, $3, $4) RETURNING id`,
    [leadId, status, number || `EST-${RUN}-${Math.random().toString(36).slice(2, 8)}`, `QBID-${Math.random().toString(36).slice(2, 10)}`]
  );
  return r.rows[0].id;
}

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));

  stubModule('lib/emailService', {
    send: async (msg) => {
      if (msg.__forceFail) throw new Error('simulated transient send failure');
      sentEmails.push(msg);
      return { ok: true, gmailMessageId: `m${sentEmails.length}` };
    },
  });
  delete require.cache[require.resolve(path.join(ROOT, 'lib/estimateFollowupEngine'))];
  delete require.cache[require.resolve(path.join(ROOT, 'lib/estimateFollowupTemplates'))];
  engine = require(path.join(ROOT, 'lib/estimateFollowupEngine'));
  eligibility = require(path.join(ROOT, 'lib/estimateFollowupEligibility'));
  templates = require(path.join(ROOT, 'lib/estimateFollowupTemplates'));

  // This suite asserts exact tick-level counts (summary.sent/stopped/
  // wouldSend/deferredOnePerDay), which are necessarily GLOBAL across every
  // active sequence in the database, not scoped to this file's own RUN
  // prefix. Start from a clean slate so those counts are deterministic
  // regardless of what any other test file (or a prior manual run against
  // this same disposable database) may have left behind.
  await db.query('TRUNCATE estimate_followup_steps, estimate_followup_sequences, estimate_followup_suppressions CASCADE');

  // company_settings is an UNSCOPED SINGLETON (ORDER BY created_at ASC LIMIT
  // 1, per CLAUDE.md's own documented rule) — inserting a second row with a
  // test-specific company_name would never become the active row (the
  // oldest row always wins), but inserting the FIRST-EVER row (as happens
  // against a brand-new disposable database with no row at all) makes this
  // test's own row the permanent singleton for every other test file run
  // afterward in the same process/database. Mirrors
  // test/integration/moduleGateWiring.int.test.js's established pattern:
  // update-and-restore an existing row, or insert-with-the-real-default-
  // name-and-delete-afterward when none exists — never leave a stray
  // test-named row behind as the singleton.
  const existingCompanySettings = (await db.query('SELECT id, company_address, company_city, company_state, company_zip FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  let insertedCompanySettingsId = null;
  if (existingCompanySettings) {
    companySettingsRestore = existingCompanySettings;
    await db.query(
      `UPDATE company_settings SET company_address = '123 Main St', company_city = 'Los Angeles', company_state = 'CA', company_zip = '90001' WHERE id = $1`,
      [existingCompanySettings.id]
    );
  } else {
    const { rows } = await db.query(
      `INSERT INTO company_settings (company_name, company_address, company_city, company_state, company_zip)
       VALUES ('EC Construction Group', '123 Main St', 'Los Angeles', 'CA', '90001') RETURNING id`
    );
    insertedCompanySettingsId = rows[0].id;
  }
  companySettingsIdToCleanUp = insertedCompanySettingsId;
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();

  // This suite tests the PRE-EXISTING manual lifecycle (enroll/pause/resume/
  // stop/send) — the fail-closed reply-monitoring gate added for the
  // "Fully Automatic Estimate Detection and Customer Reply Tracking"
  // requirement is a SEPARATE concern, covered on its own in
  // test/integration/estimateFollowupAutomaticDetection.int.test.js. Without
  // this, every real send in this file would be silently held
  // (heldForMonitoring) instead of sent, since reply monitoring defaults to
  // disabled/unhealthy. Seed a healthy checkpoint + enable the flag so this
  // file's own, unrelated assertions keep exercising real sends.
  process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'true';
  const MAILBOX = process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';
  await db.query(
    `INSERT INTO estimate_followup_gmail_checkpoint (mailbox, history_id, status, last_success_at)
     VALUES ($1, '1', 'healthy', NOW())
     ON CONFLICT (mailbox) DO UPDATE SET history_id='1', status='healthy', last_success_at=NOW(), consecutive_failures=0`,
    [MAILBOX]
  );

  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Owner A', true) ON CONFLICT DO NOTHING`, [`${RUN}.ownerA@example.com`]);
  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Owner B', true) ON CONFLICT DO NOTHING`, [`${RUN}.ownerB@example.com`]);
  ownerA = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.ownerA@example.com`])).rows[0].id;
  ownerB = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.ownerB@example.com`])).rows[0].id;

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/v1', require(path.join(ROOT, 'routes/estimateFollowups')));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (skip) return;
  server.close();
  if (companySettingsIdToCleanUp) {
    await db.query('DELETE FROM company_settings WHERE id = $1', [companySettingsIdToCleanUp]);
  } else if (companySettingsRestore) {
    await db.query(
      `UPDATE company_settings SET company_address = $2, company_city = $3, company_state = $4, company_zip = $5 WHERE id = $1`,
      [companySettingsRestore.id, companySettingsRestore.company_address, companySettingsRestore.company_city, companySettingsRestore.company_state, companySettingsRestore.company_zip]
    );
  }
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();
  delete process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED;
  await db.pool.end();
});

// ── 1. Full lifecycle: confirm-sent -> 6 steps -> due step sent ───────────
test('confirmEstimateSent schedules all 6 steps with the correct cadence; a due step sends and completes the day-1 step', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.lifecycle@example.com` });
  const estimateId = await makeEstimate(leadId);

  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  assert.strictEqual(sequence.status, 'active');
  assert.strictEqual(sequence.estimate_sent_confirmed_by, 'rep@example.com');

  // Confirmation method + activity history, per the explicit requirement
  // ("the system must record... confirmation method and activity history").
  assert.ok(sequence.qb_estimate_id, 'the exact QuickBooks estimate id must be recorded on the sequence itself');
  const { rows: enrollActivity } = await db.query(
    `SELECT * FROM activities WHERE lead_id = $1 AND content ILIKE '%sequence started%' ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  );
  assert.strictEqual(enrollActivity.length, 1);
  assert.strictEqual(enrollActivity[0].author, 'rep@example.com');
  assert.ok(enrollActivity[0].content.includes(sequence.qb_estimate_id));
  assert.ok(enrollActivity[0].content.includes(`${RUN}.lifecycle@example.com`));

  const steps = await engine.getStepsForSequence(sequence.id);
  assert.strictEqual(steps.length, 6);
  assert.deepStrictEqual(steps.map((s) => s.step_number), [1, 2, 3, 4, 5, 6]);
  assert.ok(steps.every((s) => s.status === 'pending'));

  // Force the day-1 step into the past so the tick picks it up.
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  sentEmails.length = 0;
  const summary = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(sentEmails.length, 1);
  assert.strictEqual(sentEmails[0].to, `${RUN}.lifecycle@example.com`);

  const updatedSteps = await engine.getStepsForSequence(sequence.id);
  assert.strictEqual(updatedSteps[0].status, 'sent');
  assert.ok(updatedSteps[0].sent_at);
});

// ── 2. Catch-up backlog collapsing ─────────────────────────────────────────
test('a backlog of overdue steps collapses to only the latest one sending; earlier ones are marked skipped', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.catchup@example.com` });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);

  // Simulate a long outage: steps 1, 2, and 3 are all overdue at once.
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '10 days' WHERE id = ANY($1)`, [[steps[0].id, steps[1].id, steps[2].id]]);

  sentEmails.length = 0;
  const summary = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(summary.sent, 1, 'only the single latest overdue step sends');

  const updated = await engine.getStepsForSequence(sequence.id);
  const byNumber = Object.fromEntries(updated.map((s) => [s.step_number, s]));
  assert.strictEqual(byNumber[1].status, 'skipped');
  assert.strictEqual(byNumber[1].skipped_reason, 'superseded_by_later_step');
  assert.strictEqual(byNumber[2].status, 'skipped');
  assert.strictEqual(byNumber[3].status, 'sent', 'the latest overdue step (step 3) is the one that actually sends');
});

// ── 3. One email per lead per calendar day ─────────────────────────────────
test('a lead that already received an estimate-followup email today is deferred, never double-sent same day', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.oneperday@example.com` });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);

  // Mark step 1 as already sent earlier today, then make step 2 also due now.
  await db.query(`UPDATE estimate_followup_steps SET status = 'sent', sent_at = NOW() WHERE id = $1`, [steps[0].id]);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[1].id]);

  sentEmails.length = 0;
  const summary = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.deferredOnePerDay, 1);
  assert.strictEqual(sentEmails.length, 0);

  const updated = await engine.getStepsForSequence(sequence.id);
  assert.strictEqual(updated[1].status, 'pending', 'the deferred step stays pending, to be picked up on a later tick');

  // Clean up: stop the sequence so this leftover overdue-but-deferred step
  // never interferes with a later test's own tick-level counts in this file.
  await engine.stopSequence({ sequenceId: sequence.id, reason: 'test_cleanup', stoppedBy: 'test' });
});

// ── 4. Auto-stop: lead becomes terminal-lost mid-sequence ──────────────────
test('a lead that becomes Lost between enrollment and a due step is auto-stopped, never sent to', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.autostop-lost@example.com` });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  await db.query(`UPDATE leads SET status = 'Lost' WHERE id = $1`, [leadId]);

  sentEmails.length = 0;
  const summary = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.stopped, 1);
  assert.strictEqual(sentEmails.length, 0);

  const refreshed = await engine.getSequenceForLead(leadId);
  assert.strictEqual(refreshed.status, 'stopped');
  assert.match(refreshed.stopped_reason, /lead_status_disqualifying:Lost/);
});

// ── 5. Auto-stop: estimate no longer Pending ───────────────────────────────
test('an estimate that becomes Accepted between enrollment and a due step stops the sequence', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.autostop-accepted@example.com` });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  await db.query(`UPDATE handoff_estimates SET estimate_status = 'Accepted' WHERE id = $1`, [estimateId]);

  sentEmails.length = 0;
  const summary = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(summary.sent, 0);
  assert.strictEqual(summary.stopped, 1);

  const refreshed = await engine.getSequenceForLead(leadId);
  assert.strictEqual(refreshed.status, 'stopped');
  assert.strictEqual(refreshed.stopped_reason, 'estimate_not_pending:Accepted');
});

// ── 6. Revised/multiple estimates: competing sequence rejected ─────────────
test('a second enroll attempt for the same lead while one sequence is already active/paused is rejected, never a competing sequence', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.competing@example.com` });
  const estimate1 = await makeEstimate(leadId);
  await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimate1, confirmedBy: 'rep@example.com' });

  // A second, revised Pending estimate shows up on the same lead/project.
  const estimate2 = await makeEstimate(leadId);
  await assert.rejects(
    () => engine.confirmEstimateSent({ leadId, handoffEstimateId: estimate2, confirmedBy: 'rep@example.com' }),
    (e) => { assert.strictEqual(e.code, 'not_eligible'); assert.ok(e.reasons.includes('competing_sequence_already_active')); return true; }
  );

  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM estimate_followup_sequences WHERE lead_id = $1`, [leadId]);
  assert.strictEqual(rows[0].n, 1, 'exactly one sequence must exist for this lead');
});

test('once the first sequence is stopped, a revised estimate can enroll a brand-new sequence for the same lead', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.revised@example.com` });
  const estimate1 = await makeEstimate(leadId);
  const { sequence: seq1 } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimate1, confirmedBy: 'rep@example.com' });
  await engine.stopSequence({ sequenceId: seq1.id, reason: 'estimate_revised', stoppedBy: 'rep@example.com' });
  await db.query(`UPDATE handoff_estimates SET estimate_status = 'Closed' WHERE id = $1`, [estimate1]);

  const estimate2 = await makeEstimate(leadId);
  const { sequence: seq2 } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimate2, confirmedBy: 'rep@example.com' });
  assert.strictEqual(seq2.status, 'active');
  assert.notStrictEqual(seq2.id, seq1.id);
});

// ── 7. Pause / resume / stop lifecycle ─────────────────────────────────────
test('pause prevents sending; resume re-allows it; stop cancels all pending steps', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.pauseresume@example.com` });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  await engine.pauseSequence({ sequenceId: sequence.id, reason: 'customer_requested_pause', pausedBy: 'rep@example.com' });
  const { rows: pauseActivity } = await db.query(
    `SELECT * FROM activities WHERE lead_id = $1 AND content ILIKE '%paused%' ORDER BY created_at DESC LIMIT 1`, [leadId]
  );
  assert.strictEqual(pauseActivity.length, 1, 'pause must be recorded in the lead\'s activity history');
  assert.strictEqual(pauseActivity[0].author, 'rep@example.com');

  sentEmails.length = 0;
  const summaryWhilePaused = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(summaryWhilePaused.sent, 0, 'a paused sequence is never processed (query filters status=active)');
  assert.strictEqual(sentEmails.length, 0);

  const resumed = await engine.resumeSequence({ sequenceId: sequence.id, resumedBy: 'rep@example.com' });
  assert.strictEqual(resumed.status, 'active');
  const { rows: resumeActivity } = await db.query(
    `SELECT * FROM activities WHERE lead_id = $1 AND content ILIKE '%resumed%' ORDER BY created_at DESC LIMIT 1`, [leadId]
  );
  assert.strictEqual(resumeActivity.length, 1, 'resume must be recorded in the lead\'s activity history');

  sentEmails.length = 0;
  const summaryAfterResume = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(summaryAfterResume.sent, 1, 'once resumed, the still-due step sends');

  const stopped = await engine.stopSequence({ sequenceId: sequence.id, reason: 'manual_stop', stoppedBy: 'rep@example.com' });
  assert.strictEqual(stopped.status, 'stopped');
  const finalSteps = await engine.getStepsForSequence(sequence.id);
  assert.ok(finalSteps.filter((s) => s.step_number > 1).every((s) => s.status === 'cancelled'));
  const { rows: stopActivity } = await db.query(
    `SELECT * FROM activities WHERE lead_id = $1 AND content ILIKE '%stopped: manual_stop%' ORDER BY created_at DESC LIMIT 1`, [leadId]
  );
  assert.strictEqual(stopActivity.length, 1, 'stop must be recorded in the lead\'s activity history');
});

// ── 8. Unsubscribe-by-token ─────────────────────────────────────────────────
test('unsubscribeByToken suppresses the email and stops the sequence; a later enroll attempt for that email is rejected', { skip }, async () => {
  const email = `${RUN}.unsub@example.com`;
  const leadId = await makeLead({ email });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });

  const token = engine.unsubscribeTokenForSequence(sequence.id);
  const result = await engine.unsubscribeByToken(token);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.email, email);

  const refreshed = await engine.getSequenceForLead(leadId);
  assert.strictEqual(refreshed.status, 'stopped');
  assert.strictEqual(refreshed.stopped_reason, 'customer_unsubscribed');

  const suppressed = await eligibility.isSuppressed(email);
  assert.strictEqual(suppressed, true);

  // A brand-new lead sharing the same (now-suppressed) email must also be rejected.
  const leadId2 = await makeLead({ email });
  const estimate2 = await makeEstimate(leadId2);
  const elig = await eligibility.checkEligibilityForEnrollment({ leadId: leadId2, handoffEstimateId: estimate2 });
  assert.strictEqual(elig.eligible, false);
  assert.ok(elig.reasons.includes('email_suppressed_unsubscribed'));
});

test('unsubscribeByToken with an invalid/garbage token returns ok:false and changes nothing', { skip }, async () => {
  const result = await engine.unsubscribeByToken('not-a-real-token');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'invalid_token');
});

// ── 9. Concurrent worker claim safety ──────────────────────────────────────
test('two overlapping processEstimateFollowups() ticks never double-send the same due step', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.race@example.com` });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  sentEmails.length = 0;
  const [a, b] = await Promise.all([
    engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'race-a' }),
    engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'race-b' }),
  ]);
  const totalSent = a.sent + b.sent;
  assert.strictEqual(totalSent, 1, 'exactly one of the two concurrent ticks must win the claim');
  assert.strictEqual(sentEmails.length, 1, 'emailService.send must be called exactly once, never twice');

  const finalSteps = await engine.getStepsForSequence(sequence.id);
  assert.strictEqual(finalSteps[0].status, 'sent');
});

// ── 10. Missing business address blocks the whole tick ────────────────────
test('a missing business address (ConfigurationError) blocks the tick and is reported via the failure-alert path', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.noaddress@example.com` });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  // Temporarily wipe the configured address.
  await db.query(`UPDATE company_settings SET company_address = NULL, company_city = NULL, company_state = NULL, company_zip = NULL`);
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();

  const alertCalls = [];
  stubModule('lib/estimateFollowupAlerts', { notifyAutomationFailures: async (summary) => { alertCalls.push(summary); } });
  delete require.cache[require.resolve(path.join(ROOT, 'lib/estimateFollowupEngine'))];
  const freshEngine = require(path.join(ROOT, 'lib/estimateFollowupEngine'));

  sentEmails.length = 0;
  const summary = await freshEngine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(summary.configBlocked, true);
  assert.strictEqual(sentEmails.length, 0, 'no email is ever sent while config-blocked');
  assert.strictEqual(alertCalls.length, 1, 'the failure alert must fire exactly once for a config-blocked tick');

  // The claimed step must be released back to pending (never stuck in
  // 'processing') and never marked failed/terminal — a config block is the
  // operator's problem, never grounds to give up on this lead's step.
  const refreshedSteps = await engine.getStepsForSequence(sequence.id);
  assert.strictEqual(refreshedSteps[0].status, 'pending');

  // Clean up: stop the sequence so this leftover overdue-but-never-sent
  // step never interferes with a later test's own tick-level counts.
  await engine.stopSequence({ sequenceId: sequence.id, reason: 'test_cleanup', stoppedBy: 'test' });

  // Restore the address for every subsequent test in this file.
  await db.query(
    `UPDATE company_settings SET company_address = '123 Main St', company_city = 'Los Angeles', company_state = 'CA', company_zip = '90001'`
  );
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();
  delete require.cache[require.resolve(path.join(ROOT, 'lib/estimateFollowupAlerts'))];
  delete require.cache[require.resolve(path.join(ROOT, 'lib/estimateFollowupEngine'))];
  engine = require(path.join(ROOT, 'lib/estimateFollowupEngine'));
});

// ── 11. Role-scoped HTTP access ────────────────────────────────────────────
test('HTTP: a sales_rep can view/confirm-sent their own lead, but gets 403 on another rep\'s lead', { skip }, async () => {
  const ownRepEmail = `${RUN}.ownerA@example.com`;
  const otherRepEmail = `${RUN}.ownerB@example.com`;
  const leadOwnedByA = await makeLead({ ownerId: ownerA, email: `${RUN}.repA-lead@example.com` });
  const estimateA = await makeEstimate(leadOwnedByA);
  const leadOwnedByB = await makeLead({ ownerId: ownerB, email: `${RUN}.repB-lead@example.com` });

  const repAToken = token('sales_rep', ownRepEmail);

  const okRes = await fetch(`${base}/api/v1/leads/${leadOwnedByA}/estimate-followup`, { headers: { Authorization: `Bearer ${repAToken}` } });
  assert.strictEqual(okRes.status, 200);
  const okBody = await okRes.json();
  assert.ok(['awaiting_sent_confirmation', 'not_eligible'].includes(okBody.state));

  const forbiddenRes = await fetch(`${base}/api/v1/leads/${leadOwnedByB}/estimate-followup`, { headers: { Authorization: `Bearer ${repAToken}` } });
  assert.strictEqual(forbiddenRes.status, 403);

  // Confirm-sent on the OWN lead succeeds end-to-end over HTTP.
  const confirmRes = await fetch(`${base}/api/v1/leads/${leadOwnedByA}/estimate-followup/confirm-sent`, {
    method: 'POST', headers: { Authorization: `Bearer ${repAToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoffEstimateId: estimateA }),
  });
  assert.strictEqual(confirmRes.status, 200);
  const confirmBody = await confirmRes.json();
  assert.strictEqual(confirmBody.sequence.status, 'active');

  // manual-enroll is admin/manager-only — a sales_rep must get 403.
  const leadForManual = await makeLead({ ownerId: ownerA, email: `${RUN}.manual-reject@example.com` });
  const estimateForManual = await makeEstimate(leadForManual);
  const manualRes = await fetch(`${base}/api/v1/leads/${leadForManual}/estimate-followup/manual-enroll`, {
    method: 'POST', headers: { Authorization: `Bearer ${repAToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ handoffEstimateId: estimateForManual }),
  });
  assert.strictEqual(manualRes.status, 403);
});

test('HTTP: admin can see and manage every lead\'s sequence, including the admin overview endpoint', { skip }, async () => {
  const adminToken = token('admin', `${RUN}.admin@example.com`);
  const leadId = await makeLead({ ownerId: ownerB, email: `${RUN}.admin-view@example.com` });
  await makeEstimate(leadId);

  const stateRes = await fetch(`${base}/api/v1/leads/${leadId}/estimate-followup`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.strictEqual(stateRes.status, 200);

  const overviewRes = await fetch(`${base}/api/v1/estimate-followups/admin/overview`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.strictEqual(overviewRes.status, 200);
  const overviewBody = await overviewRes.json();
  assert.ok(typeof overviewBody.counts === 'object');
  assert.ok(Array.isArray(overviewBody.sequences));
});

test('HTTP: a sales_rep is forbidden from the admin overview endpoint', { skip }, async () => {
  const repToken = token('sales_rep', `${RUN}.rep-no-admin@example.com`);
  const res = await fetch(`${base}/api/v1/estimate-followups/admin/overview`, { headers: { Authorization: `Bearer ${repToken}` } });
  assert.strictEqual(res.status, 403);
});

// ── 12. Dry-run eligibility report never sends ─────────────────────────────
test('getDryRunEligibilityReport classifies leads correctly and never sends any email', { skip }, async () => {
  const eligibleLead = await makeLead({ email: `${RUN}.dryrun-eligible@example.com` });
  await makeEstimate(eligibleLead);

  const disqualifiedLead = await makeLead({ status: 'Lost', email: `${RUN}.dryrun-disqualified@example.com` });
  await makeEstimate(disqualifiedLead);

  const alreadyEnrolledLead = await makeLead({ email: `${RUN}.dryrun-enrolled@example.com` });
  const alreadyEnrolledEstimate = await makeEstimate(alreadyEnrolledLead);
  await engine.confirmEstimateSent({ leadId: alreadyEnrolledLead, handoffEstimateId: alreadyEnrolledEstimate, confirmedBy: 'rep@example.com' });

  sentEmails.length = 0;
  const report = await engine.getDryRunEligibilityReport();
  assert.strictEqual(sentEmails.length, 0, 'the dry-run report must never send any email');

  const byLead = Object.fromEntries(report.leads.map((l) => [l.lead_id, l]));
  assert.strictEqual(byLead[eligibleLead].state, 'eligible_awaiting_sent_confirmation');
  assert.strictEqual(byLead[disqualifiedLead].state, 'not_eligible');
  assert.ok(byLead[disqualifiedLead].reasons.some((r) => r.startsWith('lead_status_disqualifying')));
  assert.strictEqual(byLead[alreadyEnrolledLead].state, 'already_enrolled');
  assert.strictEqual(byLead[alreadyEnrolledLead].sequence_status, 'active');
});

// ── 13. Dry-run mode of processEstimateFollowups itself sends nothing ─────
test('processEstimateFollowups({dryRun:true}) computes but never writes or sends', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.enginedryrun@example.com` });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  sentEmails.length = 0;
  const summary = await engine.processEstimateFollowups({ dryRun: true, triggeredBy: 'test' });
  assert.strictEqual(summary.wouldSend, 1);
  assert.strictEqual(sentEmails.length, 0);

  const unchangedSteps = await engine.getStepsForSequence(sequence.id);
  assert.strictEqual(unchangedSteps[0].status, 'pending', 'dry-run must never mutate step status');
});
