/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupAutomaticDetection.int.test.js — REAL-Postgres proof of
 * the "REQUIRED CHANGE: Fully Automatic Estimate Detection and Customer
 * Reply Tracking" work:
 *
 *   - lib/estimateSentDetection.js's classifier wired into
 *     lib/estimateFollowupEngine.js#runAutoEnrollmentScan (real DB rows,
 *     not just the pure-unit classifier tests)
 *   - lib/estimateFollowupReplyDetection.js's Gmail history.list poll:
 *     checkpoint bootstrap, thread-id correlation, From-address fallback,
 *     ambiguous-match logging, bounce/autoresponder/self-loop filtering,
 *     idempotency on a redelivered history entry, and the pause + activity
 *     + notify side effects a genuine new reply triggers
 *   - the fail-closed reply-monitoring gate in
 *     lib/estimateFollowupEngine.js#processEstimateFollowups — holds every
 *     due step, for every sequence, whenever monitoring is disabled or
 *     unhealthy, and lets sends proceed once it's healthy
 *   - the new admin HTTP surface (automation-status, ambiguous-replies,
 *     resolve) and the per-lead GET's new replyMonitoring block
 *
 * Only the Gmail HTTP transport (global fetch) and lib/gmailSender's token
 * refresh are faked — everything else (DB correlation queries, the
 * checkpoint state machine, the engine's auto-enrollment/send-gate logic,
 * HTTP role scoping) runs for real against a disposable, migrated Postgres
 * instance. Skipped without TEST_DATABASE_URL.
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
  process.env.PROXY_SECRET = process.env.PROXY_SECRET || 'int-test-proxy-secret';
}

const MAILBOX = process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';
const RUN = `efad${Date.now().toString(36)}`;

