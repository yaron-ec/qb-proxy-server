/* eslint-disable no-undef */
/**
 * Internal notification queue (Railway PostgreSQL only).
 *
 * Confirmations and reschedule requests enqueue a notification here in the SAME
 * transaction that commits the customer action. Gmail delivery is a SEPARATE
 * path (flushPendingNotifications) invoked AFTER the transaction commits, so a
 * Gmail failure never loses the customer action — the notification stays
 * pending/failed and is retried later.
 *
 * No Base44 anywhere. No raw tokens logged.
 */
'use strict';

const gmail = require('./gmailSender');
const emailService = require('./emailService');
const notificationRecipients = require('./notificationRecipients');
const notificationPreferences = require('./notificationPreferences');
const companyConfig = require('./companyConfig');

// PRODUCTIZATION PHASE 2: OFFICE_EMAIL kept as the historical replyTo
// fallback (env-overridable would be a larger change; office@ is a
// role-mailbox convention, not a named person, so it's lower-risk EC
// residue than MICHELLE_EMAIL/YARON_EMAIL were — see companyConfig usage
// below for the actual recipient/sender resolution).
const OFFICE_EMAIL = process.env.OFFICE_EMAIL || 'office@ecconstructiongroup.com';

async function enqueueNotification(db, {
  leadId, appointmentFingerprint, notificationType,
  assignedRep, assignedRepEmail, recipientEmails, subject, body,
}) {
  await db.query(
    `INSERT INTO reminder_notifications
       (lead_id, appointment_fingerprint, notification_type, assigned_rep,
        assigned_rep_email, recipient_emails, subject, body, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
    [leadId, appointmentFingerprint, notificationType,
     assignedRep || null, assignedRepEmail || null, recipientEmails, subject, body]
  );
}

let _flushing = false;

/**
 * Attempt delivery of pending/failed notifications. Best-effort; safe to call
 * after any customer POST. Gmail credentials/permanent errors → 'failed';
 * transient errors → stay 'pending' with a backoff. Marks 'sent' only after
 * Gmail confirms success. Records attempt_count + last_error.
 */
async function flushPendingNotifications(db, limit = 10) {
  if (_flushing) return { skipped: 'already_flushing' };
  _flushing = true;
  let attempted = 0;
  let sent = 0;
  try {
    const { rows } = await db.query(
      `SELECT * FROM reminder_notifications
       WHERE status IN ('pending','failed') AND next_attempt_at <= NOW()
       ORDER BY created_at LIMIT $1`,
      [limit]
    );
    for (const n of rows) {
      attempted++;
      // Claim atomically.
      const claim = await db.query(
        `UPDATE reminder_notifications SET status='processing', updated_at=NOW()
         WHERE id=$1 AND status IN ('pending','failed') RETURNING id`,
        [n.id]
      );
      if (!claim.rows.length) continue;
      try {
        // 'confirm' → every configured staff recipient (was [Michelle, Yaron]);
        // 'reschedule' → the configured cc list only (was [Yaron] — EC's
        // notification_recipients.cc, preserved exactly via the migration
        // 2026-45 backfill).
        const { cc: staffCc } = await notificationRecipients.getRecipients();
        const rawCc = n.notification_type === 'confirm'
          ? await notificationRecipients.getAllStaffRecipients()
          : n.notification_type === 'reschedule' ? staffCc : [];
        const cc = await notificationPreferences.filterRecipientsForCategory(rawCc, notificationPreferences.CATEGORIES.APPOINTMENT);
        await emailService.send({
          to: n.recipient_emails,
          cc,
          subject: n.subject,
          htmlBody: n.body,
          replyTo: OFFICE_EMAIL,
          fromName: await notificationRecipients.getSenderName(),
          fromAddress: await notificationRecipients.getSenderAddress(),
          idempotencyKey: `notification:${n.id}`,
        });
        await db.query(
          `UPDATE reminder_notifications SET status='sent', sent_at=NOW(), attempt_count=attempt_count+1, last_error=NULL, updated_at=NOW() WHERE id=$1`,
          [n.id]
        );
        sent++;
      } catch (e) {
        const isCred = e instanceof gmail.GmailCredentialsError;
        await db.query(
          `UPDATE reminder_notifications SET status=$2, last_error=$3, attempt_count=attempt_count+1,
              next_attempt_at=NOW() + INTERVAL '15 minutes', updated_at=NOW() WHERE id=$1`,
          [n.id, isCred ? 'failed' : 'pending', (e.message || 'send failed').slice(0, 500)]
        );
      }
    }
    return { attempted, sent };
  } finally {
    _flushing = false;
  }
}

module.exports = { enqueueNotification, flushPendingNotifications, OFFICE_EMAIL };