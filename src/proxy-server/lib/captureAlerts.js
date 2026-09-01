/* eslint-disable no-undef */
/**
 * captureAlerts — new-lead alert for the public capture flow.
 *
 * Wires a successful Railway capture into the EXISTING Railway email
 * infrastructure (lib/emailService.js + lib/emailTemplates.js). This is the
 * Railway-owned equivalent of the Base44 notifyYaronNewWebsiteLead automation.
 *
 * Contract:
 *   - BEST-EFFORT, NON-FATAL. A failure here NEVER rolls back the lead or
 *     appointment (caller invokes this AFTER the booking tx commits).
 *   - Uses EmailService.send() which is idempotent on idempotencyKey, so a
 *     retry/duplicate capture never double-sends.
 *   - Deterministic idempotency key: capture-new-lead-alert:<leadId> per
 *     recipient. Safe across worker retries.
 *   - No Base44 email function is used.
 *
 * Recipients match notifyYaronNewWebsiteLead exactly:
 *   yaron@ecconstructiongroup.com, michelle@ecconstructiongroup.com
 */
'use strict';

const emailService = require('./emailService');
const { newLeadAlertEmail } = require('./emailTemplates');

const ALERT_RECIPIENTS = [
  'yaron@ecconstructiongroup.com',
  'michelle@ecconstructiongroup.com',
];

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }) + ' PT';
  } catch { return String(iso); }
}

/**
 * Send the new-lead alert to Yaron + Michelle. Best-effort: logs failures,
 * never throws. Caller must NOT await this as a gate for the HTTP response.
 *
 * @param {object} lead - the created Railway lead row (with first_name,
 *                        last_name, email, phone, city, property_address,
 *                        project_type, budget_range, source, message, id)
 * @param {string} crmPublicUrl - base URL for the CRM lead link
 */
async function sendNewLeadAlert(lead, crmPublicUrl) {
  if (!lead || !lead.id) return;
  const leadLink = `${crmPublicUrl || ''}/leads/${lead.id}`.replace(/\/+$/, '');
  const submittedAt = fmtDateTime(lead.created_at || new Date().toISOString());
  const htmlBody = newLeadAlertEmail({ lead, leadLink, submittedAt });
  const subject = `📥 New Incoming Lead: ${lead.first_name || ''} ${lead.last_name || ''}`.trim() + (lead.city ? ` — ${lead.city}` : '');

  for (const to of ALERT_RECIPIENTS) {
    try {
      await emailService.send({
        to,
        subject,
        htmlBody,
        idempotencyKey: `capture-new-lead-alert:${lead.id}:${to}`,
        role: 'new-lead-alert',
      });
    } catch (e) {
      // Best-effort: log and continue. Never fail the capture over an alert.
      console.warn(`[capture-alerts] new-lead alert to ${to} failed (non-fatal):`, e.message);
    }
  }
}

module.exports = { sendNewLeadAlert, ALERT_RECIPIENTS };