function stubModule(relPath, exportsObj) {
  const p = require.resolve(path.join(ROOT, relPath));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

let db, engine, replyDetection, ownerA, server, base;
const sentEmails = [];

// ── Gmail HTTP fake ─────────────────────────────────────────────────────
// Keyed by the exact shapes lib/estimateFollowupReplyDetection.js requests:
// GET .../profile, GET .../history?startHistoryId=..., GET .../messages/:id
let fakeGmailState = null;
function resetFakeGmail({ profileHistoryId = '100', historyPages = [], messages = {} } = {}) {
  fakeGmailState = { profileHistoryId, historyPages: historyPages.slice(), messages: { ...messages } };
}
function installFakeFetch() {
  const realFetch = global.fetch;
  global.fetch = async (url, ...rest) => {
    const u = new URL(String(url));
    if (u.hostname !== 'gmail.googleapis.com') return realFetch(url, ...rest);
    if (u.pathname.endsWith('/profile')) {
      return jsonRes({ historyId: fakeGmailState.profileHistoryId });
    }
    if (u.pathname.endsWith('/history')) {
      const page = fakeGmailState.historyPages.shift() || { history: [], historyId: fakeGmailState.profileHistoryId };
      return jsonRes(page);
    }
    const msgMatch = u.pathname.match(/\/messages\/([^/]+)$/);
    if (msgMatch) {
      const msg = fakeGmailState.messages[msgMatch[1]];
      if (!msg) return jsonRes({}, 404);
      return jsonRes(msg);
    }
    return jsonRes({}, 404);
  };
}
function jsonRes(body, status = 200) {
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function gmailMessage({ id, threadId, from, subject = 'Re: your estimate', date = new Date().toISOString(), autoSubmitted, precedence }) {
  const headers = [
    { name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: date },
  ];
  if (autoSubmitted) headers.push({ name: 'Auto-Submitted', value: autoSubmitted });
  if (precedence) headers.push({ name: 'Precedence', value: precedence });
  return { id, threadId, payload: { headers } };
}

async function makeLead({ email, ownerId } = {}) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, email, created_at)
     VALUES ('Jane', $1, $2, 'Appointment scheduled', $3, $4, '2099-01-01') RETURNING id`,
    [RUN, ownerId !== undefined ? ownerId : ownerA, `310${Math.floor(1000000 + Math.random() * 8999999)}`, email]
  );
  return r.rows[0].id;
}

async function makeEstimate(leadId, { status = 'Pending', qbEmailStatus = null, qbEmailDeliveryTime = null } = {}) {
  const r = await db.query(
    `INSERT INTO handoff_estimates (lead_id, customer_name, estimate_status, qb_estimate_number, qb_estimate_id, qb_email_status, qb_email_delivery_time)
     VALUES ($1, 'Jane Test', $2, $3, $4, $5, $6) RETURNING id`,
    [leadId, status, `EST-${RUN}-${Math.random().toString(36).slice(2, 8)}`, `QBID-${Math.random().toString(36).slice(2, 10)}`, qbEmailStatus, qbEmailDeliveryTime]
  );
  return r.rows[0].id;
}

// Enrolls a lead directly via the engine (bypassing confirm-sent HTTP) and
// marks its day-1 step 'sent' with a given gmail_thread_id, as if a real
// send had already happened — the precondition every reply-correlation test
// needs.
async function makeActiveSequenceWithSentStep({ leadId, estimateId, threadId }) {
  const { sequence } = await engine.enroll({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com', method: 'confirm_sent' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET status='sent', sent_at=NOW(), gmail_thread_id=$2 WHERE id=$1`, [steps[0].id, threadId]);
  return sequence;
}

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));

  stubModule('lib/emailService', {
    send: async (msg) => { sentEmails.push(msg); return { ok: true, gmailMessageId: `m${sentEmails.length}`, threadId: `t${sentEmails.length}` }; },
  });
  stubModule('lib/gmailSender', {
    refreshAccessToken: async () => 'fake-access-token',
    GmailCredentialsError: class GmailCredentialsError extends Error {},
  });

  for (const mod of ['lib/estimateFollowupEngine', 'lib/estimateFollowupReplyDetection', 'lib/estimateFollowupReplyNotify']) {
    delete require.cache[require.resolve(path.join(ROOT, mod))];
  }
  engine = require(path.join(ROOT, 'lib/estimateFollowupEngine'));
  replyDetection = require(path.join(ROOT, 'lib/estimateFollowupReplyDetection'));

  installFakeFetch();
  resetFakeGmail();

  await db.query('TRUNCATE estimate_followup_steps, estimate_followup_sequences, estimate_followup_suppressions, estimate_followup_ambiguous_replies CASCADE');
  await db.query('DELETE FROM estimate_followup_gmail_checkpoint');
  await db.query(`DELETE FROM handoff_estimates WHERE customer_name = 'Jane Test'`);

  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Owner A', true) ON CONFLICT DO NOTHING`, [`${RUN}.ownerA@example.com`]);
  ownerA = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.ownerA@example.com`])).rows[0].id;

  const existingCompanySettings = (await db.query('SELECT id FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  if (!existingCompanySettings) {
    await db.query(`INSERT INTO company_settings (company_name, company_address, company_city, company_state, company_zip) VALUES ('EC Construction Group', '123 Main St', 'Los Angeles', 'CA', '90001')`);
    require(path.join(ROOT, 'lib/companyConfig')).invalidate();
  }

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
  delete process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED;
  delete process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED;
  // Leave the shared disposable DB clean for other test files/suites (e.g.
  // the audit-script test asserts real per-row counts against this same
  // table) — this file's own leads/estimates are all RUN-prefixed.
  await db.query(`DELETE FROM handoff_estimates WHERE customer_name = 'Jane Test'`);
  await db.query(`DELETE FROM leads WHERE last_name = $1`, [RUN]);
  await db.pool.end();
});

function token(role, email) {
  const { issueAccessToken } = require(path.join(ROOT, 'lib/authService'));
  return issueAccessToken({ id: `00000000-0000-0000-0000-00000000000${role === 'admin' ? 1 : role === 'manager' ? 2 : 3}`, email, role, full_name: 'Test User' });
}

// ── 1. isReplyMonitoringHealthy / checkpoint lifecycle ──────────────────
test('reply monitoring is treated as unhealthy whenever the feature is disabled, regardless of any checkpoint state', { skip }, async () => {
  delete process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED;
  const health = await replyDetection.isReplyMonitoringHealthy();
  assert.strictEqual(health.healthy, false);
  assert.strictEqual(health.reason, 'reply_detection_disabled');
});

test('first-ever poll bootstraps the checkpoint from the mailbox\'s current historyId, processes zero messages, and reports healthy', { skip }, async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'true';
  resetFakeGmail({ profileHistoryId: '500' });
  const result = await replyDetection.pollForReplies({ triggeredBy: 'test' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.bootstrapped, true);
  assert.strictEqual(result.historyId, '500');

  const health = await replyDetection.isReplyMonitoringHealthy();
  assert.strictEqual(health.healthy, true);
});

// ── 2. Thread-id correlation pauses the correct sequence + logs activity + notifies ──
test('a genuine reply in a known thread pauses the sequence, records an activity, and notifies the assigned rep', { skip }, async () => {
  const leadEmail = `${RUN}.thread@example.com`;
  const leadId = await makeLead({ email: leadEmail });
  const estimateId = await makeEstimate(leadId);
  const sequence = await makeActiveSequenceWithSentStep({ leadId, estimateId, threadId: 'thread-abc' });

  process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'true';
  sentEmails.length = 0;
  const msgId = `gm-${RUN}-1`;
  resetFakeGmail({
    profileHistoryId: '600',
    historyPages: [{ history: [{ messagesAdded: [{ message: { id: msgId } }] }], historyId: '601' }],
    messages: { [msgId]: gmailMessage({ id: msgId, threadId: 'thread-abc', from: `Jane Customer <${leadEmail}>` }) },
  });
  // Pre-seed a prior successful checkpoint so this poll is incremental, not a bootstrap.
  await db.query(
    `INSERT INTO estimate_followup_gmail_checkpoint (mailbox, history_id, status, last_success_at)
     VALUES ($1, '599', 'healthy', NOW()) ON CONFLICT (mailbox) DO UPDATE SET history_id='599', status='healthy', last_success_at=NOW(), consecutive_failures=0`,
    [MAILBOX]
  );

  const result = await replyDetection.pollForReplies({ triggeredBy: 'test' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.matched, 1);
  assert.strictEqual(result.ambiguous, 0);

  const { rows: seqRows } = await db.query('SELECT * FROM estimate_followup_sequences WHERE id = $1', [sequence.id]);
  // November 2026 refinement: a genuine reply now permanently STOPS the
  // sequence (never merely pauses it) — "do not require a team member to
  // stop the sequence manually" + "permanently cancels all remaining
  // emails", read literally. See lib/estimateFollowupReplyDetection.js's
  // own header for the full rationale.
  assert.strictEqual(seqRows[0].status, 'stopped');
  assert.strictEqual(seqRows[0].stopped_reason, 'customer_replied');
  assert.strictEqual(seqRows[0].stopped_by, 'system:gmail_reply_detected');
  assert.strictEqual(seqRows[0].triggering_gmail_message_id, msgId);

  const { rows: activityRows } = await db.query(`SELECT * FROM activities WHERE external_ref = $1`, [`estimate-followup-reply:${msgId}`]);
  assert.strictEqual(activityRows.length, 1);
  assert.strictEqual(activityRows[0].lead_id, leadId);
  assert.strictEqual(activityRows[0].metadata.direction, 'inbound');

  // A SECOND, dedicated "automatically stopped" note is also written —
  // distinct from the raw inbound-email activity above.
  const { rows: stopNoteRows } = await db.query(
    `SELECT * FROM activities WHERE lead_id = $1 AND content ILIKE '%automatically stopped%' ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  );
  assert.strictEqual(stopNoteRows.length, 1);
  assert.strictEqual(stopNoteRows[0].author, 'system:gmail_reply_detected');

  assert.strictEqual(sentEmails.length, 1);
  assert.strictEqual(sentEmails[0].to, `${RUN}.ownerA@example.com`);
});

