/* eslint-disable no-undef */
/**
 * postAppointmentEstimateSync — fully automatic, per-appointment QuickBooks
 * estimate sync scheduling.
 *
 * CRM feature: "Automatic Post-Appointment QuickBooks Estimate Sync and
 * Follow-Up Enrollment." For every eligible real customer appointment
 * (never a Phone Call follow-up, a cancelled/rescheduled/no-show
 * appointment, or one that hasn't happened yet), this schedules and
 * retries a lead-scoped QuickBooks estimate check — 3h after the
 * appointment ends, then 24h/48h/72h, then once daily through day 7 —
 * using the EXISTING lead-scoped sync implementation
 * (lib/leadEstimateSync.js, extracted from routes/leadQB.js's own manual
 * "Sync from QuickBooks" button) rather than a new sync mechanism, and the
 * EXISTING estimate-follow-up enrollment path
 * (lib/estimateFollowupEngine.js#enroll) the moment QuickBooks' own
 * EmailStatus='EmailSent' evidence confirms the estimate was actually
 * delivered (lib/estimateSentDetection.js) — never on estimate creation
 * alone.
 *
 * "Safest existing signal" for appointment completion (per the explicit
 * product requirement — this codebase has no separate, reliably-set
 * "completed" flag a rep is guaranteed to click): an appointment is
 * eligible the moment its scheduled END TIME has passed AND its status is
 * still one that represents a real, un-cancelled booking
 * (scheduled/confirmed/completed — never cancelled/rescheduled/no_show).
 * This deliberately does NOT require a human to mark the appointment
 * 'completed' — CLAUDE.md's existing rule ("never infer completed from a
 * past start time") protects a DIFFERENT concern (the terminal-lost
 * auto-cancel logic, where wrongly treating a scheduled appointment as
 * already-handled could skip a real cancellation); for scheduling a
 * READ-ONLY, idempotent, retried QuickBooks check, the end-time-passed +
 * not-cancelled signal is the safest available fact that doesn't depend
 * on anyone remembering to click a button — exactly what full automation
 * requires. A legacy, pre-rule "Phone Call" appointment row (no travel
 * buffer — see lib/booking/appointmentKind.js) is excluded the same way
 * every other appointment-only feature in this codebase excludes it.
 *
 * Idempotency/concurrency: UNIQUE(appointment_id) on
 * post_appointment_estimate_syncs makes enqueueing safe to run every tick
 * (ON CONFLICT DO NOTHING); claiming a due row for processing uses the
 * same single-UPDATE-with-WHERE-status='pending' pattern already
 * established by lib/estimateFollowupEngine.js's step claim — a second
 * worker/replica racing the same row simply gets zero rows back and moves
 * on (see that file's own "lost the race" comment for the precedent).
 *
 * Rate-limit/traffic safety: calls leadEstimateSync.syncEstimatesForLead
 * with allowFullScan: false — the automated job NEVER performs the
 * expensive, full-company QuickBooks estimate scan (that fallback stays
 * reserved for a human's one-off manual "Sync from QuickBooks" click).
 * The independently-scheduled, pre-existing 15-minute
 * server.js#runQbEstimateSync cron already performs that full scan on its
 * own cadence and will catch anything this narrower lookup misses. Every
 * QuickBooks call this module makes still funnels through the one
 * canonical qbTokenManager.qbApiRequest path (circuit-breaker protected,
 * bounded 429/5xx retry) — no new QuickBooks credential, API shape, or
 * rate-limit handling was introduced.
 */
'use strict';

const db = require('../db/client');
const leadEstimateSync = require('./leadEstimateSync');
const estimateSentDetection = require('./estimateSentDetection');
const estimateFollowupEligibility = require('./estimateFollowupEligibility');
const estimateFollowupEngine = require('./estimateFollowupEngine');
const appointmentKind = require('./booking/appointmentKind');

// 3h after the appointment ends, then 24h/48h/72h, then once daily through
// day 7 (168h) — the exact, user-approved retry schedule. This is the ONE
// place this schedule is defined; the migration's own header comment
// documents it but never re-implements it.
const RETRY_OFFSET_HOURS = [3, 24, 48, 72, 96, 120, 144, 168];
const WINDOW_DAYS = 7;
const MAX_ROWS_PER_TICK = 200;
// How far back to look for newly-ended appointments that don't have a
// schedule row yet. Comfortably wider than the 7-day search window itself
// so a worker outage can never silently skip enqueueing an appointment
// that ended during the gap.
const ENQUEUE_LOOKBACK_DAYS = 9;

