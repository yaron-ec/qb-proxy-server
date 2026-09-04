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
 *   → gmailSender (yaron@ecconstructiongroup.com via Gmail OAuth)
 *   → email_send_claims / email_send_logs (persisted audit state)
 *
 * Recipients: Michelle (to) + Yaron (cc) — always both, never one without the other.
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

const MICHELLE_EMAIL = 'michelle@ecconstructiongroup.com';
const YARON_EMAIL = 'yaron@ecconstructiongroup.com';
const CRM_URL = process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com';

// ── Recipient resolution ────────────────────────────────────────────────────
// Always Michelle (to) + Yaron (cc). If company_settings has a different
// admin_email, we add it to cc as well (but never remove Michelle or Yaron).
async function resolveRecipients() {
  try {
    const { rows } = await query('SELECT admin_email FROM company_settings ORDER BY created_at ASC LIMIT 1');
    const adminEmail = rows[0]?.admin_email;
    const cc = [YARON_EMAIL];
    if (adminEmail && adminEmail !== YARON_EMAIL && adminEmail !== MICHELLE_EMAIL) {
      cc.push(adminEmail);
    }
    return { to: MICHELLE_EMAIL, cc };
  } catch (e) {
    // Settings table unavailable — use defaults
    return { to: MICHELLE_EMAIL, cc: [YARON_EMAIL] };
  }
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

// ── Timestamp in Pacific time ────────────────────────────────────────────────
function pacificTimestamp() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
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
 * Send a CRM admin activity notification email to Michelle + Yaron.
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
  const timestamp = pacificTimestamp();

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
    const result = await emailService.send({
      to,
      cc,
      subject,
      htmlBody: html,
      idempotencyKey,
      role: 'activity_notification',
      fromName: 'EC Construction CRM',
      fromAddress: 'yaron@ecconstructiongroup.com',
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