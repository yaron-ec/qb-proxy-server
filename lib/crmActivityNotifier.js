/* eslint-disable no-undef */
/**
 * crmActivityNotifier — the CANONICAL CRM admin activity email notification pipeline.
 *
 * One function: notifyCrmActivity() — called by EVERY Railway route that performs
 * a CRM action (lead update, activity create, deal create/update, appointment
 * change, attachment add, contact info change). This is the SINGLE entry point
 * for all admin activity notifications — no route builds or sends its own email.
 *
 * Pipeline:
 *   CRM action (route handler)
 *   → notifyCrmActivity({ action, lead, changes, actor, ... })
 *   → company_settings.crm_activity_notifications_enabled check
 *   → emailTemplates.crmActivityEmail (branded HTML)
 *   → emailService.send (idempotency + retries + delivery logging)
 *   → gmailSender (this installation's connected Gmail mailbox via OAuth)
 *   → email_send_claims / email_send_logs (persisted audit state)
 *
 * Recipients: this installation's company_settings.notification_recipients
 * (see lib/notificationRecipients.js) — EC's row is backfilled to its
 * historical Michelle(to)/Yaron(cc) behavior; a fresh installation defaults
 * to its own admin_email only. Never a hardcoded EC address.
 *
 * Idempotency: key = `crm-act:{action}:{lead_id}:{changeHash}`. The same logical
 * action with the same changes produces the same key → emailService deduplicates.
 * Different changes → different hash → different key → new email (correct).
 *
 * Best-effort (non-blocking): failures are logged but NEVER break the CRM action.
 * The caller's transaction has already committed; a notification failure must not
 * roll back business data. Failed deliveries are visible via email_send_claims
 * (status='failed', last_error) and email_send_logs.
 *
 * No Base44. No frontend. No per-component implementation. One canonical pipeline.
 */
'use strict';

const emailService = require('./emailService');
const templates = require('./emailTemplates');
const { query } = require('../db/client');
const crypto = require('crypto');
const notificationRecipients = require('./notificationRecipients');
const companyConfig = require('./companyConfig');

const CRM_URL = process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com';

// ── Recipient resolution ────────────────────────────────────────────────────
// This installation's configured notification_recipients (to/cc). See
// lib/notificationRecipients.js and db/migrations/2026-45-notification-config.sql.
async function resolveRecipients() {
  const { to, cc } = await notificationRecipients.getRecipients();
  // emailService.send() takes a single primary "to" + a cc[] array — fold
  // any additional configured "to" addresses into cc rather than dropping
  // them.
  return { to: to[0] || null, cc: [...to.slice(1), ...cc] };
}

// ── Feature flag check ──────────────────────────────────────────────────────
async function isNotificationsEnabled() {
  try {
    const { rows } = await query('SELECT crm_activity_notifications_enabled FROM company_settings ORDER BY created_at ASC LIMIT 1');
    return rows[0]?.crm_activity_notifications_enabled === true;
  } catch (e) {
    // If the table/column doesn't exist, default to ENABLED (the user's requirement).
    // The flag is a settings toggle, not a safety interlock — notifications should
    // work out of the box.
    return true;
  }
}