function hoursToMs(h) { return h * 60 * 60 * 1000; }

/**
 * Scans recently-ended appointments and creates a schedule row for every
 * one that is eligible and doesn't already have one. Safe to call every
 * worker tick — UNIQUE(appointment_id) + ON CONFLICT DO NOTHING makes this
 * idempotent regardless of how often or how many times it runs.
 */
async function enqueueEligibleAppointments() {
  const { rows: candidates } = await db.query(
    `SELECT a.id, a.lead_id, a.start_at, a.end_at, a.busy_range, a.status
       FROM appointments a
      WHERE a.status IN ('scheduled', 'confirmed', 'completed')
        AND a.end_at <= NOW()
        AND a.end_at >= NOW() - INTERVAL '${ENQUEUE_LOOKBACK_DAYS} days'
        AND NOT EXISTS (
          SELECT 1 FROM post_appointment_estimate_syncs p WHERE p.appointment_id = a.id
        )`
  );

  let enqueued = 0;
  let skippedPhoneCall = 0;
  for (const appt of candidates) {
    // A legacy, pre-"Phone Call is never an appointment" row — never
    // eligible. Derived from busy_range (no travel buffer), the same
    // durable signal every other appointment-kind-aware feature in this
    // codebase already uses — never a separate status/type field.
    if (appointmentKind.isPhoneCallAppointment(appt)) { skippedPhoneCall++; continue; }

    const endAt = new Date(appt.end_at);
    const nextAttemptAt = new Date(endAt.getTime() + hoursToMs(RETRY_OFFSET_HOURS[0]));
    const windowExpiresAt = new Date(endAt.getTime() + WINDOW_DAYS * 24 * hoursToMs(1));

    const { rows } = await db.query(
      `INSERT INTO post_appointment_estimate_syncs (appointment_id, lead_id, next_attempt_at, window_expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (appointment_id) DO NOTHING
       RETURNING id`,
      [appt.id, appt.lead_id, nextAttemptAt.toISOString(), windowExpiresAt.toISOString()]
    );
    if (rows.length) enqueued++;
  }

  return { scanned: candidates.length, enqueued, skippedPhoneCall };
}

/**
 * Attempts the next sync for one claimed schedule row. Never throws for an
 * ordinary outcome (not found / found-unverified / found-and-enrolled /
 * lead-ineligible) — those are all written directly. A genuine QuickBooks/
 * network failure IS thrown, so the caller can record it as a retryable
 * error without duplicating that bookkeeping here.
 */
