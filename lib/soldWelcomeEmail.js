/* eslint-disable no-undef */
/**
 * soldWelcomeEmail — automated branded "Welcome to the EC Construction Group
 * Family!" email sent to a customer the moment their lead's status enters
 * 'Sold' (CLAUDE.md "Important business invariants" style module: a
 * standalone, decoupled feature, deliberately NOT sharing code with
 * lib/estimateFollowupEngine.js / lib/estimateFollowupEligibility.js /
 * lib/estimateFollowupActivityLog.js / lib/estimateFollowupReplyNotify.js —
 * those four implement a completely different automation (the 6-email
 * estimate follow-up sequence) and must keep working unmodified regardless
 * of anything this file does; a small amount of locally-duplicated logic
 * (email-format validation, owner-notify-with-staff-broadcast-fallback) is
 * deliberately preferred here over importing those modules, per explicit
 * requirement #13 ("preserve existing ... functionality").
 *
 * Content is the business owner's own exact, approved wording — verbatim,
 * not Claude-authored (same one-time-approval-record precedent as
 * lib/smsTemplates.js / lib/estimateFollowupTemplates.js). See
 * lib/emailTemplates.js#soldWelcomeEmail for the rendered template itself;
 * this module is purely the trigger/idempotency/audit/notify logic around
 * it.
 *
 * ── Idempotency ("send only once per actual sale") ─────────────────────────
 * Two independent layers, belt-and-suspenders:
 *   1. lib/emailService.js's own `email_send_claims` (UNIQUE idempotency_key)
 *      — the idempotency key is `sold-welcome:<lead.id>`, a FIXED value for
 *      the lead's entire lifetime. Once a real send succeeds for a given
 *      lead, this key can never send again for that lead, ever — this is
 *      the actual, race-safe guarantee (a second, concurrent trigger for
 *      the same lead calling emailService.send with the same key always
 *      resolves to `{idempotent:true}` with the original message id, never
 *      a second real Gmail send).
 *   2. This module's own `sold_welcome_emails` table (UNIQUE lead_id) — a
 *      richer audit record (recipient/subject/body/timestamps/
 *      automation-identity/provider-message-id/delivery-status/attempts)
 *      than email_send_claims/email_send_logs capture on their own, AND the
 *      pre-check that avoids even attempting a send once a lead's row is
 *      already 'sent'.
 *
 * ── "Reopened and returned to Sold" (requirement #7) ────────────────────────
 * Deliberate decision: "send only once per actual sale" is interpreted
 * literally — once a lead's `sold_welcome_emails` row reaches 'sent', it
 * NEVER sends again for that lead, no matter how many more times the
 * status leaves and re-enters 'Sold' (there is no separate "deal"/"sale"
 * entity in this schema to distinguish a second, genuinely different sale
 * from the same lead being reopened and re-sold). A lead whose row is
 * 'skipped_no_email'/'skipped_invalid_email'/'failed' (no real send ever
 * happened) DOES get a fresh attempt on a later re-entry into 'Sold' — e.g.
 * a lead with no email on file gets one added, then is marked Sold again —
 * since that is the first REAL opportunity to actually welcome them.
 */
'use strict';

const db = require('../db/client');
const emailTemplates = require('./emailTemplates');
const crmUrl = require('./crmUrl');
// emailService is required LAZILY (inside each function, not at module top
// level) — same convention lib/estimateFollowupReplyNotify.js already uses
// — so a test can swap lib/emailService.js out of the require cache after
// this module has already loaded and still have it take effect.

// Off by default — the AUTOMATIC trigger (routes/leads.js's Sold-entry hook)
// only fires once an operator explicitly sets this to 'true'. An authorized
// admin-triggered send (preview/test/one-time Jacqueline send via
// routes/soldWelcomeEmail.js) deliberately bypasses this gate — it is an
// explicit, human-authorized action on one specific lead, not the automatic
// trigger this flag exists to hold back.
function autoTriggerEnabled() {
  return process.env.SOLD_WELCOME_EMAIL_ENABLED === 'true';
}

