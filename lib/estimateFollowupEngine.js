/* eslint-disable no-undef */
/**
 * estimateFollowupEngine — scheduling, processing, and lifecycle control
 * for the automated 14-day estimate follow-up email sequence.
 *
 * Design summary (see db/migrations/2026-70-estimate-followup-sequence.sql
 * for the schema this operates on):
 *
 *   - Enrollment (confirmEstimateSent / manualEnroll) is the ONLY way a
 *     sequence starts. There is no automatic/retroactive enrollment job —
 *     a lead becomes eligible (estimate Pending, lead not disqualified,
 *     etc.) but stays unenrolled until an authorized user explicitly
 *     confirms the estimate was sent. All 6 steps are pre-computed at
 *     enrollment time with fixed due_at timestamps.
 *
 *   - processEstimateFollowups() is the per-tick worker, called from
 *     reminderWorker.js on the SAME 15-minute cadence as the existing
 *     email/SMS/task reminder engines. For each active sequence with a
 *     due step: re-check eligibility FRESH (never trust the enrollment-
 *     time snapshot), collapse any backlog of multiple overdue steps down
 *     to the single most-recent one (never a catch-up flood), enforce at
 *     most one estimate-followup email per lead per calendar day, then
 *     send via the EXISTING lib/emailService.js (which already owns
 *     idempotency/retry/audit-logging — this module does not duplicate
 *     that, it only tracks per-step SCHEDULING state).
 *
 *   - ESTIMATE_FOLLOWUP_DRY_RUN defaults to 'true' (mirrors
 *     REMINDER_DRY_RUN's own safe-by-default precedent) — independent of
 *     every other reminder/SMS dry-run flag, per this codebase's "one flag
 *     per independent concern" doctrine. In dry-run, processEstimateFollowups
 *     computes and logs what WOULD happen but writes nothing and sends
 *     nothing. getDryRunEligibilityReport() is a SEPARATE, broader,
 *     always-read-only report (which leads would even qualify for
 *     enrollment, and why/why not) — it has no dry-run flag because it
 *     never sends regardless.
 *
 *   - Auto-stop (lead status -> Sold/Lost/DNQ/Cancelled, estimate no
 *     longer Pending, unsubscribe) is fully automatic, re-checked fresh
 *     before every send.
 *
 *   - UPDATED (November 2026, "REQUIRED CHANGE: Fully Automatic Estimate
 *     Detection and Customer Reply Tracking"): enrollment and reply-pause
 *     are now BOTH fully automatic by default, superseding the manual-only
 *     design above —
 *       - runAutoEnrollmentScan() (called from reminderWorker.js on the
 *         same tick) finds every Pending estimate QuickBooks itself
 *         confirms was emailed (lib/estimateSentDetection.js's
 *         EmailStatus='EmailSent' classifier — never estimate creation or
 *         import alone) and auto-enrolls via this same enroll() function,
 *         `method: 'auto_qb_email_status'`, `sentAt` = QuickBooks' own
 *         verified delivery instant. manualEnroll/confirmEstimateSent
 *         remain as explicit, human-triggered escape hatches for
 *         exceptional cases (per the explicit requirement that manual
 *         override controls may remain, just never be required).
 *       - lib/estimateFollowupReplyDetection.js polls Gmail (the SAME
 *         mailbox/OAuth grant already used for sending — no scope change)
 *         for inbound replies, correlates them to a sequence via Gmail
 *         thread id (preferred) or recipient address, and pauses the
 *         sequence automatically the moment a genuine reply is detected —
 *         no rep action required. This is now possible because
 *         gmail.readonly is ALREADY granted for this mailbox (confirmed:
 *         lib/gmailOAuthRouter.js's SCOPES already includes it, added for
 *         routes/leadEmails.js) — no OAuth change was needed.
 *       - processEstimateFollowups() below now checks
 *         replyDetection.isReplyMonitoringHealthy() BEFORE sending any real
 *         email on every tick — fail-closed: if reply monitoring is
 *         disabled, never polled, stale, or erroring, EVERY due step across
 *         EVERY sequence is held (not sent, not consumed, retried next
 *         tick) rather than risk sending a 7th/8th email into a thread the
 *         customer already replied to but this process can't currently
 *         see. This is a stricter, tick-wide gate — not merely
 *         per-affected-lead — per the explicit "fail closed... hold
 *         outgoing follow-up emails until reply monitoring is restored"
 *         requirement.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db/client');
const companyConfig = require('./companyConfig');
const reminderTime = require('./reminderTime');
const eligibility = require('./estimateFollowupEligibility');
const templates = require('./estimateFollowupTemplates');
const emailService = require('./emailService');
const crmUrl = require('./crmUrl');
const alerts = require('./estimateFollowupAlerts');
const estimateSentDetection = require('./estimateSentDetection');
const replyDetection = require('./estimateFollowupReplyDetection');

const MAX_STEP_ATTEMPTS = 5;

function isDryRunDefault() {
  return process.env.ESTIMATE_FOLLOWUP_DRY_RUN !== 'false'; // default true
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** { year, month, day, hour, minute } for `ms` in the given IANA zone. */
function localDateTimeParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(ms).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour, minute: Number(parts.minute) };
}