async function attemptSync(syncRow) {
  const { rows: leadRows } = await db.query(
    `SELECT id, first_name, last_name, email, status, qb_customer_id, handoff_estimate_status
       FROM leads WHERE id = $1`,
    [syncRow.lead_id]
  );
  const lead = leadRows[0];
  if (!lead) {
    return { outcome: 'stopped', lastResult: 'lead_ineligible', stoppedReason: 'lead_not_found' };
  }
  if (estimateFollowupEligibility.DISQUALIFYING_LEAD_STATUSES.has(lead.status)) {
    return { outcome: 'stopped', lastResult: 'lead_ineligible', stoppedReason: `lead_status:${lead.status}` };
  }

  // The actual lead-scoped sync — no full-company scan (see header).
  const syncResult = await leadEstimateSync.syncEstimatesForLead(lead, { allowFullScan: false });

  const foundIds = syncResult.synced_estimate_ids || [];
  if (!syncResult.success || foundIds.length === 0) {
    return { outcome: 'pending', lastResult: 'not_found', handoffEstimateId: syncRow.handoff_estimate_id || null };
  }

  const { rows: estRows } = await db.query(
    `SELECT id, estimate_status, qb_email_status, qb_email_delivery_time FROM handoff_estimates WHERE id = ANY($1::uuid[])`,
    [foundIds]
  );

  // Prefer a row with confirmed delivery evidence; otherwise just the
  // first found estimate, so the lead page can still link to SOMETHING.
  let evidenceRow = null;
  let evidence = null;
  for (const est of estRows) {
    const ev = estimateSentDetection.classifyQbSentEvidence({
      EmailStatus: est.qb_email_status,
      DeliveryInfo: { DeliveryTime: est.qb_email_delivery_time },
    });
    if (ev.confirmed) { evidenceRow = est; evidence = ev; break; }
  }
  const firstFound = evidenceRow || estRows[0];

  if (!evidence) {
    return { outcome: 'pending', lastResult: 'found_unverified', handoffEstimateId: firstFound ? firstFound.id : null };
  }

  // Confirmed delivery evidence — attempt enrollment through the ONE
  // enrollment entry point, exactly as lib/estimateFollowupEngine.js's own
  // runAutoEnrollmentScan does for its separate, periodic global scan.
  try {
    await estimateFollowupEngine.enroll({
      leadId: lead.id,
      handoffEstimateId: evidenceRow.id,
      confirmedBy: 'system:auto_post_appointment_sync',
      sentAt: evidence.sentAt,
      method: 'auto_post_appointment_sync',
      note: `Automatically enrolled after post-appointment QuickBooks sync — EmailStatus=EmailSent (evidence: ${evidence.evidence})`,
    });
    return { outcome: 'completed', lastResult: 'found_verified_enrolled', handoffEstimateId: evidenceRow.id };
  } catch (e) {
    if (e && e.code === 'not_eligible') {
      if (e.reasons.includes('competing_sequence_already_active')) {
        // Already enrolled (by this same job on an earlier retry, or by
        // the separate global auto-enrollment scan) — a success, not a
        // failure. Idempotent by construction.
        return { outcome: 'completed', lastResult: 'found_verified_enrolled', handoffEstimateId: evidenceRow.id };
      }
      if (e.reasons.some((r) => r.startsWith('lead_status_disqualifying'))) {
        return { outcome: 'stopped', lastResult: 'lead_ineligible', stoppedReason: e.reasons.join(','), handoffEstimateId: evidenceRow.id };
      }
      // Any other disqualification (estimate no longer Pending, email
      // invalid, suppressed, customer_reminders_disabled) means this
      // specific estimate/lead can never be enrolled now — stop the
      // search rather than retrying the same doomed outcome for up to
      // 7 days.
      return { outcome: 'stopped', lastResult: 'found_unverified', stoppedReason: `not_eligible:${e.reasons.join(',')}`, handoffEstimateId: evidenceRow.id };
    }
    throw e;
  }
}

/**
 * Advances a non-terminal row to its next retry, or expires it once the
 * 7-day window (RETRY_OFFSET_HOURS' own last entry) has been exhausted.
 */
function computeAdvance(syncRow, appointmentEndAt) {
  const nextIndex = syncRow.attempt_number + 1;
  if (nextIndex >= RETRY_OFFSET_HOURS.length) {
    return { expired: true };
  }
  const nextAttemptAt = new Date(new Date(appointmentEndAt).getTime() + hoursToMs(RETRY_OFFSET_HOURS[nextIndex]));
  if (nextAttemptAt.getTime() > new Date(syncRow.window_expires_at).getTime()) {
    return { expired: true };
  }
  return { expired: false, nextAttemptAt, attemptNumber: nextIndex };
}

async function processOne(syncRow, appointmentEndAt) {
  let result;
  let errorMessage = null;
  try {
    result = await attemptSync(syncRow);
  } catch (e) {
    errorMessage = String(e && e.message || e).slice(0, 500);
    result = { outcome: 'pending', lastResult: 'error' };
  }

  if (result.outcome === 'completed' || result.outcome === 'stopped') {
    await db.query(
      `UPDATE post_appointment_estimate_syncs
          SET status = $2, last_result = $3, stopped_reason = $4, last_error = $5,
              handoff_estimate_id = COALESCE($6, handoff_estimate_id)
        WHERE id = $1`,
      [syncRow.id, result.outcome, result.lastResult, result.stoppedReason || null, errorMessage, result.handoffEstimateId || null]
    );
    return result;
  }

  // Still pending — advance to the next retry or expire the search window.
  const advance = computeAdvance(syncRow, appointmentEndAt);
  if (advance.expired) {
    await db.query(
      `UPDATE post_appointment_estimate_syncs
          SET status = 'expired', last_result = $2, last_error = $3,
              handoff_estimate_id = COALESCE($4, handoff_estimate_id)
        WHERE id = $1`,
      [syncRow.id, result.lastResult, errorMessage, result.handoffEstimateId || null]
    );
    return { ...result, outcome: 'expired' };
  }

  await db.query(
    `UPDATE post_appointment_estimate_syncs
        SET status = 'pending', attempt_number = $2, next_attempt_at = $3,
            last_result = $4, last_error = $5,
            handoff_estimate_id = COALESCE($6, handoff_estimate_id)
      WHERE id = $1`,
    [syncRow.id, advance.attemptNumber, advance.nextAttemptAt.toISOString(), result.lastResult, errorMessage, result.handoffEstimateId || null]
  );
  return result;
}

