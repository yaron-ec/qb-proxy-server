/* eslint-disable no-undef */
/**
 * EmailService — the SINGLE email-sending service for the Railway backend.
 *
 * Every email in the system goes through EmailService.send(). It wraps the
 * one Gmail sender module (lib/gmailSender.js, yaron@ecconstructiongroup.com)
 * and adds:
 *   - idempotency      (email_send_claims, UNIQUE idempotency_key)
 *   - retries          bounded in-process retry with exponential backoff for
 *                     transient errors; credential errors are fatal (no retry)
 *   - delivery logging (email_send_logs, one row per actual Gmail attempt)
 *   - error handling   GmailCredentialsError => claim 'failed', no further sends
 *
 * No other module may call gmailSender.sendEmail directly once this is live.
 * The existing reminder engine / notification flush will be migrated to use
 * this service in a later phase; until then they keep their own (unchanged)
 * paths so production behavior is not altered.
 *
 * Env (server-side only): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
 *   GMAIL_REFRESH_TOKEN, GMAIL_FROM_NAME, GMAIL_FROM_ADDRESS
 *   (GMAIL_FROM_ADDRESS must resolve to yaron@ecconstructiongroup.com).
 */
'use strict';

const db = require('../db/client');
const gmail = require('./gmailSender');

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function defaultSender() {
  return process.env.GMAIL_FROM_ADDRESS || 'yaron@ecconstructiongroup.com';
}
function defaultFromName() {
  return process.env.GMAIL_FROM_NAME || 'EC Construction Group';
}

/**
 * Send exactly one email (to a single primary recipient; cc[] supported).
 * Idempotent on idempotencyKey: a second call with the same key returns the
 * original result without re-sending.
 *
 * @returns { ok, gmailMessageId, idempotent, claimId }
 */
