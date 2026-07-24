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

const OFFICE_EMAIL = 'office@ecconstructiongroup.com';
const MICHELLE_EMAIL = 'michelle@ecconstructiongroup.com';
const YARON_EMAIL = 'yaron@ecconstructiongroup.com';
const COMPANY_NAME = 'EC Construction Group';

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
        const token = await gmail.refreshAccessToken();
        const cc = n.notification_type === 'confirm'
          ? [MICHELLE_EMAIL, YARON_EMAIL]
          : n.notification_type === 'reschedule' ? [YARON_EMAIL] : [];
        await gmail.sendEmail(token, {
          to: n.recipient_emails,
          cc,
          subject: n.subject,
          htmlBody: n.body,
          replyTo: OFFICE_EMAIL,
          fromName: COMPANY_NAME,
          fromAddress: OFFICE_EMAIL,
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

module.exports = { enqueueNotification, flushPendingNotifications, OFFICE_EMAIL, MICHELLE_EMAIL, YARON_EMAIL };