/* eslint-disable no-undef */
/**
 * estimateFollowupEligibility — the ONE place eligibility for the
 * automated 14-day estimate follow-up sequence is decided. Used at THREE
 * points, deliberately sharing this single implementation so the rules
 * can never drift between them:
 *   1. The "Confirm Estimate Sent" enrollment action.
 *   2. Immediately before every single send (lib/estimateFollowupEngine.js)
 *      — eligibility is re-checked fresh every time, never assumed to
 *      still hold from enrollment.
 *   3. The dry-run eligibility report (zero side effects).
 *
 * Deliberately does NOT infer estimate delivery from estimate creation,
 * import, or an appointment — none of those are reliable evidence a
 * customer actually received the estimate. The only accepted evidence is
 * the explicit, auditable "Confirm Estimate Sent" action
 * (estimate_followup_sequences.estimate_sent_confirmed_at/_by), which this
 * module does not itself create — it only requires that one already
 * exists before computing eligibility for an ongoing sequence.
 */
'use strict';

const db = require('../db/client');
const { TERMINAL_LOST_STATUSES } = require('./leadStatus');

// 'Sold' is a positive outcome deliberately excluded from
// TERMINAL_LOST_STATUSES (lib/leadStatus.js) — it's not "lost," but a
// customer who already bought has no reason to keep receiving
// "should I keep your project on my radar?" follow-ups about an estimate
// they already accepted.
const DISQUALIFYING_LEAD_STATUSES = new Set([...TERMINAL_LOST_STATUSES, 'Sold']);

// The only QuickBooks Estimate TxnStatus value this codebase treats as
// "still outstanding" (see server.js's own `allStatuses` scan list and
// routes/handoffEstimates.js). 'Accepted'/'Closed'/'Rejected' are all
// treated as no-longer-eligible — "active, not voided, deleted, declined,
// or superseded" per the explicit requirement; this is the best available
// real signal, since handoff_estimates has no separate void/delete flag.
const ELIGIBLE_ESTIMATE_STATUS = 'Pending';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function isValidEmail(email) {
  return !!(email && EMAIL_RE.test(String(email).trim()));
}

/**
 * The actual edge — oldStatus not disqualifying, newStatus disqualifying —
 * never a re-fire on an edit that leaves an already-disqualifying lead's
 * status unchanged, and never a re-fire moving between two disqualifying
 * statuses (e.g. Lost -> DNQ). Mirrors lib/leadStatus.js#isEnteringTerminalLostStatus's
 * own edge-detection shape, but against DISQUALIFYING_LEAD_STATUSES (which
 * additionally includes 'Sold') rather than TERMINAL_LOST_STATUSES — kept
 * as its own function, never folded into leadStatus.js, since 'Sold'
 * entering this set must never affect appointment cancellation or Google
 * Contacts exclusion, only estimate-followup termination.
 */
function isEnteringDisqualifyingStatus(oldStatus, newStatus) {
  return DISQUALIFYING_LEAD_STATUSES.has(newStatus) && !DISQUALIFYING_LEAD_STATUSES.has(oldStatus);
}

async function isSuppressed(email) {
  if (!email) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM estimate_followup_suppressions WHERE email = $1 LIMIT 1`,
    [String(email).trim().toLowerCase()]
  );
  return rows.length > 0;
}

async function hasLiveSequence(leadId, excludeSequenceId) {
  const { rows } = await db.query(
    `SELECT id FROM estimate_followup_sequences
      WHERE lead_id = $1 AND status IN ('active', 'paused') AND id != COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [leadId, excludeSequenceId || null]
  );
  return rows.length > 0;
}

/**
 * Estimate-level companion to hasLiveSequence (November 2026 — closes the
 * cross-lead duplicate-estimate gap a production audit found for
 * HNDF-EST-10260: two different leads each matched to the same real
 * qb_estimate_id). This is the application-level pre-check; the actual,
 * concurrency-safe backstop is the partial unique index added in
 * db/migrations/2026-74-estimate-followup-estimate-level-dedup.sql — same
 * two-layer shape (pre-check + DB constraint) hasLiveSequence/the lead-level
 * index already use. `excludeSequenceId` lets a caller re-checking an
 * existing sequence's own continued eligibility ignore itself.
 */
