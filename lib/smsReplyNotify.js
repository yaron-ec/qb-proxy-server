/* eslint-disable no-undef */
/**
 * smsReplyNotify — the notification side effects fired on an ordinary
 * (non-keyword) inbound customer SMS reply, built for the October 2026
 * "COMPLETE META, SOCIAL MEDIA & TWO-WAY APPOINTMENT SMS IMPLEMENTATION"
 * request:
 *
 *   - notifyAssignedRep / notifyUnmatchedForReview — an EMAIL to the lead's
 *     actual assigned rep (resolved via the real owners FK, never the
 *     heuristic firstname@domain guess — the rep's name must never be
 *     invented), or, when the inbound number matched zero or more than one
 *     lead, to staff for manual review instead via the SAME existing
 *     staff-broadcast 'activity' notification category every other CRM
 *     activity email already uses (never guessed, never silently dropped).
 *
 * Gated by SMS_REPLY_NOTIFICATIONS_ENABLED — deliberately SEPARATE from
 * SMS_AUTOMATED_REMINDERS_ENABLED (which gates the UNRELATED
 * booking-confirmation and 12h/2h reminder sends in
 * lib/booking/bookingService.js / lib/reminderEngine.js). These two kill
 * switches were originally the same one; split out (October 2026, live-SMS
 * verification pass) so that enabling one can never silently arm the other.
 *
 * Idempotency: notifyAssignedRep/notifyUnmatchedForReview are each called at
 * most once per unique inbound MessageSid — routes/sms.js's webhook handler
 * already returns early on handleInboundMessage's `duplicate: true` (a
 * redelivered webhook) before either is ever reached — AND each email send
 * carries its own DB-backed idempotency key (lib/emailService.js), so a
 * second attempt for the same MessageSid can never produce a second email
 * even if this function were somehow called twice.
 *
 * RETIRED (November 2026, revised notification-design decision): this file
 * previously also forwarded every ordinary inbound reply as a SEPARATE
 * outbound Twilio SMS to a hardcoded-free SMS_REPLY_FORWARD_TO destination
 * (forwardToYaronBestEffort). That function and its call site in
 * routes/sms.js have been REMOVED — inbound-reply notifications now go
 * exclusively through the CRM's existing email notification infrastructure
 * (the same mechanism every other lead-related notification already uses),
 * never a second paid outbound SMS. Yaron is notified like any other staff
 * member: by email, as the lead's assigned owner (notifyAssignedRep) or via
 * the existing staff 'activity' broadcast (notifyUnmatchedForReview) —
 * never via a personal-phone SMS copy. SMS_REPLY_FORWARD_TO must stay unset
 * in production; nothing in this codebase reads it anymore.
 */
'use strict';

const { query } = require('../db/client');

function replyNotificationsEnabled() {
  return process.env.SMS_REPLY_NOTIFICATIONS_ENABLED === 'true';
}

/** Look up a lead's REAL assigned rep via the owners FK (leads.owner_id) —
 * never the heuristic firstname@domain reconstruction used for display-only
 * email "From" headers elsewhere, since a name/email shown in a staff
 * notification must be accurate, not guessed. Returns null fields when the
 * lead has no owner assigned — the caller must treat that as "no rep to
 * notify," never invent one. */
