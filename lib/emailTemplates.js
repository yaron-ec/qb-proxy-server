/* eslint-disable no-undef */
/**
 * Email templates — the SINGLE template module for the Railway backend.
 *
 * Pure functions returning HTML strings. No I/O, no Gmail, no Base44.
 * Customer-facing reminder templates already live in lib/reminderEmails.js
 * and are re-exported here so there is ONE import surface for all templates
 * and no duplicated template logic anywhere.
 *
 * Ported from the Base44 email functions (notifyYaronNewWebsiteLead,
 * notifyCRMActivity, notifyStatusChange, sendProjectStatusEmail,
 * sendManualReminder, sendInvoiceEmail) so Railway can render the same
 * branded emails without any Base44 backend function.
 */
'use strict';

const reminderEmails = require('./reminderEmails');

const COMPANY_NAME = 'EC Construction Group';
const LOGO_URL = 'https://media.base44.com/images/public/69f42cee41d29f30bff5c013/cc5db7058_image.png';
const NAVY = '#0B2D5C';
const GOLD = '#C9A227';
const LIGHT = '#F4F6FA';
const TEXT = '#1A1A2E';
const MUTED = '#6B7280';

// Re-export the existing reminder templates (no duplication).
const clientMeetingEmail = reminderEmails.clientMeetingEmail;
const clientPhoneCallEmail = reminderEmails.clientPhoneCallEmail;
const repReminderEmail = reminderEmails.repReminderEmail;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shell(title, inner, banner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(title)}</title></head>
  <body style="margin:0;padding:0;background:#EEF1F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${TEXT};">
    <div style="max-width:620px;margin:0 auto;padding:24px 16px;">
      ${banner ? `<div style="background:#1a7a1a;color:#fff;text-align:center;padding:10px 16px;font-size:12px;font-weight:700;border-radius:8px 8px 0 0;letter-spacing:.5px;">${esc(banner)}</div>` : ''}
      <div style="background:#fff;${banner ? '' : 'border-radius:12px 12px 0 0;'}padding:24px 28px 16px;text-align:center;border-bottom:3px solid ${GOLD};">
        <img src="${LOGO_URL}" alt="EC Construction Group" style="max-width:220px;height:auto;display:block;margin:0 auto;">
      </div>
      <div style="background:#fff;padding:28px 32px;">${inner}</div>
      <div style="background:${NAVY};border-radius:0 0 12px 12px;padding:18px 32px;text-align:center;">
        <div style="color:${GOLD};font-size:14px;font-weight:700;">${esc(COMPANY_NAME)}</div>
        <div style="color:rgba(255,255,255,.65);font-size:11px;margin-top:4px;">Licensed &amp; Insured · Serving Southern &amp; Northern California · (310) 310-4108</div>
      </div>
    </div></body></html>`;
}

function row(label, value) {
  if (!value && value !== 0) return '';
  return `<tr><td style="padding:7px 16px 7px 0;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:${MUTED};white-space:nowrap;vertical-align:top;width:130px;">${esc(label)}</td><td style="padding:7px 0;font-size:14px;color:${TEXT};vertical-align:top;">${value}</td></tr>`;
}

// ── New-lead alert (ported from notifyYaronNewWebsiteLead) ───────────────────
function newLeadAlertEmail({ lead, leadLink, submittedAt }) {
  const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Unknown';
  const loc = [lead.property_address, lead.city].filter(Boolean).join(', ');
  const inner = `
    <h2 style="color:${NAVY};margin:0 0 4px;font-size:20px;">${esc(name)}${lead.city ? ` — ${esc(lead.city)}` : ''}</h2>
    <p style="color:${MUTED};margin:0 0 20px;font-size:13px;">New incoming lead · submitted ${esc(submittedAt)}</p>
    <div style="background:${LIGHT};border-radius:10px;border-left:4px solid ${GOLD};padding:18px 22px;margin-bottom:18px;">
      <table style="width:100%;border-collapse:collapse;">
        ${row('Phone', lead.phone ? `<a href="tel:${esc(lead.phone)}" style="color:${NAVY};">${esc(lead.phone)}</a>` : null)}
        ${row('Email', lead.email ? `<a href="mailto:${esc(lead.email)}" style="color:${NAVY};">${esc(lead.email)}</a>` : null)}
        ${row('Address', loc || null)}
        ${row('Project', lead.project_type || null)}
        ${row('Budget', lead.budget_range || null)}
        ${row('Source', lead.source || null)}
        ${row('Form', lead.form_type || null)}
      </table>
    </div>
    ${lead.message ? `<div style="background:#F0F4FF;border-left:4px solid #3B5FC0;border-radius:8px;padding:14px 18px;margin-bottom:18px;font-size:14px;line-height:1.7;white-space:pre-wrap;">${esc(lead.message)}</div>` : ''}
    <div style="text-align:center;margin-top:22px;"><a href="${esc(leadLink)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:14px 32px;border-radius:6px;">Open Lead in CRM →</a></div>`;
  return shell(`New Incoming Lead: ${name}`, inner, '📥 NEW INCOMING LEAD');
}

// ── CRM activity notification (ported from notifyCRMActivity) ─────────────────
function crmActivityEmail({ title, leadName, leadId, repName, activityType, changes, content, timestamp, crmUrl }) {
  const changeRows = (changes || []).map((c) => `<tr><td style="padding:6px 12px;font-size:12px;font-weight:600;color:${MUTED};">${esc(c.label)}</td><td style="padding:6px 12px;font-size:13px;color:#dc2626;">${esc(c.prev || '—')}</td><td style="padding:6px 12px;font-size:13px;color:#16a34a;">${esc(c.next || '—')}</td></tr>`).join('');
  const leadUrl = leadId ? `${crmUrl}/leads/${leadId}` : `${crmUrl}/leads`;
  const inner = `
    <h2 style="color:${NAVY};margin:0 0 14px;font-size:18px;">${esc(title)}</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      ${row('Lead', leadName ? `<strong style="color:${NAVY};">${esc(leadName)}</strong>` : null)}
      ${row('Sales Rep', repName || null)}
      ${row('Activity', activityType || null)}
      ${row('Time', timestamp || null)}
    </table>
    ${changeRows ? `<div style="margin-bottom:16px;"><p style="font-size:11px;font-weight:700;color:${MUTED};text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">Changes</p><table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;"><thead><tr style="background:#f8fafc;"><th style="padding:6px 12px;text-align:left;font-size:11px;color:#64748b;">Field</th><th style="padding:6px 12px;text-align:left;font-size:11px;color:#dc2626;">Before</th><th style="padding:6px 12px;text-align:left;font-size:11px;color:#16a34a;">After</th></tr></thead><tbody>${changeRows}</tbody></table></div>` : ''}
    ${content ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;white-space:pre-wrap;">${esc(String(content).slice(0, 800))}</div>` : ''}
    <div style="text-align:center;"><a href="${esc(leadUrl)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:12px 28px;border-radius:6px;">View Lead in CRM →</a></div>`;
  return shell(title, inner);
}

// ── Status-change email to customer (ported from notifyStatusChange / sendProjectStatusEmail) ──
function statusChangeEmail({ clientName, itemName, oldStatus, newStatus, crmUrl }) {
  const inner = `
    <h2 style="color:${NAVY};margin:0 0 10px;font-size:18px;">Status Update: ${esc(itemName)}</h2>
    <p style="font-size:14px;line-height:1.7;">Hello ${esc(clientName)},</p>
    <p style="font-size:14px;line-height:1.7;">The status of your item has been updated.</p>
    <div style="background:${LIGHT};border-radius:8px;border-left:4px solid ${GOLD};padding:14px 20px;margin:16px 0;font-size:14px;">
      <div><strong>Previous:</strong> ${esc(oldStatus || 'N/A')}</div>
      <div><strong>New:</strong> ${esc(newStatus)}</div>
    </div>
    <p style="font-size:13px;color:${MUTED};">Thank you for your business.</p>`;
  return shell(`Status Update: ${itemName}`, inner);
}

// ── Invoice email (ported from sendInvoiceEmail) ─────────────────────────────
function invoiceEmail({ clientName, invoiceNumber, amount, projectType }) {
  const inner = `
    <h2 style="color:${NAVY};margin:0 0 10px;font-size:18px;">Your Invoice from ${esc(COMPANY_NAME)}</h2>
    <p style="font-size:14px;line-height:1.7;">Hello ${esc(clientName)},</p>
    <p style="font-size:14px;line-height:1.7;">Attached is your invoice.</p>
    <div style="background:${LIGHT};border-radius:8px;border-left:4px solid ${GOLD};padding:14px 20px;margin:16px 0;font-size:14px;">
      <div><strong>Invoice #:</strong> ${esc(invoiceNumber)}</div>
      <div><strong>Amount:</strong> $${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
      <div><strong>Project:</strong> ${esc(projectType || 'N/A')}</div>
    </div>
    <p style="font-size:13px;color:${MUTED};">Thank you,<br>${esc(COMPANY_NAME)}</p>`;
  return shell(`Invoice #${invoiceNumber}`, inner);
}

// ── Manual reminder (ported from sendManualReminder) ──────────────────────────
function manualCustomerReminderEmail({ firstName, date, time, address, projectType, ownerName }) {
  const inner = `
    <h2 style="color:${NAVY};margin:0 0 10px;font-size:18px;">Appointment Reminder</h2>
    <p style="font-size:14px;line-height:1.7;">Hi ${esc(firstName)}, this is a reminder from <strong>${esc(ownerName)}</strong> at ${esc(COMPANY_NAME)}.</p>
    <div style="background:${LIGHT};border-radius:8px;border-left:4px solid ${GOLD};padding:14px 20px;margin:16px 0;font-size:14px;">
      <div><strong>Date:</strong> ${esc(date)}</div>
      <div><strong>Time:</strong> ${esc(time)}</div>
      ${address ? `<div><strong>Address:</strong> ${esc(address)}</div>` : ''}
      ${projectType ? `<div><strong>Project:</strong> ${esc(projectType)}</div>` : ''}
    </div>
    <p style="font-size:13px;color:${MUTED};">To reschedule, contact us at (310) 310-4108.</p>`;
  return shell('Appointment Reminder', inner);
}

function manualStaffReminderEmail({ ownerName, clientName, clientPhone, clientEmail, date, time, address, projectType, notes, leadId, crmUrl }) {
  const inner = `
    <h2 style="color:${NAVY};margin:0 0 10px;font-size:18px;">📅 Manual Appointment Reminder</h2>
    <p style="font-size:14px;line-height:1.7;">Hello ${esc(ownerName)}, this is a manual reminder for your upcoming appointment.</p>
    <div style="background:${LIGHT};border-radius:8px;border-left:4px solid ${GOLD};padding:14px 20px;margin:16px 0;font-size:14px;">
      <div><strong>Customer:</strong> ${esc(clientName)}</div>
      <div><strong>Date:</strong> ${esc(date)} &nbsp; <strong>Time:</strong> ${esc(time)}</div>
      ${address ? `<div><strong>Address:</strong> ${esc(address)}</div>` : ''}
      ${projectType ? `<div><strong>Project:</strong> ${esc(projectType)}</div>` : ''}
      <div><strong>Phone:</strong> ${esc(clientPhone)}</div>
      <div><strong>Email:</strong> ${esc(clientEmail)}</div>
    </div>
    ${notes ? `<div style="background:#F0F4FF;border-left:4px solid #3B5FC0;border-radius:8px;padding:12px 16px;font-size:13px;white-space:pre-wrap;margin:12px 0;">${esc(notes)}</div>` : ''}
    <div style="text-align:center;"><a href="${esc(crmUrl)}/leads/${esc(leadId)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:12px 28px;border-radius:6px;">Open Lead in CRM</a></div>`;
  return shell(`Manual Reminder: ${clientName}`, inner);
}

module.exports = {
  // reminder templates (re-exported, no duplication)
  clientMeetingEmail,
  clientPhoneCallEmail,
  repReminderEmail,
  // new templates
  newLeadAlertEmail,
  crmActivityEmail,
  statusChangeEmail,
  invoiceEmail,
  manualCustomerReminderEmail,
  manualStaffReminderEmail,
  COMPANY_NAME,
};