async function hasLiveSequenceForEstimate(qbEstimateId, excludeSequenceId) {
  if (!qbEstimateId) return false;
  const { rows } = await db.query(
    `SELECT id FROM estimate_followup_sequences
      WHERE qb_estimate_id = $1 AND status IN ('active', 'paused') AND id != COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [qbEstimateId, excludeSequenceId || null]
  );
  return rows.length > 0;
}

/**
 * Eligibility to START a brand-new sequence for a specific lead + estimate.
 * Pure read — no writes. Returns { eligible, reasons[], lead, estimate }.
 * `reasons` is always populated (even when eligible — it stays empty) so a
 * caller can surface exactly why a lead is or isn't eligible.
 */
async function checkEligibilityForEnrollment({ leadId, handoffEstimateId }) {
  const reasons = [];
  const { rows: leadRows } = await db.query(
    `SELECT id, first_name, last_name, email, status, owner_id, customer_reminders_disabled, project_type
       FROM leads WHERE id = $1`,
    [leadId]
  );
  const lead = leadRows[0] || null;
  if (!lead) {
    return { eligible: false, reasons: ['lead_not_found'], lead: null, estimate: null };
  }

  if (DISQUALIFYING_LEAD_STATUSES.has(lead.status)) {
    reasons.push(`lead_status_disqualifying:${lead.status}`);
  }
  if (!isValidEmail(lead.email)) {
    reasons.push('lead_email_invalid_or_missing');
  }
  if (lead.customer_reminders_disabled) {
    reasons.push('customer_reminders_disabled');
  }
  if (lead.email && (await isSuppressed(lead.email))) {
    reasons.push('email_suppressed_unsubscribed');
  }
  if (await hasLiveSequence(leadId)) {
    reasons.push('competing_sequence_already_active');
  }

  let estimate = null;
  if (!handoffEstimateId) {
    reasons.push('no_estimate_specified');
  } else {
    const { rows: estRows } = await db.query(
      `SELECT id, lead_id, estimate_status, qb_estimate_id, customer_email FROM handoff_estimates WHERE id = $1`,
      [handoffEstimateId]
    );
    estimate = estRows[0] || null;
    if (!estimate) {
      reasons.push('estimate_not_found');
    } else if (String(estimate.lead_id) !== String(leadId)) {
      reasons.push('estimate_not_linked_to_this_lead');
    } else if (estimate.estimate_status !== ELIGIBLE_ESTIMATE_STATUS) {
      reasons.push(`estimate_not_pending:${estimate.estimate_status || 'unknown'}`);
    } else if (await hasLiveSequenceForEstimate(estimate.qb_estimate_id)) {
      // A DIFFERENT lead's row for the SAME real qb_estimate_id already has
      // a live sequence — e.g. HNDF-EST-10260's two-leads shape. Checked
      // only once the estimate itself is otherwise valid/Pending, so this
      // reason is never reported ahead of a more fundamental one.
      reasons.push('competing_sequence_for_same_estimate');
    }
  }

  return { eligible: reasons.length === 0, reasons, lead, estimate };
}

/**
 * Fresh re-check for an EXISTING sequence, called immediately before every
 * send. Re-reads the lead and its linked estimate from scratch — never
 * trusts the snapshot taken at enrollment. Returns { eligible, reason }
 * (singular — the engine only needs the first disqualifying fact to stop
 * the sequence; it is not asking "would enrollment succeed today").
 */
async function checkEligibilityForSend(sequence) {
  const { rows: leadRows } = await db.query(
    `SELECT id, first_name, email, status, customer_reminders_disabled FROM leads WHERE id = $1`,
    [sequence.lead_id]
  );
  const lead = leadRows[0];
  if (!lead) return { eligible: false, reason: 'lead_not_found' };
  if (DISQUALIFYING_LEAD_STATUSES.has(lead.status)) return { eligible: false, reason: `lead_status_disqualifying:${lead.status}` };
  if (!isValidEmail(lead.email)) return { eligible: false, reason: 'lead_email_invalid_or_missing' };
  if (lead.customer_reminders_disabled) return { eligible: false, reason: 'customer_reminders_disabled' };
  if (await isSuppressed(lead.email)) return { eligible: false, reason: 'email_suppressed_unsubscribed' };

  if (sequence.handoff_estimate_id) {
    const { rows: estRows } = await db.query(
      `SELECT estimate_status FROM handoff_estimates WHERE id = $1`,
      [sequence.handoff_estimate_id]
    );
    const estimate = estRows[0];
    if (!estimate) return { eligible: false, reason: 'estimate_not_found' };
    if (estimate.estimate_status !== ELIGIBLE_ESTIMATE_STATUS) {
      return { eligible: false, reason: `estimate_not_pending:${estimate.estimate_status || 'unknown'}` };
    }
  } else {
    return { eligible: false, reason: 'estimate_not_found' };
  }

  return { eligible: true, reason: null, lead };
}

module.exports = {
  DISQUALIFYING_LEAD_STATUSES,
  ELIGIBLE_ESTIMATE_STATUS,
  isValidEmail,
  isEnteringDisqualifyingStatus,
  isSuppressed,
  hasLiveSequence,
  hasLiveSequenceForEstimate,
  checkEligibilityForEnrollment,
  checkEligibilityForSend,
};
