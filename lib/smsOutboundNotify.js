/* eslint-disable no-undef */
/**
 * smsOutboundNotify — staff email notifications for OUTBOUND customer SMS
 * (manual compose or automated booking-confirmation/12h/2h reminder),
 * built November 2026 after a production incident where two automated
 * reminder SMS sends to lead Manuel Manalo silently failed delivery
 * (Twilio error 30006 — the destination carrier rejected the message, most
 * likely a landline) with no admin ever notified.
 *
 * Two independent notifications, each gated by its own off-by-default env
 * var (same "one flag per independent concern" doctrine already used for
 * SMS_AUTOMATED_REMINDERS_ENABLED / SMS_REPLY_NOTIFICATIONS_ENABLED — see
 * lib/booking/bookingService.js's own header comment on that doctrine):
 *
 *   - notifySmsSent: fired once an outbound SMS has been ACCEPTED by
 *     Twilio for sending (lib/smsService.js#sendSms, right after the
 *     sms_messages row is inserted with `result.ok === true`). Deliberately
 *     never describes this as "delivered" — Twilio accepting a message for
 *     sending is not proof the carrier ever delivered it to the handset.
 *   - notifySmsDeliveryFailure: fired when a PREVIOUSLY-ACCEPTED message's
 *     status callback later reports a terminal 'failed' or 'undelivered'
 *     status (lib/smsService.js#handleStatusCallback) — the caller there is
 *     responsible for only invoking this on a genuine NEW transition into
 *     one of those two statuses, never on a redelivered/duplicate callback
 *     or a callback that doesn't actually change anything (see that
 *     function's own comment for the exact guard).
 *
 * Both route through the SAME existing staff-broadcast machinery every
 * other CRM notification already uses — lib/notificationRecipients.js's
 * getAllStaffRecipients() narrowed by
 * lib/notificationPreferences.js#filterRecipientsForCategory() under two
 * new categories (CATEGORIES.SMS_SENT / CATEGORIES.SMS_DELIVERY_FAILURE).
 * This is why Yaron (no restriction row — every category enabled by the
 * table's own backward-compatible default) receives both, and why
 * Michelle's existing, approved single-category policy is preserved
 * automatically and unchanged: db/migrations/2026-68-sms-outbound-notification-categories.sql
 * adds her an explicit disabled row for these two NEW categories (the same
 * follow-up 2026-62's own header comment calls for), so she is excluded
 * from them exactly as she already is from every other non-new_lead
 * category — no special-casing in this file at all.
 *
 * Idempotency: each email's idempotencyKey is keyed on the message's own
 * Twilio SID (never on time or a counter), per recipient — the SAME
 * DB-backed dedup lib/emailService.js already gives every other
 * notification in this codebase (see lib/smsReplyNotify.js's identical
 * pattern). A redelivered status-callback webhook, or this function somehow
 * being invoked twice for the same message, can never produce a second
 * email for the same lead/message/recipient combination.
 *
 * Never throws: a notification failure must never affect the real SMS
 * send, the claim bookkeeping in lib/reminderEngine.js, or the status
 * callback's 204 response to Twilio — matches every other best-effort
 * notification function in this codebase (lib/smsReplyNotify.js).
 */
'use strict';

const { query } = require('../db/client');
const crmUrl = require('./crmUrl');

function sentNotificationsEnabled() {
  return process.env.SMS_SENT_NOTIFICATIONS_ENABLED === 'true';
}

