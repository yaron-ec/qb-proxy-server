/* eslint-disable no-undef */
/**
 * Reminder customer-action persistence (Railway PostgreSQL only — NO Base44).
 *
 * Exports:
 *  - recordEvent          log a page_opened / button_clicked event
 *  - isConfirmed          per-appointment confirmation idempotency check
 *  - isRescheduled        per-(appointment,date,time,note) idempotency check
 *  - completeConfirm      atomic: insert completed confirm (idempotent) + enqueue notification
 *  - completeReschedule   atomic: insert completed reschedule (idempotent) + enqueue notification
 *  - issueNonce / consumeNonce   one-time CSRF nonces for POST forms
 *
 * Idempotency is enforced by partial UNIQUE indexes on reminder_actions
 * (see schema.sql). The ON CONFLICT DO NOTHING RETURNING pattern yields exactly
 * one completion (and therefore exactly one notification) per appointment /
 * per unique reschedule request.
 */
'use strict';

const crypto = require('crypto');
const notifications = require('./reminderNotifications');

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

async function recordEvent(db, { tokenHash, leadId, apptFp, actionType, eventType, status, note, ip, userAgent }) {
  await db.query(
    `INSERT INTO reminder_actions
       (token_hash, lead_id, appointment_fingerprint, action_type, event_type, status, note, clicked_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tokenHash, leadId, apptFp, actionType, eventType, status || 'pending',
     (note || '').slice(0, 500) || null,
     eventType === 'button_clicked' ? new Date().toISOString() : null,
     ip || null, userAgent || null]
  );
}

async function isConfirmed(db, apptFp) {
  const { rows } = await db.query(
    `SELECT 1 FROM reminder_actions WHERE appointment_fingerprint=$1 AND action_type='confirm' AND event_type='action_completed' LIMIT 1`,
    [apptFp]
  );
  return rows.length > 0;
}

async function completeConfirm(db, { tokenHash, leadId, apptFp, ip, userAgent, notification }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO reminder_actions
         (token_hash, lead_id, appointment_fingerprint, action_type, event_type, status, completed_at, ip, user_agent)
       VALUES ($1,$2,$3,'confirm','action_completed','completed',NOW(),$4,$5)
       ON CONFLICT DO NOTHING RETURNING id`,
      [tokenHash, leadId, apptFp, ip || null, userAgent || null]
    );
    const first = rows.length > 0;
    if (first && notification) {
      await client.query(
        `INSERT INTO reminder_notifications
           (lead_id, appointment_fingerprint, notification_type, assigned_rep, assigned_rep_email, recipient_emails, subject, body, status)
         VALUES ($1,$2,'confirm',$3,$4,$5,$6,$7,'pending')`,
        [leadId, apptFp, notification.assignedRep || null, notification.assignedRepEmail || null,
         notification.recipientEmails, notification.subject, notification.body]
      );
    }
    await client.query('COMMIT');
    return { first };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function completeReschedule(db, { tokenHash, leadId, apptFp, requestedDate, requestedTime, note, noteHash, ip, userAgent, notification }) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO reminder_actions
         (token_hash, lead_id, appointment_fingerprint, action_type, event_type, status,
          requested_date, requested_time, note, note_hash, completed_at, ip, user_agent)
       VALUES ($1,$2,$3,'reschedule','action_completed','completed',$4,$5,$6,$7,NOW(),$8,$9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [tokenHash, leadId, apptFp, requestedDate, requestedTime, (note || '').slice(0, 500) || null,
       noteHash, ip || null, userAgent || null]
    );
    const first = rows.length > 0;
    if (first && notification) {
      await client.query(
        `INSERT INTO reminder_notifications
           (lead_id, appointment_fingerprint, notification_type, assigned_rep, assigned_rep_email, recipient_emails, subject, body, status)
         VALUES ($1,$2,'reschedule',$3,$4,$5,$6,$7,'pending')`,
        [leadId, apptFp, notification.assignedRep || null, notification.assignedRepEmail || null,
         notification.recipientEmails, notification.subject, notification.body]
      );
    }
    await client.query('COMMIT');
    return { first };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── One-time CSRF nonces (hash-only storage) ─────────────────────────────────

async function issueNonce(db, tokenHash) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = sha(raw);
  await db.query(
    `INSERT INTO reminder_form_nonces (nonce_hash, token_hash, expires_at)
     VALUES ($1,$2, NOW() + INTERVAL '10 minutes')`,
    [hash, tokenHash]
  );
  return raw;
}

async function consumeNonce(db, rawNonce, tokenHash) {
  if (!rawNonce) return false;
  const hash = sha(rawNonce);
  const { rows } = await db.query(
    `UPDATE reminder_form_nonces SET consumed_at=NOW()
     WHERE nonce_hash=$1 AND token_hash=$2 AND consumed_at IS NULL AND expires_at > NOW()
     RETURNING id`,
    [hash, tokenHash]
  );
  return rows.length > 0;
}

module.exports = {
  recordEvent, isConfirmed, completeConfirm, completeReschedule,
  issueNonce, consumeNonce, sha,
};