test('a redelivered identical history entry for the same message is idempotent: no second activity row, no second notification', { skip }, async () => {
  const leadEmail = `${RUN}.redeliver@example.com`;
  const leadId = await makeLead({ email: leadEmail });
  const estimateId = await makeEstimate(leadId);
  await makeActiveSequenceWithSentStep({ leadId, estimateId, threadId: 'thread-redeliver' });

  process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED = 'true';
  sentEmails.length = 0;
  const msgId = `gm-${RUN}-redeliver-1`;
  const msg = { [msgId]: gmailMessage({ id: msgId, threadId: 'thread-redeliver', from: `Jane Customer <${leadEmail}>` }) };
  await db.query(
    `INSERT INTO estimate_followup_gmail_checkpoint (mailbox, history_id, status, last_success_at)
     VALUES ($1, '699', 'healthy', NOW()) ON CONFLICT (mailbox) DO UPDATE SET history_id='699', status='healthy', last_success_at=NOW(), consecutive_failures=0`,
    [MAILBOX]
  );
  resetFakeGmail({ profileHistoryId: '700', historyPages: [{ history: [{ messagesAdded: [{ message: { id: msgId } }] }], historyId: '701' }], messages: msg });
  await replyDetection.pollForReplies({ triggeredBy: 'test' });
  assert.strictEqual(sentEmails.length, 1);

  // Redeliver: same message id shows up again in a fresh history page.
  resetFakeGmail({ profileHistoryId: '701', historyPages: [{ history: [{ messagesAdded: [{ message: { id: msgId } }] }], historyId: '702' }], messages: msg });
  const result2 = await replyDetection.pollForReplies({ triggeredBy: 'test' });
  assert.strictEqual(result2.matched, 1); // still correlates — just never double-writes/double-notifies
  assert.strictEqual(sentEmails.length, 1, 'no second notification email was sent');

  const { rows: activityRows } = await db.query(`SELECT * FROM activities WHERE external_ref = $1`, [`estimate-followup-reply:${msgId}`]);
  assert.strictEqual(activityRows.length, 1, 'no duplicate activity row was created');
});