async function send({
  to, cc, replyTo, subject, htmlBody,
  attachments, idempotencyKey, fromName, fromAddress, role, headers, metadata,
}) {
  if (!to) throw new Error('EmailService.send: "to" is required');
  if (!subject) throw new Error('EmailService.send: "subject" is required');
  if (!htmlBody) throw new Error('EmailService.send: "htmlBody" is required');
  if (!idempotencyKey) throw new Error('EmailService.send: "idempotencyKey" is required');

  // Coerce multi-recipient `to` to a single comma-separated string for storage
  // and the To header. EmailService sends one message; multiple To addresses
  // travel in the To header (Phase 3 "Multiple To recipients").
  if (Array.isArray(to)) to = to.filter(Boolean).join(', ');

  await db.ensureSchema();

  // 1. Atomic idempotency claim. ON CONFLICT DO NOTHING: if 0 rows, a prior
  //    call already owns this key.
  const claim = await db.query(
    `INSERT INTO email_send_claims (idempotency_key, status, recipient, subject)
     VALUES ($1, 'processing', $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, status, gmail_message_id`,
    [idempotencyKey, to, subject]
  );

  let claimId;
  if (claim.rows.length) {
    claimId = claim.rows[0].id;
  } else {
    // A previous call owns this key.
    const existing = await db.query(
      `SELECT id, status, gmail_message_id, last_error FROM email_send_claims WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    const row = existing.rows[0];
    if (row && row.status === 'sent') {
      // Duplicate after success — return the original result, do not re-send.
      return { ok: true, idempotent: true, gmailMessageId: row.gmail_message_id, claimId: row.id };
    }
    if (row && row.status === 'failed') {
      // Retry after a prior failure: no email was sent, so re-claim atomically.
      // Only one concurrent retryer wins the UPDATE; the other sees 0 rows.
      const steal = await db.query(
        `UPDATE email_send_claims SET status='processing', updated_at=NOW(), attempts=attempts+1
         WHERE id=$1 AND status='failed' RETURNING id`,
        [row.id]
      );
      if (!steal.rows.length) {
        return { ok: false, idempotent: false, claimId: row.id, error: 'already processing' };
      }
      claimId = steal.rows[0].id;
    } else {
      // status='processing' — a concurrent request is in flight. Do not send.
      return { ok: false, idempotent: false, claimId: row && row.id, error: 'already processing' };
    }
  }

  // NOTE: no metadata-column write. The email_send_claims.metadata column was
  // removed from the schema, so we never issue SQL against it. Audit data lives
  // only in email_send_logs (structured columns) and server logs.

  // 2. Refresh the Gmail access token (fatal on credential error).
  let accessToken;
  try {
    accessToken = await gmail.refreshAccessToken();
  } catch (e) {
    await markFailed(claimId, e, to, subject, cc, replyTo, role, fromName || defaultFromName(), fromAddress || defaultSender());
    if (e instanceof gmail.GmailCredentialsError) throw e;
    throw e;
  }

  // 3. Bounded retry loop.
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await gmail.sendEmail(accessToken, {
        to, cc, replyTo, subject, htmlBody,
        fromName: fromName || defaultFromName(),
        fromAddress: fromAddress || defaultSender(),
        attachments, headers,
      });
      await markSent(claimId, result.id, to, subject, cc, replyTo, role, fromName || defaultFromName(), fromAddress || defaultSender(), attempt);
      return { ok: true, idempotent: false, gmailMessageId: result.id, claimId };
    } catch (e) {
      lastErr = e;
      await logAttempt(claimId, to, subject, cc, replyTo, role, fromName || defaultFromName(), fromAddress || defaultSender(), attempt, null, e.message);
      if (e instanceof gmail.GmailCredentialsError) {
        // Fatal: no retry. Mark claim failed; callers must fix credentials.
        await markFailed(claimId, e, to, subject, cc, replyTo, role, fromName || defaultFromName(), fromAddress || defaultSender());
        throw e;
      }
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
    }
  }

  await markFailed(claimId, lastErr, to, subject, cc, replyTo, role, fromName || defaultFromName(), fromAddress || defaultSender());
  throw lastErr || new Error('EmailService.send failed');
}

async function markSent(claimId, messageId, to, subject, cc, replyTo, role, fromName, fromAddress, attempts) {
  await db.query(
    `UPDATE email_send_claims SET status='sent', gmail_message_id=$2, attempts=$3, sent_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [claimId, messageId, attempts]
  );
  await logAttempt(claimId, to, subject, cc, replyTo, role, fromName, fromAddress, attempts, messageId, null);
}

async function markFailed(claimId, err, to, subject, cc, replyTo, role, fromName, fromAddress) {
  const msg = (err && err.message) || String(err);
  await db.query(
    `UPDATE email_send_claims SET status='failed', last_error=$2, attempts=attempts+1, updated_at=NOW() WHERE id=$1`,
    [claimId, msg.slice(0, 1000)]
  );
  await logAttempt(claimId, to, subject, cc, replyTo, role, fromName, fromAddress, 0, null, msg);
}

async function logAttempt(claimId, to, subject, cc, replyTo, role, fromName, fromAddress, attempts, messageId, error) {
  try {
    await db.query(
      `INSERT INTO email_send_logs (claim_id, idempotency_key, role, recipient, cc, reply_to, sender, subject, gmail_message_id, status, error, attempts)
       SELECT $1, idempotency_key, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       FROM email_send_claims WHERE id = $1`,
      [
        claimId, role || null, to,
        Array.isArray(cc) ? cc : (cc ? [cc] : null),
        replyTo || null,
        `${fromName || ''} <${fromAddress || ''}>`,
        subject, messageId || null,
        error ? 'failed' : 'sent',
        error ? String(error).slice(0, 1000) : null,
        Math.max(1, attempts || 1),
      ]
    );
  } catch (e) {
    console.warn('[emailService] log write failed:', e.message);
  }
}

module.exports = { send, defaultSender, defaultFromName, MAX_ATTEMPTS };