/** Clamp a local hour/minute into the 9:00 AM - 5:00 PM business window. */
function businessHourClamp(hour, minute) {
  if (hour < 9) return { hour: 9, minute: 0 };
  if (hour >= 17) return { hour: 16, minute: 30 };
  return { hour, minute };
}

/**
 * Compute the 6 fixed due_at timestamps from the verified sent instant,
 * calendar-day-correct and DST-safe (final conversion via
 * lib/reminderTime.js#pacificToUtcMs — the same function this codebase
 * already fixed a real DST bug in, reused rather than re-derived).
 */
function computeStepDueDates(sentAtMs, tz) {
  const sentParts = localDateTimeParts(sentAtMs, tz);
  const clamped = businessHourClamp(sentParts.hour, sentParts.minute);
  const timeStr = `${pad2(clamped.hour)}:${pad2(clamped.minute)}`;
  return templates.DEFAULT_SCHEDULE.map(({ stepNumber, dayOffset, templateKey }) => {
    const targetUtc = new Date(Date.UTC(sentParts.year, sentParts.month - 1, sentParts.day));
    targetUtc.setUTCDate(targetUtc.getUTCDate() + dayOffset);
    const dateStr = `${targetUtc.getUTCFullYear()}-${pad2(targetUtc.getUTCMonth() + 1)}-${pad2(targetUtc.getUTCDate())}`;
    const dueMs = reminderTime.pacificToUtcMs(dateStr, timeStr, tz);
    return { stepNumber, dayOffset, templateKey, dueAt: new Date(dueMs).toISOString() };
  });
}

/**
 * The unsubscribe token is deterministic — HMAC-SHA256 of the sequence's own
 * (app-generated, see enroll()) UUID, keyed by a server-only secret — rather
 * than a one-time random value. This is what lets `unsubscribeUrlFor()`
 * reconstruct the SAME working link on demand for every one of the 6 emails
 * (step 2-6 are rendered long after enroll() returned, when a one-time
 * random token generated back at enrollment would no longer be available
 * anywhere but the DB's hash of it, which is one-way by design). The HMAC
 * key makes the token unguessable even though the sequence id itself is a
 * UUID a recipient's own email headers/links will contain — without the
 * server secret, knowing the sequence id alone is not enough to forge a
 * valid unsubscribe token for it.
 */
function unsubscribeSecret() {
  const secret = process.env.RAILWAY_JWT_SECRET || process.env.PROXY_SECRET;
  if (!secret) {
    throw new Error('No server secret configured (RAILWAY_JWT_SECRET/PROXY_SECRET) — cannot generate a secure unsubscribe token');
  }
  return secret;
}

function unsubscribeTokenForSequence(sequenceId) {
  return crypto.createHmac('sha256', unsubscribeSecret()).update(String(sequenceId)).digest('base64url');
}

function hashUnsubscribeToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Enroll a lead into the sequence. The ONLY entry point that creates a
 * sequence — called by both the "Confirm Estimate Sent" action and the
 * "manually enroll an eligible lead" UI control (same underlying
 * operation; `method` only labels which button triggered it, for audit).
 * Re-validates eligibility itself — never trusts a caller's own check.
 *
 * `sentAt` defaults to the moment of this call. A caller may pass an
 * earlier ISO timestamp ONLY when they have genuine, specific knowledge
 * of when the estimate was actually sent (e.g. "I emailed it last
 * Tuesday") — this function never computes or guesses one itself.
 */
async function enroll({ leadId, handoffEstimateId, confirmedBy, sentAt, note, method }) {
  if (!confirmedBy) throw new Error('confirmedBy is required — every enrollment must be attributable to a real user');
  const sentAtMs = sentAt ? new Date(sentAt).getTime() : Date.now();
  if (!Number.isFinite(sentAtMs) || sentAtMs > Date.now() + 60000) {
    throw new Error('sentAt must be a valid, non-future timestamp');
  }

  const elig = await eligibility.checkEligibilityForEnrollment({ leadId, handoffEstimateId });
  if (!elig.eligible) {
    const err = new Error(`lead is not eligible for enrollment: ${elig.reasons.join(', ')}`);
    err.code = 'not_eligible';
    err.reasons = elig.reasons;
    throw err;
  }

  const tz = await companyConfig.getTimezone();
  const steps = computeStepDueDates(sentAtMs, tz);
  // The sequence id is generated here, in application code, rather than left
  // to the column's DEFAULT gen_random_uuid() — the deterministic unsubscribe
  // token (see unsubscribeTokenForSequence) is an HMAC of this id, so the id
  // must be known BEFORE the row is inserted.
  const sequenceId = crypto.randomUUID();
  const unsubscribeRaw = unsubscribeTokenForSequence(sequenceId);
  const unsubscribeHash = hashUnsubscribeToken(unsubscribeRaw);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: seqRows } = await client.query(
      `INSERT INTO estimate_followup_sequences
         (id, lead_id, handoff_estimate_id, recipient_email, sales_rep_owner_id,
          estimate_sent_confirmed_at, estimate_sent_confirmed_by, estimate_sent_confirmation_note,
          enrollment_method, unsubscribe_token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [sequenceId, leadId, handoffEstimateId, elig.lead.email, elig.lead.owner_id,
        new Date(sentAtMs).toISOString(), confirmedBy, note || null,
        ['manual_enroll', 'auto_qb_email_status', 'auto_post_appointment_sync'].includes(method) ? method : 'confirm_sent', unsubscribeHash]
    );
    const sequence = seqRows[0];

    for (const step of steps) {
      await client.query(
        `INSERT INTO estimate_followup_steps (sequence_id, step_number, day_offset, template_key, due_at, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sequence.id, step.stepNumber, step.dayOffset, step.templateKey, step.dueAt,
          `estimate-followup:${sequence.id}:${step.stepNumber}`]
      );
    }
    await client.query('COMMIT');
    return { sequence, unsubscribeToken: unsubscribeRaw };
  } catch (e) {
    await client.query('ROLLBACK');
    // A concurrent enrollment attempt for the same lead races the partial
    // unique index (estimate_followup_sequences_one_live_per_lead) —
    // surface it as the same "competing sequence" eligibility failure
    // rather than a raw constraint-violation message.
    if (e && e.code === '23505') {
      const err = new Error('lead is not eligible for enrollment: competing_sequence_already_active');
      err.code = 'not_eligible';
      err.reasons = ['competing_sequence_already_active'];
      throw err;
    }
    throw e;
  } finally {
    client.release();
  }
}

async function manualEnroll(args) {
  return enroll({ ...args, method: 'manual_enroll' });
}
async function confirmEstimateSent(args) {
  return enroll({ ...args, method: 'confirm_sent' });
}

/**
 * The fully-automatic enrollment path. Scans every Pending, lead-linked
 * handoff_estimates row for QuickBooks' own confirmed-sent evidence
 * (EmailStatus='EmailSent' — lib/estimateSentDetection.js's classifier;
 * never estimate creation/import alone) and enrolls each one that isn't
 * already enrolled, via the SAME enroll() function every other enrollment
 * path uses — `sentAt` is QuickBooks' own verified delivery instant, never
 * the scan's own run time. Called from reminderWorker.js on the same tick
 * as processEstimateFollowups(); re-checks eligibility itself (via
 * enroll() -> checkEligibilityForEnrollment) so a lead that is otherwise
 * disqualified (Sold/Lost/no valid email/suppressed/a competing sequence
 * already active) is correctly skipped, never force-enrolled.
 */