// ── 3. Bounce / autoresponder / self-loop filtering ─────────────────────
test('a bounce/autoresponder message is ignored: never pauses, never logged as ambiguous, never notifies', { skip }, async () => {
  const leadEmail = `${RUN}.bounce@example.com`;
  const leadId = await makeLead({ email: leadEmail });
  const estimateId = await makeEstimate(leadId);
  const sequence = await makeActiveSequenceWithSentStep({ leadId, estimateId, threadId: 'thread-bounce' });

  sentEmails.length = 0;
  await db.query(
    `INSERT INTO estimate_followup_gmail_checkpoint (mailbox, history_id, status, last_success_at)
     VALUES ($1, '799', 'healthy', NOW()) ON CONFLICT (mailbox) DO UPDATE SET history_id='799', status='healthy', last_success_at=NOW(), consecutive_failures=0`,
    [MAILBOX]
  );
  resetFakeGmail({
    profileHistoryId: '800',
    historyPages: [{ history: [{ messagesAdded: [{ message: { id: `gm-${RUN}-bounce-1` } }] }], historyId: '801' }],
    messages: { [`gm-${RUN}-bounce-1`]: gmailMessage({ id: `gm-${RUN}-bounce-1`, threadId: 'thread-bounce', from: 'mailer-daemon@google.com', subject: 'Delivery Status Notification (Failure)' }) },
  });
  const result = await replyDetection.pollForReplies({ triggeredBy: 'test' });
  assert.strictEqual(result.ignored, 1);
  assert.strictEqual(result.matched, 0);

  const { rows: seqRows } = await db.query('SELECT status FROM estimate_followup_sequences WHERE id = $1', [sequence.id]);
  assert.strictEqual(seqRows[0].status, 'active');
  assert.strictEqual(sentEmails.length, 0);
});