/**
 * The worker tick entry point — called from reminderWorker.js on the same
 * cadence as the other reminder/follow-up engines. Enqueues newly-eligible
 * appointments, then claims and processes every currently-due schedule
 * row (bounded per tick so one slow run can't block the rest of the
 * reminder worker's own ticks indefinitely).
 */
// A row claimed into 'processing' is normally resolved within the same
// call (claim -> sync -> write result is one synchronous chain, no await
// gap long enough to matter). If a worker crashes mid-attempt, the row
// would otherwise be stuck in 'processing' forever with no automatic
// recovery — this reaps anything stuck that long back to 'pending' so the
// NEXT tick picks it up again. 10 minutes is comfortably longer than any
// single sync attempt (bounded by qbTokenManager's own retry/circuit-
// breaker timeouts) should ever take.
const STUCK_PROCESSING_MINUTES = 10;

async function reapStuckProcessingRows() {
  const { rows } = await db.query(
    `UPDATE post_appointment_estimate_syncs
        SET status = 'pending'
      WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '${STUCK_PROCESSING_MINUTES} minutes'
      RETURNING id`
  );
  return rows.length;
}

async function processPostAppointmentEstimateSyncs({ triggeredBy = 'cron' } = {}) {
  const reaped = await reapStuckProcessingRows();
  const enqueueResult = await enqueueEligibleAppointments();

  const { rows: due } = await db.query(
    `SELECT * FROM post_appointment_estimate_syncs
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at ASC
      LIMIT ${MAX_ROWS_PER_TICK}`
  );

  const summary = {
    reaped,
    scannedAppointments: enqueueResult.scanned,
    enqueued: enqueueResult.enqueued,
    due: due.length,
    processed: 0,
    foundVerifiedEnrolled: 0,
    foundUnverified: 0,
    notFound: 0,
    stopped: 0,
    expired: 0,
    errors: [],
  };

  for (const row of due) {
    // Claim via UPDATE...WHERE status='pending' — a concurrent worker that
    // lost this race gets zero rows back and simply moves on (same pattern
    // as lib/estimateFollowupEngine.js's own step claim).
    const claimed = await db.query(
      `UPDATE post_appointment_estimate_syncs p
          SET status = 'processing'
         FROM appointments a
        WHERE p.id = $1 AND p.status = 'pending' AND a.id = p.appointment_id
        RETURNING p.*, a.end_at AS appointment_end_at`,
      [row.id]
    );
    if (!claimed.rows.length) continue;
    const syncRow = claimed.rows[0];

    try {
      const result = await processOne(syncRow, syncRow.appointment_end_at);
      summary.processed++;
      if (result.outcome === 'completed') summary.foundVerifiedEnrolled++;
      else if (result.outcome === 'expired') summary.expired++;
      else if (result.outcome === 'stopped') summary.stopped++;
      else if (result.lastResult === 'found_unverified') summary.foundUnverified++;
      else summary.notFound++;
    } catch (e) {
      summary.errors.push(`sync ${syncRow.id}: ${e.message}`);
    }
  }

  console.log(JSON.stringify({ event: 'POST_APPOINTMENT_ESTIMATE_SYNC_TICK', triggeredBy, ...summary }));
  return summary;
}

module.exports = {
  RETRY_OFFSET_HOURS,
  WINDOW_DAYS,
  STUCK_PROCESSING_MINUTES,
  enqueueEligibleAppointments,
  reapStuckProcessingRows,
  attemptSync,
  computeAdvance,
  processOne,
  processPostAppointmentEstimateSyncs,
};