async function runAutoEnrollmentScan({ triggeredBy = 'cron' } = {}) {
  const { rows: estimates } = await db.query(
    `SELECT id AS estimate_id, lead_id, qb_email_status, qb_email_delivery_time
       FROM handoff_estimates
      WHERE estimate_status = 'Pending' AND lead_id IS NOT NULL AND qb_email_status = 'EmailSent'`
  );

  const summary = { scanned: estimates.length, enrolled: 0, alreadyEnrolled: 0, notEligible: 0, noUsableTimestamp: 0, errors: [] };

  for (const est of estimates) {
    try {
      // No MetaData.LastUpdatedTime fallback here: this codebase only
      // persists qb_email_status/qb_email_delivery_time (the two columns
      // migration 2026-71 actually added) — NOT a copy of QuickBooks'
      // MetaData block. If EmailSent carries no delivery timestamp, this
      // classifies as not-yet-confirmed rather than inventing a "sent at"
      // from this row's own last_synced_at (OUR sync time, never a
      // QuickBooks-reported instant — the classifier's own header is
      // explicit that it must never backdate further than what QuickBooks
      // itself reports). A future sync tick that populates DeliveryTime
      // picks this estimate up automatically; manual enrollment remains
      // available as an escape hatch in the meantime.
      const evidence = estimateSentDetection.classifyQbSentEvidence({
        EmailStatus: est.qb_email_status,
        DeliveryInfo: { DeliveryTime: est.qb_email_delivery_time },
      });
      if (!evidence.confirmed) {
        summary.noUsableTimestamp++;
        continue;
      }

      try {
        await enroll({
          leadId: est.lead_id,
          handoffEstimateId: est.estimate_id,
          confirmedBy: 'system:auto_qb_email_status',
          sentAt: evidence.sentAt,
          method: 'auto_qb_email_status',
          note: `Automatically enrolled — QuickBooks EmailStatus=EmailSent (evidence: ${evidence.evidence})`,
        });
        summary.enrolled++;
      } catch (e) {
        if (e && e.code === 'not_eligible') {
          if (e.reasons.includes('competing_sequence_already_active')) summary.alreadyEnrolled++;
          else summary.notEligible++;
        } else {
          throw e;
        }
      }
    } catch (e) {
      summary.errors.push(`estimate ${est.estimate_id}: ${e.message}`);
    }
  }

  console.log(JSON.stringify({ event: 'ESTIMATE_FOLLOWUP_AUTO_ENROLLMENT_TICK', triggeredBy, ...summary }));
  return { ok: true, triggeredBy, ...summary };
}