// Local, deliberately-duplicated email-format check (see module header for
// why this doesn't import lib/estimateFollowupEligibility.js#isValidEmail).
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
function isValidEmail(email) {
  return !!(email && EMAIL_RE.test(String(email).trim()));
}

/** Edge-detection: fires only on the actual transition INTO 'Sold', never on
 * a no-op edit, never on leaving Sold, never on any other status pair. */
function isEnteringSoldStatus(oldStatus, newStatus) {
  return newStatus === 'Sold' && oldStatus !== 'Sold';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getRecordForLead(leadId) {
  const { rows } = await db.query(`SELECT * FROM sold_welcome_emails WHERE lead_id = $1`, [leadId]);
  return rows[0] || null;
}

async function resolveLeadWithOwner(leadId) {
  const { rows } = await db.query(
    `SELECT l.id, l.first_name, l.last_name, l.email, l.status,
            o.email AS owner_email, o.display_name AS owner_name
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
      WHERE l.id = $1`,
    [leadId]
  );
  return rows[0] || null;
}

async function upsertRecord(leadId, fields) {
  const cols = ['lead_id', 'recipient_email', 'status', 'subject', 'body_html', 'idempotency_key', 'gmail_message_id', 'sent_at', 'error_message', 'triggered_by'];
  const vals = [
    leadId,
    fields.recipient_email ?? null,
    fields.status,
    fields.subject ?? null,
    fields.body_html ?? null,
    fields.idempotency_key ?? null,
    fields.gmail_message_id ?? null,
    fields.sent_at ?? null,
    fields.error_message ?? null,
    fields.triggered_by ?? null,
  ];
  const { rows } = await db.query(
    `INSERT INTO sold_welcome_emails (${cols.join(', ')})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (lead_id) DO UPDATE SET
       recipient_email = EXCLUDED.recipient_email,
       status = EXCLUDED.status,
       subject = EXCLUDED.subject,
       body_html = EXCLUDED.body_html,
       idempotency_key = EXCLUDED.idempotency_key,
       gmail_message_id = COALESCE(EXCLUDED.gmail_message_id, sold_welcome_emails.gmail_message_id),
       sent_at = COALESCE(EXCLUDED.sent_at, sold_welcome_emails.sent_at),
       error_message = EXCLUDED.error_message,
       attempts = sold_welcome_emails.attempts + 1,
       triggered_by = EXCLUDED.triggered_by
     WHERE sold_welcome_emails.status IS DISTINCT FROM 'sent'
     RETURNING *`,
    vals
  );
  if (rows[0]) return rows[0];
  // Conflict existed AND the WHERE guard didn't match (row already 'sent') —
  // return the existing, untouched row rather than nothing.
  return getRecordForLead(leadId);
}

async function logActivity(leadId, content, author) {
  if (!leadId || !content) return;
  try {
    // activities.source CHECK constraint has no 'system' value — 'manual'
    // is this codebase's established convention for an automated note (see
    // routes/signnowWebhook.js's SignNow-auto-decline note).
    await db.query(
      `INSERT INTO activities (lead_id, type, content, author, source, created_at) VALUES ($1, 'note', $2, $3, 'manual', NOW())`,
      [leadId, content, author || 'system:sold_welcome_email']
    );
  } catch (e) {
    console.warn('[soldWelcomeEmail] activity log failed (non-fatal):', e.message);
  }
}

/**
 * Requirement #9 — notify the lead owner (by email, never SMS) of the
 * outgoing welcome email's outcome (sent / skipped / failed). Mirrors
 * lib/estimateFollowupReplyNotify.js's resolve-real-owner-via-FK +
 * staff-broadcast-fallback shape, duplicated locally rather than imported
 * (see module header).
 */
async function notifyOwner(lead, outcomeSubject, outcomeHtml) {
  try {
    const emailService = require('./emailService');
    const leadUrl = crmUrl.buildLeadUrl(lead.id);
    const htmlBody = `${outcomeHtml}${leadUrl ? `<p><a href="${leadUrl}">Open this lead in the CRM</a></p>` : ''}`;
    const idemSuffix = `sold-welcome-notify:${lead.id}:${Date.now()}`;
    if (lead.owner_email) {
      await emailService.send({
        to: lead.owner_email, subject: outcomeSubject, htmlBody,
        idempotencyKey: idemSuffix, role: 'sold_welcome_email_notify',
      });
      return { notified: true, to: lead.owner_email };
    }
    // No owner assigned — broadcast to staff through the existing ACTIVITY
    // notification-preference category (same mechanism/precedent every
    // other no-owner staff broadcast in this codebase already uses).
    const notificationRecipients = require('./notificationRecipients');
    const notificationPreferences = require('./notificationPreferences');
    const staff = await notificationPreferences.filterRecipientsForCategory(
      await notificationRecipients.getAllStaffRecipients(),
      notificationPreferences.CATEGORIES.ACTIVITY
    );
    if (staff.length === 0) return { notified: false, reason: 'no_recipients' };
    await Promise.all(staff.map((to) =>
      emailService.send({ to, subject: outcomeSubject, htmlBody, idempotencyKey: `${idemSuffix}:${to}`, role: 'sold_welcome_email_notify' })
        .catch((e) => console.warn('[soldWelcomeEmail] staff notify failed (non-fatal):', e.message))
    ));
    return { notified: true, to: staff };
  } catch (e) {
    console.warn('[soldWelcomeEmail] owner notify failed (non-fatal):', e.message);
    return { notified: false, reason: e.message };
  }
}

/** Resolves the lead's owner and notifies them — wrapped so a failure at
 * EITHER step (DB lookup or the send itself) can never fail the outcome
 * this function is merely reporting on. */
async function safeNotifyOwner(leadId, subject, html) {
  try {
    const owner = await resolveLeadWithOwner(leadId);
    if (!owner) return { notified: false, reason: 'lead_not_found' };
    return await notifyOwner(owner, subject, html);
  } catch (e) {
    console.warn('[soldWelcomeEmail] owner lookup/notify failed (non-fatal):', e.message);
    return { notified: false, reason: e.message };
  }
}

/**
 * The real worker: validates, sends (or records a skip), persists the
 * audit row, logs an activity note, and notifies the owner. Used by BOTH
 * the automatic trigger (handleLeadEnteringSold, feature-gated) and any
 * authorized manual/admin trigger (NOT feature-gated — an explicit human
 * action on one specific lead). Never throws — every outcome is returned,
 * not raised, so a caller's post-commit hook can safely fire-and-forget.
 */
async function sendWelcomeEmailForLead(lead, { triggeredBy, source } = {}) {
  if (!lead || !lead.id) return { ok: false, reason: 'no_lead' };
  const emailService = require('./emailService');

  const existing = await getRecordForLead(lead.id);
  if (existing && existing.status === 'sent') {
    return { ok: true, alreadySent: true, record: existing };
  }

  const clientName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Customer';
  const email = lead.email;

  if (!email) {
    const record = await upsertRecord(lead.id, { status: 'skipped_no_email', triggered_by: triggeredBy || source || null });
    await logActivity(lead.id, 'Sold welcome email NOT sent — no customer email address on file.', 'system:sold_welcome_email');
    await safeNotifyOwner(lead.id, `Welcome email NOT sent — ${clientName} (no email on file)`,
      `<p>${escapeHtml(clientName)}'s lead was marked Sold, but has no email address on file, so the automatic welcome email could not be sent.</p><p>Please add a valid email address and the welcome email can be sent manually from the lead's record.</p>`);
    return { ok: true, skipped: 'no_email', record };
  }
  if (!isValidEmail(email)) {
    const record = await upsertRecord(lead.id, { status: 'skipped_invalid_email', recipient_email: email, triggered_by: triggeredBy || source || null });
    await logActivity(lead.id, `Sold welcome email NOT sent — the email on file ("${email}") does not look valid.`, 'system:sold_welcome_email');
    await safeNotifyOwner(lead.id, `Welcome email NOT sent — ${clientName} (invalid email)`,
      `<p>${escapeHtml(clientName)}'s lead was marked Sold, but the email on file ("${escapeHtml(email)}") failed basic validation, so the automatic welcome email could not be sent.</p><p>Please correct the email address and the welcome email can be sent manually from the lead's record.</p>`);
    return { ok: true, skipped: 'invalid_email', record };
  }

  const rendered = emailTemplates.soldWelcomeEmail({ firstName: lead.first_name });
  const idempotencyKey = `sold-welcome:${lead.id}`;
  const fromAddress = emailService.defaultSender();

  try {
    const result = await emailService.send({
      to: email,
      subject: rendered.subject,
      htmlBody: rendered.html,
      textBody: rendered.text,
      replyTo: fromAddress,
      idempotencyKey,
      role: 'sold_welcome_email',
    });
    const record = await upsertRecord(lead.id, {
      recipient_email: email, status: 'sent', subject: rendered.subject, body_html: rendered.html,
      idempotency_key: idempotencyKey, gmail_message_id: result.gmailMessageId, sent_at: new Date().toISOString(),
      triggered_by: triggeredBy || source || null,
    });
    await logActivity(lead.id, `Welcome email sent to ${email} (${result.idempotent ? 'already sent previously' : 'Gmail message ' + result.gmailMessageId}).`, 'system:sold_welcome_email');
    // Owner-notify is deliberately OUTSIDE this try's failure semantics —
    // safeNotifyOwner never throws, so a DB/notify hiccup here can never
    // turn an already-successful send into a reported failure.
    const notifyResult = await safeNotifyOwner(lead.id, `Welcome email sent — ${clientName}`,
      `<p>The automated "Welcome to the EC Construction Group Family!" email was sent to <strong>${escapeHtml(clientName)}</strong> (${escapeHtml(email)}) now that their lead is marked Sold.</p>`);
    if (notifyResult.notified) {
      await db.query(`UPDATE sold_welcome_emails SET owner_notified_at = NOW() WHERE lead_id = $1`, [lead.id]).catch(() => {});
    }
    return { ok: true, sent: true, idempotent: !!result.idempotent, gmailMessageId: result.gmailMessageId, record };
  } catch (e) {
    const record = await upsertRecord(lead.id, {
      recipient_email: email, status: 'failed', subject: rendered.subject, body_html: rendered.html,
      idempotency_key: idempotencyKey, error_message: String(e.message || e).slice(0, 1000),
      triggered_by: triggeredBy || source || null,
    });
    await logActivity(lead.id, `Welcome email FAILED to send to ${email}: ${String(e.message || e).slice(0, 300)}`, 'system:sold_welcome_email');
    await safeNotifyOwner(lead.id, `Welcome email FAILED — ${clientName}`,
      `<p>The automated welcome email to <strong>${escapeHtml(clientName)}</strong> (${escapeHtml(email)}) failed to send after retries: ${escapeHtml(String(e.message || e).slice(0, 300))}</p><p>Please check Gmail/System Health, or send the welcome email manually from the lead's record.</p>`);
    return { ok: false, failed: true, error: e.message, record };
  }
}

/** Called from routes/leads.js's Sold-entry edge hook. Gated by
 * SOLD_WELCOME_EMAIL_ENABLED — the automatic trigger does nothing at all
 * until an operator explicitly enables it. */
async function handleLeadEnteringSold(lead, { triggeredBy } = {}) {
  if (!autoTriggerEnabled()) return { ok: true, sent: false, reason: 'feature_disabled' };
  return sendWelcomeEmailForLead(lead, { triggeredBy, source: 'auto_sold_transition' });
}

module.exports = {
  isEnteringSoldStatus,
  autoTriggerEnabled,
  isValidEmail,
  getRecordForLead,
  resolveLeadWithOwner,
  sendWelcomeEmailForLead,
  handleLeadEnteringSold,
};