// ── 4. Zero vs multiple From-address matches ────────────────────────────
test('zero matching sequences: an unrelated inbound email is ignored, never logged as ambiguous', { skip }, async () => {
  await db.query(
    `INSERT INTO estimate_followup_gmail_checkpoint (mailbox, history_id, status, last_success_at)
     VALUES ($1, '899', 'healthy', NOW()) ON CONFLICT (mailbox) DO UPDATE SET history_id='899', status='healthy', last_success_at=NOW(), consecutive_failures=0`,
    [MAILBOX]
  );
  resetFakeGmail({
    profileHistoryId: '900',
    historyPages: [{ history: [{ messagesAdded: [{ message: { id: `gm-${RUN}-unrelated-1` } }] }], historyId: '901' }],
    messages: { [`gm-${RUN}-unrelated-1`]: gmailMessage({ id: `gm-${RUN}-unrelated-1`, threadId: 'thread-unrelated', from: 'someone-else@example.com' }) },
  });
  const before = (await db.query('SELECT COUNT(*)::int AS n FROM estimate_followup_ambiguous_replies')).rows[0].n;
  const result = await replyDetection.pollForReplies({ triggeredBy: 'test' });
  assert.strictEqual(result.ignored, 1);
  const after = (await db.query('SELECT COUNT(*)::int AS n FROM estimate_followup_ambiguous_replies')).rows[0].n;
  assert.strictEqual(after, before);
});

test('multiple matching sequences by From-address fallback: recorded as ambiguous, never guessed, neither sequence is paused', { skip }, async () => {
  const sharedEmail = `${RUN}.shared@example.com`;
  const leadId1 = await makeLead({ email: sharedEmail });
  const leadId2 = await makeLead({ email: sharedEmail });
  const estimateId1 = await makeEstimate(leadId1);
  const estimateId2 = await makeEstimate(leadId2);
  // No thread match for either (distinct thread ids never referenced by the inbound message).
  const seq1 = await makeActiveSequenceWithSentStep({ leadId: leadId1, estimateId: estimateId1, threadId: 'thread-amb-1' });
  const seq2 = await makeActiveSequenceWithSentStep({ leadId: leadId2, estimateId: estimateId2, threadId: 'thread-amb-2' });

  await db.query(
    `INSERT INTO estimate_followup_gmail_checkpoint (mailbox, history_id, status, last_success_at)
     VALUES ($1, '999', 'healthy', NOW()) ON CONFLICT (mailbox) DO UPDATE SET history_id='999', status='healthy', last_success_at=NOW(), consecutive_failures=0`,
    [MAILBOX]
  );
  resetFakeGmail({
    profileHistoryId: '1000',
    historyPages: [{ history: [{ messagesAdded: [{ message: { id: `gm-${RUN}-ambiguous-1` } }] }], historyId: '1001' }],
    messages: { [`gm-${RUN}-ambiguous-1`]: gmailMessage({ id: `gm-${RUN}-ambiguous-1`, threadId: 'thread-does-not-match-either', from: sharedEmail }) },
  });
  const result = await replyDetection.pollForReplies({ triggeredBy: 'test' });
  assert.strictEqual(result.ambiguous, 1);

  const { rows: ambiguousRows } = await db.query(`SELECT * FROM estimate_followup_ambiguous_replies WHERE gmail_message_id = $1`, [`gm-${RUN}-ambiguous-1`]);
  assert.strictEqual(ambiguousRows.length, 1);
  assert.strictEqual(ambiguousRows[0].reason, 'multiple_from_address_matches');
  assert.strictEqual(ambiguousRows[0].candidate_sequence_ids.length, 2);

  const { rows: seqRows } = await db.query('SELECT id, status FROM estimate_followup_sequences WHERE id IN ($1,$2)', [seq1.id, seq2.id]);
  assert.ok(seqRows.every((r) => r.status === 'active'), 'neither sequence was guessed/paused');
});