async function getSequenceForLead(leadId) {
  const { rows } = await db.query(
    `SELECT * FROM estimate_followup_sequences WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  );
  return rows[0] || null;
}

async function getStepsForSequence(sequenceId) {
  const { rows } = await db.query(
    `SELECT * FROM estimate_followup_steps WHERE sequence_id = $1 ORDER BY step_number ASC`,
    [sequenceId]
  );
  return rows;
}

async function pauseSequence({ sequenceId, reason, pausedBy }) {
  const { rows } = await db.query(
    `UPDATE estimate_followup_sequences SET status='paused', paused_reason=$2, paused_at=NOW(), paused_by=$3
       WHERE id=$1 AND status='active' RETURNING *`,
    [sequenceId, reason || null, pausedBy || null]
  );
  if (!rows.length) throw new Error('sequence not found or not active');
  return rows[0];
}

async function resumeSequence({ sequenceId, resumedBy }) {
  const { rows } = await db.query(
    `UPDATE estimate_followup_sequences SET status='active', paused_reason=NULL, paused_at=NULL, paused_by=NULL
       WHERE id=$1 AND status='paused' RETURNING *`,
    [sequenceId]
  );
  if (!rows.length) throw new Error('sequence not found or not paused');
  void resumedBy; // resumption itself isn't stored per-field; captured in activity log by the route layer
  return rows[0];
}

async function stopSequence({ sequenceId, reason, stoppedBy }) {
  const { rows } = await db.query(
    `UPDATE estimate_followup_sequences SET status='stopped', stopped_reason=$2, stopped_at=NOW(), stopped_by=$3
       WHERE id=$1 AND status IN ('active','paused') RETURNING *`,
    [sequenceId, reason || 'manual_stop', stoppedBy || null]
  );
  if (!rows.length) return null; // already terminal — stopping twice is a no-op, not an error
  await db.query(
    `UPDATE estimate_followup_steps SET status='cancelled' WHERE sequence_id=$1 AND status IN ('pending','processing')`,
    [sequenceId]
  );
  return rows[0];
}

/** Called from routes/leads.js's terminal-lost-status transition hook. */
async function stopActiveSequencesForLead(leadId, reason) {
  const { rows } = await db.query(
    `SELECT id FROM estimate_followup_sequences WHERE lead_id = $1 AND status IN ('active','paused')`,
    [leadId]
  );
  for (const row of rows) {
    await stopSequence({ sequenceId: row.id, reason, stoppedBy: 'system:lead_status_change' });
  }
  return rows.length;
}

async function unsubscribeByToken(rawToken) {
  const hash = hashUnsubscribeToken(rawToken);
  const { rows } = await db.query(
    `SELECT * FROM estimate_followup_sequences WHERE unsubscribe_token_hash = $1`,
    [hash]
  );
  const sequence = rows[0];
  if (!sequence) return { ok: false, reason: 'invalid_token' };

  await db.query(
    `INSERT INTO estimate_followup_suppressions (email, reason, source, sequence_id)
     VALUES ($1, 'customer_unsubscribe_link', 'customer_unsubscribe', $2)
     ON CONFLICT (email) DO NOTHING`,
    [String(sequence.recipient_email).toLowerCase(), sequence.id]
  );
  if (sequence.status === 'active' || sequence.status === 'paused') {
    await stopSequence({ sequenceId: sequence.id, reason: 'customer_unsubscribed', stoppedBy: 'system:unsubscribe_link' });
  }
  return { ok: true, email: sequence.recipient_email };
}

async function hasSentToLeadToday(leadId, tz) {
  const nowParts = localDateTimeParts(Date.now(), tz);
  const dateStr = `${nowParts.year}-${pad2(nowParts.month)}-${pad2(nowParts.day)}`;
  const startOfDayMs = reminderTime.pacificToUtcMs(dateStr, '00:00', tz);
  const { rows } = await db.query(
    `SELECT 1 FROM estimate_followup_steps s
       JOIN estimate_followup_sequences seq ON seq.id = s.sequence_id
      WHERE seq.lead_id = $1 AND s.status = 'sent' AND s.sent_at >= $2
      LIMIT 1`,
    [leadId, new Date(startOfDayMs).toISOString()]
  );
  return rows.length > 0;
}

async function getDueSteps(sequenceId) {
  const { rows } = await db.query(
    `SELECT * FROM estimate_followup_steps
       WHERE sequence_id = $1 AND status = 'pending' AND due_at <= NOW()
       ORDER BY step_number DESC`,
    [sequenceId]
  );
  return rows;
}

async function maybeCompleteSequence(sequenceId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM estimate_followup_steps WHERE sequence_id = $1 AND status IN ('pending','processing')`,
    [sequenceId]
  );
  if (rows[0].n === 0) {
    await db.query(
      `UPDATE estimate_followup_sequences SET status='completed', completed_at=NOW() WHERE id=$1 AND status='active'`,
      [sequenceId]
    );
  }
}

/**
 * Builds the unsubscribe link for a sequence. Since the token is a
 * deterministic HMAC of the sequence id (see unsubscribeTokenForSequence),
 * this can be called at any time — enrollment, step 2, step 6 — and always
 * reconstructs the exact same, already-valid token with no DB lookup and no
 * dependency on a one-time value captured elsewhere. The public unsubscribe
 * route (routes/estimateFollowups.js) hashes the incoming token and matches
 * it against the stored unsubscribe_token_hash.
 */
function unsubscribeUrlFor(sequenceId) {
  const token = unsubscribeTokenForSequence(sequenceId);
  return `${crmUrl.getCrmBaseUrl()}/api/v1/estimate-followups/public/unsubscribe/${encodeURIComponent(token)}`;
}

/**
 * Process every active sequence with at least one currently-due step.
 * Dry-run: computes and logs, writes nothing, sends nothing.
 */
