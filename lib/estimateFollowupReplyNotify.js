/* eslint-disable no-undef */
/**
 * estimateFollowupReplyNotify — the ONE notification side effect fired when
 * lib/estimateFollowupReplyDetection.js detects and pauses a sequence on a
 * genuine customer reply. Mirrors lib/smsReplyNotify.js's precedent exactly
 * (same shape: resolve the lead's REAL assigned rep via the owners FK,
 * never a heuristic reconstruction; email-only, never a second channel; a
 * staff broadcast through the existing ACTIVITY notification category when
 * there is no assigned rep to notify directly).
 *
 * EMAIL ONLY, per the explicit requirement — never SMS, never a second
 * paid channel of any kind (this codebase retired exactly that pattern for
 * SMS replies in November 2026 — see smsReplyNotify.js's own header; this
 * module is built without ever introducing it for estimate-followup
 * replies in the first place).
 *
 * Gated by ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED — a SEPARATE flag
 * from ESTIMATE_FOLLOWUP_REPLY_DETECTION_ENABLED (which gates detection/
 * pause/the fail-closed send gate in lib/estimateFollowupReplyDetection.js).
 * A reply is always detected and the sequence always paused regardless of
 * this flag — this flag gates ONLY whether the rep-notification email
 * itself is sent, mirroring the SMS detection/notification split.
 *
 * Idempotency: lib/estimateFollowupReplyDetection.js only calls this once
 * per genuinely NEW reply (its own activities.external_ref uniqueness
 * check gates the call) AND every email send here carries its own
 * DB-backed idempotency key (lib/emailService.js) keyed by the Gmail
 * message id — a second call for the same message can never produce a
 * second email either way.
 */
'use strict';

const { query } = require('../db/client');
const crmUrl = require('./crmUrl');

function replyNotificationsEnabled() {
  return process.env.ESTIMATE_FOLLOWUP_REPLY_NOTIFICATIONS_ENABLED === 'true';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Resolve a lead's REAL assigned rep via the owners FK — never guessed. */
async function resolveLeadAndOwner(leadId) {
  const { rows } = await query(
    `SELECT l.id, l.first_name, l.last_name, l.email,
            o.email AS owner_email, o.display_name AS owner_name
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
      WHERE l.id = $1`,
    [leadId]
  );
  return rows[0] || null;
}

/**
 * Called from lib/estimateFollowupReplyDetection.js immediately after a
 * sequence is paused for a genuine new reply. Never throws (the caller
 * already wraps this in try/catch, but every internal failure here is also
 * caught and reported as {sent:false, reason} for symmetry with
 * smsReplyNotify's own convention).
 */
async function notifyReplyDetected({ sequence, fromAddr, subject, messageId }) {
  if (!replyNotificationsEnabled()) return { sent: false, reason: 'reply_notifications_disabled' };
  if (!sequence || !sequence.lead_id) return { sent: false, reason: 'no_lead_on_sequence' };

  let lead;
  try {
    lead = await resolveLeadAndOwner(sequence.lead_id);
  } catch (e) {
    console.warn('[estimateFollowupReplyNotify] lead lookup failed (non-fatal):', e.message);
    return { sent: false, reason: e.message };
  }
  if (!lead) return { sent: false, reason: 'lead_not_found' };

  const emailService = require('./emailService');
  const clientName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'A customer';
  const leadUrl = crmUrl.buildLeadUrl(lead.id);
  const idempotencyKey = `estimate-followup-reply-notify:${messageId}`;

  // Assigned rep known — direct email, never category-filtered (the lead's
  // own rep is never subject to the broadcast staff-preference narrowing,
  // only the broadcast fallback below is — same precedent as
  // lib/smsReplyNotify.js#notifyAssignedRep).
  if (lead.owner_email) {
    const emailSubject = `Reply received — estimate follow-up paused for ${clientName}`;
    const htmlBody = `
      <p>${escapeHtml(clientName)} (${escapeHtml(fromAddr)}) replied to an automated estimate follow-up email, with subject:</p>
      <blockquote style="border-left:3px solid #ccc;margin:0;padding-left:12px;color:#333;">${escapeHtml(subject)}</blockquote>
      <p>The automated follow-up sequence for this lead has been paused. Please review the reply in Gmail and respond directly.</p>
      ${leadUrl ? `<p><a href="${leadUrl}">Open this lead in the CRM</a></p>` : '<p>Open this lead in the CRM to respond.</p>'}
    `;
    try {
      const r = await emailService.send({ to: lead.owner_email, subject: emailSubject, htmlBody, idempotencyKey, role: 'estimate_followup_reply' });
      return { sent: true, to: lead.owner_email, gmailMessageId: r.gmailMessageId };
    } catch (e) {
      console.warn('[estimateFollowupReplyNotify] rep notification failed (non-fatal):', e.message);
      return { sent: false, reason: e.message };
    }
  }

  // No owner assigned — never silently drop the notification: broadcast to
  // staff through the SAME existing ACTIVITY notification category every
  // other staff-broadcast CRM email already uses (lib/notificationPreferences.js),
  // so Michelle's single-category policy etc. excludes her the same way it
  // already does for every other staff broadcast — no new logic here.
  const notificationRecipients = require('./notificationRecipients');
  const notificationPreferences = require('./notificationPreferences');
  const staff = await notificationPreferences.filterRecipientsForCategory(
    await notificationRecipients.getAllStaffRecipients(),
    notificationPreferences.CATEGORIES.ACTIVITY
  );
  if (staff.length === 0) return { sent: false, reason: 'no_staff_recipients' };

  const emailSubject = `Reply received — estimate follow-up paused (no owner assigned)`;
  const htmlBody = `
    <p>${escapeHtml(clientName)} (${escapeHtml(fromAddr)}) replied to an automated estimate follow-up email, with subject:</p>
    <blockquote style="border-left:3px solid #ccc;margin:0;padding-left:12px;color:#333;">${escapeHtml(subject)}</blockquote>
    <p>This lead has no assigned rep on file, so this is going to staff instead. The automated follow-up sequence has been paused.</p>
    ${leadUrl ? `<p><a href="${leadUrl}">Open this lead in the CRM</a></p>` : '<p>Open this lead in the CRM to respond.</p>'}
  `;
  const results = await Promise.all(staff.map((to) =>
    emailService.send({ to, subject: emailSubject, htmlBody, idempotencyKey: `${idempotencyKey}:${to}`, role: 'estimate_followup_reply' })
      .then(() => ({ to, ok: true }))
      .catch((e) => ({ to, ok: false, error: e.message }))
  ));
  return { sent: results.some((r) => r.ok), results };
}

module.exports = {
  resolveLeadAndOwner,
  notifyReplyDetected,
  replyNotificationsEnabled,
};
