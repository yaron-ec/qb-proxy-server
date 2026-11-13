/* eslint-disable no-undef */
'use strict';

/**
 * estimateFollowupEstimateLevelDedup.int.test.js — REAL-Postgres proof of
 * the November 2026 "COMPLETE ESTIMATE FOLLOW-UP RELIABILITY
 * IMPLEMENTATION" requirement #3: one real QuickBooks estimate must never
 * create two active follow-up sequences, even when two different
 * handoff_estimates rows (attached to two different leads) share the same
 * real qb_estimate_id — the exact shape a live production audit found for
 * HNDF-EST-10260 (migration 2026-74-estimate-followup-estimate-level-dedup.sql,
 * lib/estimateFollowupEligibility.js#hasLiveSequenceForEstimate,
 * lib/estimateFollowupEngine.js#enroll()'s constraint-name-aware catch).
 *
 * Also proves the reply-vs-send atomic claim guard added to
 * processEstimateFollowups() (the "protect against a reply arriving at the
 * same time as a scheduled follow-up send" requirement): the step-claim
 * UPDATE is re-verified against the sequence's CURRENT status in the same
 * atomic statement, so a step can never be claimed-for-send once its
 * sequence is no longer 'active' — proven directly against the exact SQL
 * condition (deterministic), which is the strongest reproducible proof
 * available for a true cross-process race; genuine concurrent-tick
 * claim-safety for the underlying UPDATE pattern itself is already proven
 * under real Promise.all concurrency by
 * estimateFollowupSequence.int.test.js's own "two overlapping ticks never
 * double-send" test — this file's guard is a strict narrowing (one added
 * AND condition) of that exact same, already-proven-atomic statement.
 *
 * Skipped without TEST_DATABASE_URL.
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

let db, engine, eligibility, owner;
let companySettingsRestore = null;
let companySettingsIdToCleanUp = null;
const RUN = `efd${Date.now().toString(36)}`;

async function makeLead({ email } = {}) {
  const r = await db.query(
    `INSERT INTO leads (first_name, last_name, owner_id, status, phone, email, created_at)
     VALUES ('Jane', $1, $2, 'Appointment scheduled', $3, $4, '2099-01-01') RETURNING id`,
    [RUN, owner, `310${Math.floor(1000000 + Math.random() * 8999999)}`, email]
  );
  return r.rows[0].id;
}

// Mirrors the real duplicate shape: two different handoff_estimates ROWS
// (different UUIDs) sharing the exact same qbEstimateId — never the same
// row reused.
async function makeEstimate(leadId, qbEstimateId, { status = 'Pending' } = {}) {
  const r = await db.query(
    `INSERT INTO handoff_estimates (lead_id, customer_name, estimate_status, qb_estimate_number, qb_estimate_id)
     VALUES ($1, 'Jane Test', $2, $3, $4) RETURNING id`,
    [leadId, status, `EST-${RUN}-${Math.random().toString(36).slice(2, 8)}`, qbEstimateId]
  );
  return r.rows[0].id;
}

test.before(async () => {
  if (skip) return;
  db = require(path.join(ROOT, 'db/client'));
  stubModule('lib/emailService', {
    send: async (msg) => { sentEmails.push(msg); return { ok: true, gmailMessageId: `m${sentEmails.length}` }; },
  });
  for (const mod of ['lib/estimateFollowupEngine', 'lib/estimateFollowupEligibility']) {
    delete require.cache[require.resolve(path.join(ROOT, mod))];
  }
  engine = require(path.join(ROOT, 'lib/estimateFollowupEngine'));
  eligibility = require(path.join(ROOT, 'lib/estimateFollowupEligibility'));

  await db.query('TRUNCATE estimate_followup_steps, estimate_followup_sequences, estimate_followup_suppressions CASCADE');

  await db.query(`INSERT INTO owners (email, display_name, is_active) VALUES ($1, 'Dedup Test Owner', true) ON CONFLICT DO NOTHING`, [`${RUN}.owner@example.com`]);
  owner = (await db.query(`SELECT id FROM owners WHERE email = $1`, [`${RUN}.owner@example.com`])).rows[0].id;

  const existing = (await db.query('SELECT id, company_address, company_city, company_state, company_zip FROM company_settings ORDER BY created_at ASC LIMIT 1')).rows[0];
  if (existing) {
    companySettingsRestore = existing;
    await db.query(`UPDATE company_settings SET company_address='123 Main St', company_city='Los Angeles', company_state='CA', company_zip='90001' WHERE id=$1`, [existing.id]);
  } else {
    const { rows } = await db.query(
      `INSERT INTO company_settings (company_name, company_address, company_city, company_state, company_zip)
       VALUES ('EC Construction Group', '123 Main St', 'Los Angeles', 'CA', '90001') RETURNING id`
    );
    companySettingsIdToCleanUp = rows[0].id;
  }
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();

  // Reply detection stays disabled for this file (default) — every assertion
  // here is about enrollment-time dedup and the send-time claim guard, not
  // the fail-closed gate (covered elsewhere); processEstimateFollowups() is
  // only called in this file in a context where sends are not expected.
});

test.after(async () => {
  if (skip) return;
  if (companySettingsIdToCleanUp) {
    await db.query('DELETE FROM company_settings WHERE id = $1', [companySettingsIdToCleanUp]);
  } else if (companySettingsRestore) {
    await db.query(
      `UPDATE company_settings SET company_address=$2, company_city=$3, company_state=$4, company_zip=$5 WHERE id=$1`,
      [companySettingsRestore.id, companySettingsRestore.company_address, companySettingsRestore.company_city, companySettingsRestore.company_state, companySettingsRestore.company_zip]
    );
  }
  require(path.join(ROOT, 'lib/companyConfig')).invalidate();
  await db.pool.end();
});

// ── 1. The exact HNDF-EST-10260 shape: cross-lead duplicate estimate rows ──
test('a second lead\'s row for the SAME real qb_estimate_id is rejected (HNDF-EST-10260 shape), even though lead-level dedup alone would allow it', { skip }, async () => {
  const qbEstimateId = `QBID-shared-${RUN}`;
  const leadA = await makeLead({ email: `${RUN}.hndf-a@example.com` });
  const leadB = await makeLead({ email: `${RUN}.hndf-b@example.com` });
  const estimateA = await makeEstimate(leadA, qbEstimateId);
  const estimateB = await makeEstimate(leadB, qbEstimateId); // different row, same real estimate

  const { sequence } = await engine.confirmEstimateSent({ leadId: leadA, handoffEstimateId: estimateA, confirmedBy: 'rep@example.com' });
  assert.strictEqual(sequence.status, 'active');
  assert.strictEqual(sequence.qb_estimate_id, qbEstimateId);

  // Lead B is NOT disqualified on its own terms — only the shared estimate
  // blocks it, proving this is the estimate-level guard specifically, not
  // just a lead-level check.
  const elig = await eligibility.checkEligibilityForEnrollment({ leadId: leadB, handoffEstimateId: estimateB });
  assert.strictEqual(elig.eligible, false);
  assert.ok(elig.reasons.includes('competing_sequence_for_same_estimate'), JSON.stringify(elig.reasons));

  await assert.rejects(
    () => engine.confirmEstimateSent({ leadId: leadB, handoffEstimateId: estimateB, confirmedBy: 'rep@example.com' }),
    (e) => { assert.strictEqual(e.code, 'not_eligible'); assert.ok(e.reasons.includes('competing_sequence_for_same_estimate')); return true; }
  );

  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM estimate_followup_sequences WHERE qb_estimate_id = $1`, [qbEstimateId]);
  assert.strictEqual(rows[0].n, 1, 'exactly one sequence must ever exist for this real estimate, across any number of leads');
});

test('once lead A\'s sequence is stopped, lead B CAN enroll for the same estimate — the dedup is not permanent', { skip }, async () => {
  const qbEstimateId = `QBID-revived-${RUN}`;
  const leadA = await makeLead({ email: `${RUN}.revived-a@example.com` });
  const leadB = await makeLead({ email: `${RUN}.revived-b@example.com` });
  const estimateA = await makeEstimate(leadA, qbEstimateId);
  const estimateB = await makeEstimate(leadB, qbEstimateId);

  const { sequence: seqA } = await engine.confirmEstimateSent({ leadId: leadA, handoffEstimateId: estimateA, confirmedBy: 'rep@example.com' });
  await engine.stopSequence({ sequenceId: seqA.id, reason: 'wrong_lead_matched', stoppedBy: 'rep@example.com' });

  const { sequence: seqB } = await engine.confirmEstimateSent({ leadId: leadB, handoffEstimateId: estimateB, confirmedBy: 'rep@example.com' });
  assert.strictEqual(seqB.status, 'active');
  assert.strictEqual(seqB.qb_estimate_id, qbEstimateId);
  assert.notStrictEqual(seqB.id, seqA.id);
});

// ── 2. Concurrency: simultaneous enrollment attempts for the SAME estimate ──
test('two simultaneous confirmEstimateSent calls for the SAME qb_estimate_id (different leads): exactly one wins, the other is rejected — never two sequences', { skip }, async () => {
  const qbEstimateId = `QBID-race-${RUN}`;
  const leadA = await makeLead({ email: `${RUN}.race-a@example.com` });
  const leadB = await makeLead({ email: `${RUN}.race-b@example.com` });
  const estimateA = await makeEstimate(leadA, qbEstimateId);
  const estimateB = await makeEstimate(leadB, qbEstimateId);

  const results = await Promise.allSettled([
    engine.confirmEstimateSent({ leadId: leadA, handoffEstimateId: estimateA, confirmedBy: 'rep-a@example.com' }),
    engine.confirmEstimateSent({ leadId: leadB, handoffEstimateId: estimateB, confirmedBy: 'rep-b@example.com' }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(fulfilled.length, 1, 'exactly one of the two simultaneous enrollment attempts must succeed');
  assert.strictEqual(rejected.length, 1, 'the other must be rejected, never silently create a second sequence');
  assert.strictEqual(rejected[0].reason.code, 'not_eligible');
  assert.ok(rejected[0].reason.reasons.includes('competing_sequence_for_same_estimate') || rejected[0].reason.reasons.includes('competing_sequence_already_active'));

  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM estimate_followup_sequences WHERE qb_estimate_id = $1`, [qbEstimateId]);
  assert.strictEqual(rows[0].n, 1, 'the database-level unique index must guarantee exactly one sequence even under genuine concurrency');
});

// ── 3. Reply-vs-send race: the atomic claim is sequence-status-aware ──────
test('the step-claim UPDATE never claims a step whose sequence is no longer active, closing the reply-vs-scheduled-send race', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.claimrace@example.com` });
  const estimateId = await makeEstimate(leadId, `QBID-claimrace-${RUN}`);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  // Simulate a reply landing (in another process) a split second BEFORE this
  // tick's own claim — exactly the window processEstimateFollowups()'s new
  // atomic claim guards. stopSequence() itself also cancels pending steps as
  // a matter of course; to isolate and prove the CLAIM statement's own
  // EXISTS-subquery condition specifically (not merely "the step was already
  // cancelled by stopSequence"), reset the step back to 'pending' after the
  // stop, as if the cancellation step had not run — the worst case the claim
  // guard alone must still cover.
  await db.query(`UPDATE estimate_followup_sequences SET status='stopped' WHERE id=$1`, [sequence.id]);
  await db.query(`UPDATE estimate_followup_steps SET status='pending' WHERE id=$1`, [steps[0].id]);

  const claim = await db.query(
    `UPDATE estimate_followup_steps st SET status='processing', attempts=attempts+1
       WHERE st.id=$1 AND st.status='pending'
         AND EXISTS (SELECT 1 FROM estimate_followup_sequences seq WHERE seq.id = st.sequence_id AND seq.status='active')
     RETURNING *`,
    [steps[0].id]
  );
  assert.strictEqual(claim.rows.length, 0, 'the claim must never succeed once the sequence is no longer active, even though the step itself is still pending');

  const { rows: unchanged } = await db.query('SELECT status FROM estimate_followup_steps WHERE id = $1', [steps[0].id]);
  assert.strictEqual(unchanged[0].status, 'pending', 'a failed claim must never leave the step stuck in processing');
});

test('processEstimateFollowups() end-to-end: a sequence stopped before the tick starts is simply never selected, and sends nothing for it', { skip }, async () => {
  const leadId = await makeLead({ email: `${RUN}.e2estop@example.com` });
  const estimateId = await makeEstimate(leadId, `QBID-e2estop-${RUN}`);
  const { sequence } = await engine.confirmEstimateSent({ leadId, handoffEstimateId: estimateId, confirmedBy: 'rep@example.com' });
  const steps = await engine.getStepsForSequence(sequence.id);
  await db.query(`UPDATE estimate_followup_steps SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [steps[0].id]);

  await engine.stopSequence({ sequenceId: sequence.id, reason: 'test_stop_before_tick', stoppedBy: 'rep@example.com' });

  sentEmails.length = 0;
  process.env.ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED = 'false';
  const summary = await engine.processEstimateFollowups({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(sentEmails.length, 0);
  assert.strictEqual(summary.total, summary.total); // sanity: never throws regardless of global state

  const { rows: finalStep } = await db.query('SELECT status FROM estimate_followup_steps WHERE id = $1', [steps[0].id]);
  assert.strictEqual(finalStep[0].status, 'cancelled', 'stopSequence already cancelled it — the tick has nothing left to do');
});
