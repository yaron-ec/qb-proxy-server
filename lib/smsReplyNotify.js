/* eslint-disable no-undef */
/**
 * smsReplyNotify — the two notification side effects fired on an ordinary
 * (non-keyword) inbound customer SMS reply, built for the October 2026
 * "COMPLETE META, SOCIAL MEDIA & TWO-WAY APPOINTMENT SMS IMPLEMENTATION"
 * request:
 *
 *   1. notifyAssignedRep / notifyUnmatchedForReview — an email to the lead's
 *      actual assigned rep (resolved via the real owners FK, never the
 *      heuristic firstname@domain guess — the rep's name must never be
 *      invented), or, when the inbound number matched zero or more than one
 *      lead, to staff for manual review instead (never guessed, never
 *      silently dropped).
 *   2. forwardToYaronBestEffort — a MANDATORY SMS copy of every ordinary
 *      inbound reply to a SEPARATE, explicitly-configured number
 *      (SMS_REPLY_FORWARD_TO — NOT hardcoded, see this file's own safety
 *      note below), regardless of which rep owns the lead.
 *
 * Both are gated by the SAME SMS_AUTOMATED_REMINDERS_ENABLED kill switch as
 * the rest of the new automated-SMS surface (lib/booking/bookingService.js,
 * lib/reminderEngine.js) — deploying this code never itself starts sending;
 * an operator must explicitly flip that env var.
 *
 * Idempotency: both are called at most once per unique inbound MessageSid —
 * routes/sms.js's webhook handler already returns early on
 * handleInboundMessage's `duplicate: true` (a redelivered webhook) before
 * either of these is ever reached, so neither needs its own dedup table.
 */
'use strict';

const { query } = require('../db/client');

function smsAutomationEnabled() {
  return process.env.SMS_AUTOMATED_REMINDERS_ENABLED === 'true';
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
  if (!smsAutomationEnabled()) return { sent: false, reason: 'automation_disabled' };
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
  if (!smsAutomationEnabled()) return { sent: false, reason: 'automation_disabled' };
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

/**
 * ── Yaron forward (MANDATORY per the given spec, but a HARD-GATED feature) ──
 *
 * SAFETY NOTE (read before ever setting SMS_REPLY_FORWARD_TO in production):
 * this codebase already hardcodes "(310) 310-4108" / tel:3103104108 in
 * SEVERAL places (lib/reminderEngine.js, lib/actionRouter.js,
 * lib/phoneCallReminders.js, lib/reminderPages.js) as EC Construction
 * Group's PUBLISHED OFFICE PHONE NUMBER shown to customers in reminder
 * emails and action pages. That is NOT, by itself, evidence it is Yaron's
 * own SMS-capable phone — it could be a landline, a front-desk line, or a
 * number that cannot receive SMS at all. Do NOT set SMS_REPLY_FORWARD_TO to
 * that number (or any number) without first confirming directly with Yaron
 * that: (a) it is SMS-capable, (b) it is NOT the same number as
 * TWILIO_FROM/the Messaging Service sender used for outbound customer SMS
 * (see the loop-guard below — forwarding TO your own sending number is at
 * best a no-op, at worst undeliverable or confusing), and (c) Yaron can
 * actually receive texts there today. This function refuses to run at all
 * until SMS_REPLY_FORWARD_TO is explicitly set — there is no hardcoded
 * default destination anywhere in this file.
 */
async function forwardToYaronBestEffort({ customerName, repName, body }) {
  if (!smsAutomationEnabled()) return { sent: false, reason: 'automation_disabled' };
  const destination = process.env.SMS_REPLY_FORWARD_TO;
  if (!destination) return { sent: false, reason: 'not_configured' };

  const smsClient = require('./smsClient');
  const { from: sendingFrom, messagingServiceSid } = smsClient.getCredentials();
  const normalize = (s) => String(s || '').replace(/\D/g, '').slice(-10);
  // LOOP GUARD: refuse if the configured destination normalizes to the SAME
  // number outbound customer SMS is sent FROM — this would be a self-send,
  // not a useful forward, and is exactly the misconfiguration this feature
  // must never silently produce. When sending via a Messaging Service (no
  // bare TWILIO_FROM), the actual sending number is pooled/abstracted and
  // cannot be checked this way — logged as an unverifiable case rather than
  // silently assumed safe.
  if (sendingFrom && normalize(sendingFrom) === normalize(destination)) {
    console.error('[smsReplyNotify] SMS_REPLY_FORWARD_TO matches the outbound customer-SMS sender number — refusing to forward (would be a self-send/loop).');
    return { sent: false, reason: 'destination_equals_sender' };
  }
  if (!sendingFrom && messagingServiceSid) {
    console.warn('[smsReplyNotify] sending via TWILIO_MESSAGING_SERVICE_SID — the actual sender number is pooled and cannot be checked against SMS_REPLY_FORWARD_TO for a self-send loop. Verify manually in the Twilio Console before relying on this.');
  }

  const text = `EC CRM — New Customer Reply\nCustomer: ${customerName || 'Unknown'}\nSales Rep: ${repName || 'Unassigned'}\nMessage: ${body}\n\nOpen the lead in CRM to respond.`;
  try {
    const result = await smsClient.sendMessage({ to: destination, body: text });
    if (!result.ok) return { sent: false, reason: result.errorMessage || 'twilio_rejected' };
    return { sent: true, sid: result.sid };
  } catch (e) {
    console.warn('[smsReplyNotify] Yaron forward failed (non-fatal):', e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = {
  resolveLeadAndOwner,
  notifyAssignedRep,
  notifyUnmatchedForReview,
  forwardToYaronBestEffort,
  smsAutomationEnabled,
};