// ── Change hash for idempotency ──────────────────────────────────────────────
// Hash the sorted changes to produce a stable idempotency suffix. The same
// logical action with the same field values → same hash → deduplicated. A
// different value → different hash → new email.
function changeHash(changes) {
  if (!changes || (Array.isArray(changes) && changes.length === 0)) return 'no-changes';
  const sorted = JSON.stringify(changes, Object.keys(changes || {}).sort());
  return crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

// ── Timestamp in this installation's configured timezone ───────────────────
// PRODUCTIZATION PHASE 2: was hardcoded to 'America/Los_Angeles' — now reads
// company_settings.timezone (default unchanged for EC — see
// lib/companyConfig.js's PRODUCT_DEFAULTS).
async function activityTimestamp() {
  const tz = await companyConfig.getTimezone();
  return new Date().toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// ── Action labels (human-readable) ───────────────────────────────────────────
const ACTION_LABELS = {
  lead_created: 'New Lead Created',
  lead_updated: 'Lead Updated',
  lead_status_changed: 'Lead Status Changed',
  contact_info_changed: 'Contact Information Changed',
  activity_added: 'Activity Added',
  appointment_created: 'Appointment Scheduled',
  appointment_rescheduled: 'Appointment Rescheduled',
  appointment_cancelled: 'Appointment Cancelled',
  deal_created: 'New Deal Created',
  deal_updated: 'Deal Updated',
  deal_stage_changed: 'Deal Stage Changed',
  attachment_added: 'Attachment Added',
  estimate_synced: 'Estimate Synced',
};

/**
 * Send a CRM admin activity notification email to this installation's configured recipients.
 *
 * @param {Object} params
 * @param {string} params.action - one of ACTION_LABELS keys
 * @param {string} [params.leadId] - Railway lead UUID (for the CRM link)
 * @param {string} [params.leadName] - "First Last" for the email body
 * @param {string} [params.repName] - assigned rep display name
 * @param {string} [params.actorEmail] - who performed the action (req.user.email)
 * @param {Array}  [params.changes] - [{ label, prev, next }] for field diffs
 * @param {string} [params.content] - note body / activity content
 * @param {string} [params.activityType] - 'note' | 'call' | 'email' | 'meeting' | 'task'
 * @returns {Promise<{ok: boolean, idempotent?: boolean, error?: string}>}
 */
async function notifyCrmActivity({
  action,
  leadId,
  leadName,
  repName,
  actorEmail,
  changes,
  content,
  activityType,
}) {
  if (!action) return { ok: false, error: 'action required' };

  // 1. Feature flag check
  const enabled = await isNotificationsEnabled();
  if (!enabled) {
    return { ok: false, error: 'crm_activity_notifications_disabled' };
  }

  // 2. Build the email
  const label = ACTION_LABELS[action] || action;
  const title = activityType ? `${label}: ${activityType}` : label;
  const { to, cc } = await resolveRecipients();
  if (!to) {
    // No recipient configured at all (no notification_recipients.to and no
    // admin_email) — nothing to send to. Not an error: an installation that
    // hasn't configured this yet simply gets no notification, rather than
    // falling back to any hardcoded address.
    return { ok: false, error: 'no_recipient_configured' };
  }
  const timestamp = await activityTimestamp();

  const html = templates.crmActivityEmail({
    title,
    leadName: leadName || 'Unknown',
    leadId,
    repName: repName || 'Unassigned',
    activityType: activityType || label,
    changes: changes || [],
    content: content || '',
    timestamp,
    crmUrl: CRM_URL,
    actorEmail,
  });

  // 3. Idempotency key — stable per (action, lead, change-content)
  const hash = changeHash(changes || content || action);
  const idempotencyKey = `crm-act:${action}:${leadId || 'no-lead'}:${hash}`;

  // 4. Subject
  const subject = `CRM Activity: ${leadName || 'Unknown'} — ${label}`;

  // 5. Send via emailService (idempotent + retried + logged)
  try {
    const fromName = await notificationRecipients.getSenderName();
    const fromAddress = await notificationRecipients.getSenderAddress();
    const result = await emailService.send({
      to,
      cc,
      subject,
      htmlBody: html,
      idempotencyKey,
      role: 'activity_notification',
      fromName,
      fromAddress,
    });
    return { ok: true, idempotent: result.idempotent, gmailMessageId: result.gmailMessageId };
  } catch (e) {
    // Best-effort: log and return failure, but do NOT throw.
    // The CRM action has already committed; a notification failure must not
    // break the user's workflow. The failure is visible in email_send_claims.
    console.error('[crmActivityNotifier] send failed:', action, e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { notifyCrmActivity, isNotificationsEnabled, resolveRecipients, ACTION_LABELS };