async function processEstimateFollowups({ dryRun, triggeredBy = 'cron' } = {}) {
  const effectiveDryRun = dryRun != null ? dryRun : isDryRunDefault();
  const tz = await companyConfig.getTimezone();
  const { rows: sequences } = await db.query(
    `SELECT DISTINCT seq.* FROM estimate_followup_sequences seq
       JOIN estimate_followup_steps st ON st.sequence_id = seq.id
      WHERE seq.status = 'active' AND st.status = 'pending' AND st.due_at <= NOW()`
  );

  // Fail-closed reply-monitoring gate (checked ONCE per tick, not re-checked
  // per sequence — a single tick-wide snapshot is correct here since the
  // whole point is "don't send anything this tick unless monitoring is
  // actually healthy right now"). Computed regardless of dryRun so a
  // dry-run report accurately reflects what the real gate would do once
  // live — see heldForMonitoring below.
  const monitoringHealth = await replyDetection.isReplyMonitoringHealthy();

  const summary = {
    total: sequences.length, sent: 0, wouldSend: 0, stopped: 0, deferredOnePerDay: 0,
    heldForMonitoring: 0, failed: 0, configBlocked: false,
    replyMonitoringHealthy: monitoringHealth.healthy, replyMonitoringReason: monitoringHealth.reason,
    errors: [],
  };

  for (const sequence of sequences) {
    try {
      const elig = await eligibility.checkEligibilityForSend(sequence);
      if (!elig.eligible) {
        if (!effectiveDryRun) await stopSequence({ sequenceId: sequence.id, reason: elig.reason, stoppedBy: 'system:auto' });
        summary.stopped++;
        continue;
      }

      const dueSteps = await getDueSteps(sequence.id);
      if (dueSteps.length === 0) continue;
      const [toSend, ...toSkip] = dueSteps;

      if (!effectiveDryRun) {
        for (const skip of toSkip) {
          await db.query(
            `UPDATE estimate_followup_steps SET status='skipped', skipped_reason='superseded_by_later_step' WHERE id=$1 AND status='pending'`,
            [skip.id]
          );
        }
      }

      if (await hasSentToLeadToday(sequence.lead_id, tz)) {
        summary.deferredOnePerDay++;
        continue;
      }

      // Fail-closed reply-monitoring gate — checked for EVERY due step,
      // dry-run included (so the dry-run report reflects reality), before
      // ever counting a step as send-worthy. The step stays 'pending' —
      // never consumed, never marked processing — so it is retried on the
      // very next tick once monitoring recovers; this is a HOLD, not a
      // skip/failure.
      if (!monitoringHealth.healthy) {
        summary.heldForMonitoring++;
        console.log(JSON.stringify({
          event: 'ESTIMATE_FOLLOWUP_HELD_REPLY_MONITORING_UNHEALTHY',
          sequenceId: sequence.id, leadId: sequence.lead_id, step: toSend.step_number,
          reason: monitoringHealth.reason, dryRun: effectiveDryRun,
        }));
        continue;
      }

      if (effectiveDryRun) {
        summary.wouldSend++;
        console.log(JSON.stringify({ event: 'ESTIMATE_FOLLOWUP_DRY_RUN', sequenceId: sequence.id, leadId: sequence.lead_id, step: toSend.step_number, templateKey: toSend.template_key }));
        continue;
      }

      const claim = await db.query(
        `UPDATE estimate_followup_steps SET status='processing', attempts=attempts+1 WHERE id=$1 AND status='pending' RETURNING *`,
        [toSend.id]
      );
      if (!claim.rows.length) continue; // lost the race to another process/replica — fine, it'll pick it up

      const { rows: repRows } = sequence.sales_rep_owner_id
        ? await db.query(`SELECT display_name FROM owners WHERE id = $1`, [sequence.sales_rep_owner_id])
        : { rows: [] };
      const salesRepName = (repRows[0] && repRows[0].display_name) || null;

      try {
        const rendered = await templates.renderEmailForStep({
          templateKey: toSend.template_key,
          firstName: elig.lead.first_name,
          salesRepName,
          unsubscribeUrl: unsubscribeUrlFor(sequence.id),
        });
        const result = await emailService.send({
          to: elig.lead.email,
          subject: rendered.subject,
          htmlBody: rendered.html,
          idempotencyKey: `estimate-followup:${sequence.id}:${toSend.step_number}`,
          role: 'estimate_followup',
        });
        await db.query(
          `UPDATE estimate_followup_steps SET status='sent', sent_at=NOW(), gmail_message_id=$2, gmail_thread_id=$3 WHERE id=$1`,
          [toSend.id, result.gmailMessageId || null, result.threadId || null]
        );
        await maybeCompleteSequence(sequence.id);
        summary.sent++;
      } catch (sendErr) {
        if (sendErr instanceof templates.ConfigurationError) {
          // Not this lead's fault — every send is doomed identically until
          // an operator fixes Company Settings. Release the claim without
          // burning an attempt and stop the whole tick rather than
          // repeating the same failure for every other sequence too.
          await db.query(`UPDATE estimate_followup_steps SET status='pending' WHERE id=$1`, [toSend.id]);
          summary.configBlocked = true;
          summary.errors.push(`config: ${sendErr.message}`);
          break;
        }
        const attemptsNow = toSend.attempts + 1;
        const terminal = attemptsNow >= MAX_STEP_ATTEMPTS;
        await db.query(
          `UPDATE estimate_followup_steps SET status=$2, last_error=$3 WHERE id=$1`,
          [toSend.id, terminal ? 'failed' : 'pending', String(sendErr.message || sendErr).slice(0, 500)]
        );
        if (terminal) summary.failed++;
        summary.errors.push(`lead ${sequence.lead_id} step ${toSend.step_number}: ${sendErr.message}`);
      }
    } catch (seqErr) {
      summary.errors.push(`sequence ${sequence.id}: ${seqErr.message}`);
    }
    if (summary.configBlocked) break;
  }

  console.log(JSON.stringify({ event: 'ESTIMATE_FOLLOWUP_TICK', dryRun: effectiveDryRun, triggeredBy, ...summary }));

  if (!effectiveDryRun && (summary.failed > 0 || summary.configBlocked)) {
    try { await alerts.notifyAutomationFailures(summary); } catch (e) { console.warn('[estimate-followup] failure alert itself failed:', e.message); }
  }

  return { ok: true, dryRun: effectiveDryRun, triggeredBy, ...summary };
}