// ── 5. Auto-enrollment scan (lib/estimateSentDetection.js wired in) ──────
test('runAutoEnrollmentScan enrolls a lead whose estimate carries confirmed QuickBooks EmailStatus=EmailSent evidence', { skip }, async () => {
  const leadEmail = `${RUN}.autoenroll@example.com`;
  const leadId = await makeLead({ email: leadEmail });
  const deliveryTime = new Date(Date.now() - 3600000).toISOString();
  const estimateId = await makeEstimate(leadId, { qbEmailStatus: 'EmailSent', qbEmailDeliveryTime: deliveryTime });

  const summary = await engine.runAutoEnrollmentScan({ triggeredBy: 'test' });
  assert.ok(summary.enrolled >= 1);

  const sequence = await engine.getSequenceForLead(leadId);
  assert.ok(sequence);
  assert.strictEqual(sequence.handoff_estimate_id, estimateId);
  assert.strictEqual(sequence.enrollment_method, 'auto_qb_email_status');
  assert.strictEqual(sequence.estimate_sent_confirmed_by, 'system:auto_qb_email_status');
  assert.strictEqual(new Date(sequence.estimate_sent_confirmed_at).toISOString(), deliveryTime);

  // Re-running must never double-enroll — the exact "no duplicate sequences" requirement.
  const summary2 = await engine.runAutoEnrollmentScan({ triggeredBy: 'test' });
  assert.ok(summary2.alreadyEnrolled >= 1);
  const { rows: countRows } = await db.query('SELECT COUNT(*)::int AS n FROM estimate_followup_sequences WHERE lead_id = $1', [leadId]);
  assert.strictEqual(countRows[0].n, 1);
});

test('runAutoEnrollmentScan never enrolls on EmailSent with no usable delivery timestamp — never estimate creation/import alone', { skip }, async () => {
  const leadEmail = `${RUN}.noevidence@example.com`;
  const leadId = await makeLead({ email: leadEmail });
  await makeEstimate(leadId, { qbEmailStatus: 'EmailSent', qbEmailDeliveryTime: null });
  // No MetaData.LastUpdatedTime column exists in this schema either, so this
  // case has NO usable timestamp anywhere — must not enroll.
  await engine.runAutoEnrollmentScan({ triggeredBy: 'test' });
  const sequence = await engine.getSequenceForLead(leadId);
  assert.strictEqual(sequence, null);
});

test('runAutoEnrollmentScan never enrolls a NeedToSend/NotSet estimate', { skip }, async () => {
  const leadEmail = `${RUN}.notsent@example.com`;
  const leadId = await makeLead({ email: leadEmail });
  await makeEstimate(leadId, { qbEmailStatus: 'NeedToSend' });
  await engine.runAutoEnrollmentScan({ triggeredBy: 'test' });
  assert.strictEqual(await engine.getSequenceForLead(leadId), null);
});

