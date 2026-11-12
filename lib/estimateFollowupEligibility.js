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
  isSuppressed,
  hasLiveSequence,
  checkEligibilityForEnrollment,
  checkEligibilityForSend,
};