/**
 * Broad, always-read-only report: every lead with a Pending estimate,
 * classified as already_enrolled / eligible_awaiting_sent_confirmation /
 * not_eligible (+ exact reasons). Satisfies "show which leads would
 * qualify, without sending any emails" — this never writes, regardless of
 * ESTIMATE_FOLLOWUP_DRY_RUN.
 */
async function getDryRunEligibilityReport() {
  const { rows: estimates } = await db.query(
    `SELECT id AS estimate_id, lead_id, estimate_status, qb_estimate_number
       FROM handoff_estimates WHERE estimate_status = 'Pending' AND lead_id IS NOT NULL`
  );

  const leads = [];
  for (const est of estimates) {
    const { rows: seqRows } = await db.query(
      `SELECT id, status FROM estimate_followup_sequences
         WHERE lead_id = $1 AND handoff_estimate_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [est.lead_id, est.estimate_id]
    );
    if (seqRows.length) {
      leads.push({ lead_id: est.lead_id, estimate_id: est.estimate_id, qb_estimate_number: est.qb_estimate_number, state: 'already_enrolled', sequence_status: seqRows[0].status });
      continue;
    }
    const elig = await eligibility.checkEligibilityForEnrollment({ leadId: est.lead_id, handoffEstimateId: est.estimate_id });
    leads.push({
      lead_id: est.lead_id,
      estimate_id: est.estimate_id,
      qb_estimate_number: est.qb_estimate_number,
      state: elig.eligible ? 'eligible_awaiting_sent_confirmation' : 'not_eligible',
      reasons: elig.eligible ? [] : elig.reasons,
    });
  }

  const byState = leads.reduce((acc, l) => { acc[l.state] = (acc[l.state] || 0) + 1; return acc; }, {});
  return { generated_at: new Date().toISOString(), total: leads.length, by_state: byState, leads };
}

module.exports = {
  MAX_STEP_ATTEMPTS,
  computeStepDueDates,
  businessHourClamp,
  enroll,
  manualEnroll,
  confirmEstimateSent,
  getSequenceForLead,
  getStepsForSequence,
  pauseSequence,
  resumeSequence,
  stopSequence,
  stopActiveSequencesForLead,
  unsubscribeByToken,
  unsubscribeUrlFor,
  unsubscribeTokenForSequence,
  hashUnsubscribeToken,
  processEstimateFollowups,
  getDryRunEligibilityReport,
  runAutoEnrollmentScan,
};