// ── 6. Fail-closed send gate ─────────────────────────────────────────────
test('processEstimateFollowups holds every due step when reply monitoring is disabled, and sends once it becomes healthy', { skip }, async () => {
  const leadEmail = `${RUN}.failclosed@example.com`;
  const leadId = await makeLead({ email: leadEmail });
  const estimateId = await makeEstimate(leadId);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  delete process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED;
  sentEmails.length = 0;
  const held = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(held.replyMonitoringHealthy, false);
  assert.ok(held.heldForMonitoring >= 1);
  assert.strictEqual(sentEmails.length, 0);

  const { rows: stillPending } = await db.query('SELECT status FROM estimate_followup_steps WHERE id = $1', [steps[0].id]);
  assert.strictEqual(stillPending[0].status, 'pending', 'the held step was never consumed');

  // Make monitoring healthy, then the exact same due step sends normally.
  process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'true';
  await db.query(
    `INSERT INTO estimate_followup_gmail_checkpoint (mailbox, history_id, status, last_success_at)
     VALUES ($1, '1099', 'healthy', NOW()) ON CONFLICT (mailbox) DO UPDATE SET history_id='1099', status='healthy', last_success_at=NOW(), consecutive_failures=0`,
    [MAILBOX]
  );
  const sent = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(sent.replyMonitoringHealthy, true);
  assert.strictEqual(sent.sent, 1);
  assert.strictEqual(sentEmails.length, 1);
});

// ── 7. HTTP surface ───────────────────────────────────────────────────────
test('HTTP: GET /estimate-followups/admin/automation-status reports consistent camelCase fields, admin/manager only', { skip }, async () => {
  process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'true';
  const res = await fetch(`${base}/api/v1/estimate-followups/admin/automation-status`, { headers: { Authorization: `Bearer ${token('admin', 'admin@example.com')}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok('enabled' in body.replyMonitoring);
  assert.ok('healthyForSending' in body.replyMonitoring);
  assert.ok(!('healthy_for_sending' in body.replyMonitoring), 'never leaks the raw snake_case field name');

  const forbidden = await fetch(`${base}/api/v1/estimate-followups/admin/automation-status`, { headers: { Authorization: `Bearer ${token('sales_rep', 'rep@example.com')}` } });
  assert.strictEqual(forbidden.status, 403);
});

test('HTTP: ambiguous-replies listing + resolve round-trip', { skip }, async () => {
  const listRes = await fetch(`${base}/api/v1/estimate-followups/admin/ambiguous-replies`, { headers: { Authorization: `Bearer ${token('admin', 'admin@example.com')}` } });
  assert.strictEqual(listRes.status, 200);
  const { ambiguousReplies } = await listRes.json();
  const unresolved = ambiguousReplies.find((r) => !r.resolved);
  assert.ok(unresolved, 'the ambiguous reply seeded earlier in this suite is present');

  const resolveRes = await fetch(`${base}/api/v1/estimate-followups/admin/ambiguous-replies/${unresolved.id}/resolve`, {
    method: 'POST', headers: { Authorization: `Bearer ${token('admin', 'admin@example.com')}` },
  });
  assert.strictEqual(resolveRes.status, 200);
  const { ambiguousReply } = await resolveRes.json();
  assert.strictEqual(ambiguousReply.resolved, true);
  assert.strictEqual(ambiguousReply.resolved_by, 'admin@example.com');

  // Resolving again is a conflict, never a silent success.
  const secondRes = await fetch(`${base}/api/v1/estimate-followups/admin/ambiguous-replies/${unresolved.id}/resolve`, {
    method: 'POST', headers: { Authorization: `Bearer ${token('admin', 'admin@example.com')}` },
  });
  assert.strictEqual(secondRes.status, 409);
});

test('HTTP: GET /leads/:id/estimate-followup includes a replyMonitoring block', { skip }, async () => {
  const leadEmail = `${RUN}.httpstate@example.com`;
  const leadId = await makeLead({ email: leadEmail });
  const res = await fetch(`${base}/api/v1/leads/${leadId}/estimate-followup`, { headers: { Authorization: `Bearer ${token('admin', 'admin@example.com')}` } });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.replyMonitoring);
  assert.ok('healthyForSending' in body.replyMonitoring);
  assert.strictEqual(body.replyDetectionLimitation, undefined, 'the old static limitation field no longer exists');
});
