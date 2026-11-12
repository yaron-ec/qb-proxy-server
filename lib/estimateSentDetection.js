/* eslint-disable no-undef */
/**
 * estimateSentDetection — classifies whether a QuickBooks Estimate payload
 * carries reliable evidence that it was actually emailed to the customer,
 * for the estimate follow-up sequence's automatic-enrollment path.
 *
 * Background (investigated, not assumed — see CLAUDE.md's "Automated
 * estimate-sent + reply detection" section for the full writeup):
 *   - server.js#runQbEstimateSync already issues `SELECT * FROM Estimate`
 *     on every sync tick, so the full QuickBooks Estimate payload —
 *     including `EmailStatus` and, when present, `DeliveryInfo` — is
 *     ALREADY fetched today. This module requires ZERO new QuickBooks API
 *     calls, scopes, or credentials; it only changes what the existing
 *     response is used for.
 *   - `EmailStatus` is a documented field on every QuickBooks Online
 *     "SalesTransaction" entity (Estimate, Invoice, SalesReceipt,
 *     CreditMemo), with exactly three possible values: 'NotSet' (QB's own
 *     Send feature was never used), 'NeedToSend' (queued for QB to send,
 *     not yet sent), and 'EmailSent' (QuickBooks itself emailed the
 *     document and recorded that it did). When EmailSent, QuickBooks also
 *     typically populates `DeliveryInfo.DeliveryTime` with the real
 *     send instant.
 *   - CONFIRMED DEFECT found during this investigation (left exactly as it
 *     was — out of scope to "fix" here, since it is business-status logic
 *     unrelated to this feature and changing it is a separate, deliberate
 *     decision): `server.js#runQbEstimateSyncInner` already reads
 *     `qbEst.EmailStatus` today, but ONLY as a same-column fallback for
 *     `qbEst.TxnStatus` (`const status = qbEst.TxnStatus || qbEst.EmailStatus
 *     || 'Draft'`) — i.e. it conflates the business-approval status
 *     (Pending/Accepted/Closed/Rejected) with the completely different
 *     send-evidence field, and only in the (almost never true) case where
 *     TxnStatus is entirely absent. This module does NOT touch that line —
 *     it reads `EmailStatus`/`DeliveryInfo` directly off the raw QB
 *     estimate object at sync time and persists them into their OWN new,
 *     additive columns (handoff_estimates.qb_email_status /
 *     qb_email_delivery_time — see db/migrations/2026-71), never derived
 *     from or overwriting the existing estimate_status column.
 *
 * KNOWN, HONEST LIMITATION — the deciding fact this module cannot
 * determine from code alone: whether Handoff's own push-to-QuickBooks
 * integration ever triggers QuickBooks' own email-send mechanism (which is
 * what sets EmailStatus to 'EmailSent') is unverified from this
 * environment (no production database or live QuickBooks API access).
 * Handoff most plausibly emails the customer through ITS OWN system,
 * entirely outside QuickBooks, in which case EmailStatus would remain
 * 'NotSet'/'NeedToSend' forever for every Handoff-origin estimate and this
 * signal — while real, correctly implemented, and requiring no new
 * credentials — may simply never fire for this installation's actual
 * estimate source. Deploying this persists the real field on every future
 * sync tick, and scripts/auditQbEstimateEmailStatus.js reports the actual
 * observed distribution once that happens — see that script for the
 * concrete next step to resolve this uncertainty empirically rather than
 * guessing.
 */
'use strict';

const CONFIRMED_EMAIL_STATUSES = new Set(['EmailSent']);

/**
 * @param {object} qbEstimate - the raw QuickBooks Estimate object (as
 *   returned by `SELECT * FROM Estimate`), or a minimal shape with just
 *   `EmailStatus`/`DeliveryInfo`/`MetaData`.
 * @returns {{ confirmed: boolean, sentAt: string|null, evidence: string,
 *            emailStatus: string|null }}
 *   confirmed=true only when QuickBooks' own EmailStatus reads 'EmailSent'.
 *   sentAt prefers DeliveryInfo.DeliveryTime (QuickBooks' own recorded send
 *   instant); when EmailSent but DeliveryTime is absent, falls back to
 *   MetaData.LastUpdatedTime as the best real (not invented) instant
 *   available — never falls back to "now" and never backdates further
 *   than what QuickBooks itself reports.
 */
function classifyQbSentEvidence(qbEstimate) {
  const emailStatus = (qbEstimate && qbEstimate.EmailStatus) || null;
  const deliveryTime = qbEstimate && qbEstimate.DeliveryInfo && qbEstimate.DeliveryInfo.DeliveryTime;
  const lastUpdated = qbEstimate && qbEstimate.MetaData && qbEstimate.MetaData.LastUpdatedTime;

  if (!emailStatus || !CONFIRMED_EMAIL_STATUSES.has(emailStatus)) {
    return { confirmed: false, sentAt: null, evidence: 'none', emailStatus };
  }
  const sentAt = deliveryTime || lastUpdated || null;
  if (!sentAt) {
    // EmailSent with no usable timestamp anywhere on the payload — treat as
    // NOT confirmed rather than guessing a sentAt. This should be rare in
    // practice (EmailSent estimates normally carry at least LastUpdatedTime).
    return { confirmed: false, sentAt: null, evidence: 'email_sent_no_timestamp', emailStatus };
  }
  return { confirmed: true, sentAt, evidence: 'qb_email_status_sent', emailStatus };
}

module.exports = { classifyQbSentEvidence, CONFIRMED_EMAIL_STATUSES };