async function resolveLeadAndOwner(leadId) {
  const { rows } = await query(
    `SELECT l.id, l.first_name, l.last_name, l.phone,
            o.email AS owner_email, o.display_name AS owner_name
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
      WHERE l.id = $1`,
    [leadId]
  );
  return rows[0] || null;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Email the lead's own assigned rep. Never filtered by notificationPreferences
 * (same precedent as lib/reminderEngine.js's ownerEmail — the lead's own rep
 * is never subject to the broadcast staff-preference narrowing, only the
 * broadcast list itself is). No-op (returns {sent:false, reason}) when the
 * lead has no owner or the owner has no email on file — never guessed. */
async function notifyAssignedRep({ leadId, body, messageSid, crmPublicUrl }) {
  if (!replyNotificationsEnabled()) return { sent: false, reason: 'reply_notifications_disabled' };
  let row;
  try {
    row = await resolveLeadAndOwner(leadId);
  } catch (e) {
    console.warn('[smsReplyNotify] rep lookup failed (non-fatal):', e.message);
    return { sent: false, reason: e.message };
  }
  if (!row) return { sent: false, reason: 'lead_not_found' };
  if (!row.owner_email) return { sent: false, reason: 'no_owner_assigned' };

  const emailService = require('./emailService');
  const clientName = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'A customer';
  const leadUrl = crmPublicUrl ? `${String(crmPublicUrl).replace(/\/$/, '')}/leads/${row.id}` : null;
  const subject = `New SMS reply from ${clientName}`;
  const htmlBody = `
    <p>${escapeHtml(clientName)} replied by text:</p>
    <blockquote style="border-left:3px solid #ccc;margin:0;padding-left:12px;color:#333;">${escapeHtml(body)}</blockquote>
    ${leadUrl ? `<p><a href="${leadUrl}">Open this lead in the CRM to respond</a></p>` : '<p>Open this lead in the CRM to respond.</p>'}
  `;
  try {
    const r = await emailService.send({
      to: row.owner_email, subject, htmlBody,
      idempotencyKey: `sms-inbound-notify-rep:${messageSid}`,
    });
    return { sent: true, to: row.owner_email, gmailMessageId: r.gmailMessageId };
  } catch (e) {
    console.warn('[smsReplyNotify] rep notification failed (non-fatal):', e.message);
    return { sent: false, reason: e.message };
  }
}

/** Zero or ambiguous lead match — never guess, notify staff for manual
 * review instead. Routed through the SAME 'activity' notification category
 * the rest of the CRM's staff-broadcast activity emails use
 * (lib/notificationPreferences.js), so an admin who has disabled that
 * category (e.g. Michelle's single-category policy — CLAUDE.md) is
 * correctly excluded by the SAME existing mechanism, not a one-off guess
 * here. */
async function notifyUnmatchedForReview({ body, messageSid, fromNumber, ambiguous, candidateLeadIds }) {
  if (!replyNotificationsEnabled()) return { sent: false, reason: 'reply_notifications_disabled' };
  const notificationRecipients = require('./notificationRecipients');
  const notificationPreferences = require('./notificationPreferences');
  const emailService = require('./emailService');

  const staff = await notificationPreferences.filterRecipientsForCategory(
    await notificationRecipients.getAllStaffRecipients(),
    notificationPreferences.CATEGORIES.ACTIVITY
  );
  if (staff.length === 0) return { sent: false, reason: 'no_staff_recipients' };

  const subject = ambiguous ? 'SMS reply — multiple matching leads, needs review' : 'SMS reply — no matching lead, needs review';
  const htmlBody = `
    <p>An inbound text from <strong>${escapeHtml(fromNumber)}</strong> could not be ${ambiguous ? 'uniquely matched to a lead' : 'matched to any lead'}:</p>
    <blockquote style="border-left:3px solid #ccc;margin:0;padding-left:12px;color:#333;">${escapeHtml(body)}</blockquote>
    ${ambiguous && candidateLeadIds?.length ? `<p>Candidate leads: ${candidateLeadIds.map(escapeHtml).join(', ')}</p>` : ''}
    <p>Please review and link this message to the correct lead.</p>
  `;
  const results = await Promise.all(staff.map((to) =>
    emailService.send({ to, subject, htmlBody, idempotencyKey: `sms-inbound-notify-review:${messageSid}:${to}` })
      .then(() => ({ to, ok: true }))
      .catch((e) => ({ to, ok: false, error: e.message }))
  ));
  return { sent: results.some((r) => r.ok), results };
}

module.exports = {
  resolveLeadAndOwner,
  notifyAssignedRep,
  notifyUnmatchedForReview,
  replyNotificationsEnabled,
};