function deliveryFailureNotificationsEnabled() {
  return process.env.SMS_DELIVERY_FAILURE_NOTIFICATIONS_ENABLED === 'true';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Mirrors crm-frontend/src/lib/smsActivityAdapter.js#smsAuthorLabel exactly
 * (separate packages, no shared module boundary between the Railway backend
 * and the Vite frontend — same duplication precedent as
 * lib/safeReturnTo.js / crm-frontend/src/lib/safeReturnTo.js). Used here as
 * BOTH "sender or automation identity" (notifySmsSent) and "message type"
 * (notifySmsDeliveryFailure) — sent_by already encodes exactly which of
 * those two questions is being asked for an outbound message.
 */
function smsAuthorLabel(sentBy) {
  if (!sentBy) return 'System';
  if (sentBy === 'system:booking_confirmation') return 'Automated — Booking Confirmation';
  if (sentBy.startsWith('system:reminder_12h')) return sentBy.endsWith('_deferred') ? 'Automated — 12h Reminder (deferred)' : 'Automated — 12h Reminder';
  if (sentBy.startsWith('system:reminder_2h')) return sentBy.endsWith('_deferred') ? 'Automated — 2h Reminder (deferred)' : 'Automated — 2h Reminder';
  if (sentBy.startsWith('system:')) return 'Automated';
  return sentBy; // a rep's real email — a manual send
}

async function resolveLeadName(leadId) {
  const { rows } = await query('SELECT first_name, last_name FROM leads WHERE id = $1', [leadId]);
  const row = rows[0];
  if (!row) return null;
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'A customer';
}

/** Fired once an outbound SMS has been ACCEPTED by Twilio for sending.
 * `messageRow` is the exact sms_messages row lib/smsService.js#sendSms just
 * inserted (so it always carries a real twilio_sid, status, sent_by,
 * created_at). Never describes this as delivery — only as acceptance. */
async function notifySmsSent({ leadId, messageRow }) {
  if (!sentNotificationsEnabled()) return { sent: false, reason: 'sms_sent_notifications_disabled' };
  let clientName;
  try {
    clientName = await resolveLeadName(leadId);
  } catch (e) {
    console.warn('[smsOutboundNotify] lead lookup failed (non-fatal):', e.message);
    return { sent: false, reason: e.message };
  }
  if (!clientName) return { sent: false, reason: 'lead_not_found' };

  const notificationRecipients = require('./notificationRecipients');
  const notificationPreferences = require('./notificationPreferences');
  const emailService = require('./emailService');

  const staff = await notificationPreferences.filterRecipientsForCategory(
    await notificationRecipients.getAllStaffRecipients(),
    notificationPreferences.CATEGORIES.SMS_SENT
  );
  if (staff.length === 0) return { sent: false, reason: 'no_staff_recipients' };

  const leadUrl = crmUrl.buildLeadUrl(leadId);
  const senderLabel = smsAuthorLabel(messageRow.sent_by);
  const timestamp = messageRow.created_at ? new Date(messageRow.created_at).toLocaleString('en-US') : new Date().toLocaleString('en-US');
  const subject = `Outbound SMS sent to ${clientName}`;
  const htmlBody = `
    <p>An outbound SMS was <strong>accepted by Twilio for sending</strong> to <strong>${escapeHtml(clientName)}</strong> (acceptance only — this does not confirm the carrier delivered it to the handset).</p>
    <ul>
      <li><strong>Sent by:</strong> ${escapeHtml(senderLabel)}</li>
      <li><strong>Time:</strong> ${escapeHtml(timestamp)}</li>
      <li><strong>Initial status:</strong> ${escapeHtml(messageRow.status || 'queued')}</li>
    </ul>
    ${leadUrl ? `<p><a href="${leadUrl}">Open this lead in the CRM</a></p>` : '<p>Open this lead in the CRM to view the conversation.</p>'}
  `;
  const twilioSid = messageRow.twilio_sid || messageRow.id;
  const results = await Promise.all(staff.map((to) =>
    emailService.send({ to, subject, htmlBody, idempotencyKey: `sms-sent-notify:${twilioSid}:${to}` })
      .then(() => ({ to, ok: true }))
      .catch((e) => ({ to, ok: false, error: e.message }))
  ));
  return { sent: results.some((r) => r.ok), results };
}

/** Fired when a previously-accepted message's status callback reports a
 * terminal 'failed'/'undelivered' status. The CALLER (handleStatusCallback)
 * guarantees this only runs on a genuine new transition — see that
 * function's own comment. Never auto-resends the SMS; this is a
 * notification only. */
async function notifySmsDeliveryFailure({ messageRow }) {
  if (!deliveryFailureNotificationsEnabled()) return { sent: false, reason: 'sms_delivery_failure_notifications_disabled' };
  let clientName;
  try {
    clientName = await resolveLeadName(messageRow.lead_id);
  } catch (e) {
    console.warn('[smsOutboundNotify] lead lookup failed (non-fatal):', e.message);
    return { sent: false, reason: e.message };
  }
  if (!clientName) return { sent: false, reason: 'lead_not_found' };

  const notificationRecipients = require('./notificationRecipients');
  const notificationPreferences = require('./notificationPreferences');
  const emailService = require('./emailService');

  const staff = await notificationPreferences.filterRecipientsForCategory(
    await notificationRecipients.getAllStaffRecipients(),
    notificationPreferences.CATEGORIES.SMS_DELIVERY_FAILURE
  );
  if (staff.length === 0) return { sent: false, reason: 'no_staff_recipients' };

  const leadUrl = crmUrl.buildLeadUrl(messageRow.lead_id);
  const messageType = smsAuthorLabel(messageRow.sent_by);
  const subject = `SMS delivery failed for ${clientName}`;
  const htmlBody = `
    <p>An outbound SMS to <strong>${escapeHtml(clientName)}</strong> was accepted by Twilio but later reported a delivery failure. The SMS was <strong>not</strong> automatically resent.</p>
    <ul>
      <li><strong>Message type:</strong> ${escapeHtml(messageType)}</li>
      <li><strong>Delivery status:</strong> ${escapeHtml(messageRow.status)}</li>
      <li><strong>Error code:</strong> ${escapeHtml(messageRow.error_code || 'none')}</li>
      ${messageRow.error_message ? `<li><strong>Error detail:</strong> ${escapeHtml(messageRow.error_message)}</li>` : ''}
    </ul>
    ${leadUrl ? `<p><a href="${leadUrl}">Open this lead in the CRM</a></p>` : '<p>Open this lead in the CRM to review.</p>'}
  `;
  const twilioSid = messageRow.twilio_sid || messageRow.id;
  const results = await Promise.all(staff.map((to) =>
    emailService.send({ to, subject, htmlBody, idempotencyKey: `sms-delivery-failure-notify:${twilioSid}:${to}` })
      .then(() => ({ to, ok: true }))
      .catch((e) => ({ to, ok: false, error: e.message }))
  ));
  return { sent: results.some((r) => r.ok), results };
}

module.exports = {
  sentNotificationsEnabled,
  deliveryFailureNotificationsEnabled,
  smsAuthorLabel,
  notifySmsSent,
  notifySmsDeliveryFailure,
};
