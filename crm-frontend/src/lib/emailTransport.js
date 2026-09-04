/**
 * emailTransport — the SINGLE shared frontend email transport adapter.
 *
 * MIGRATION-OWNERSHIP MODEL (Approach A — NO browser delegation):
 *   Each email flow is owned by exactly ONE backend, declared in FLOW_OWNERSHIP
 *   below. The adapter calls that backend DIRECTLY:
 *     - 'base44'  -> the existing Base44 function (unchanged production path).
 *     - 'railway' -> Railway POST /api/v1/emails/send (JWT-authenticated).
 *   The browser never receives `delegate:true` and never calls Base44 after
 *   Railway decided. There is no runtime two-backend delegation protocol. At
 *   cutover a flow's owner flips to 'railway' here AND its Base44 trigger/
 *   automation is disabled in the same change.
 *
 *   While a flow is 'base44' the UI calls the Base44 function directly (today's
 *   behavior). While 'railway' the UI calls Railway only. The browser does not
 *   "ask Railway then delegate to Base44".
 *
 *   Railway-bound flows call POST /api/v1/emails/send with a Railway JWT
 *   (Authorization: Bearer <jwt>). No X-Proxy-Secret, no VITE_QB_PROXY_SECRET
 *   is ever sent from the browser. The JWT is provisioned on first send via
 *   migrateFromBase44 (Base44 token → Railway JWT exchange). If a Railway
 *   error occurs the adapter throws; it NEVER silently falls back to Base44
 *   (prevents duplicate sends).
 *
 * IDEMPOTENCY:
 *   Keys are deterministic (src/lib/idempotencyKeys.mjs): no Date.now, no
 *   Math.random, no crypto.randomUUID. Generic send REQUIRES a stable
 *   clientRequestId; absent -> throws (no silent random fallback).
 *
 * SAFE LOGGING:
 *   Logs request ID, idempotency key, recipient count, Railway response status,
 *   Gmail message ID, and whether the request was idempotent. Never logs
 *   PROXY_SECRET, OAuth tokens, Gmail client secret, complete email body, or
 *   sensitive customer data.
 */
import * as railwayApi from '@/lib/railwayApi';
import { appParams } from '@/lib/app-params';
import { IdempotencyKeys } from '@/lib/idempotencyKeys';
import {
  manualStaffReminderHtml,
  manualCustomerReminderHtml,
  invoiceEmailHtml,
  testEmailHtml,
} from '@/lib/crmEmailTemplates';
import * as railwayLeads from '@/api/railway/leads';
import * as railwayActivities from '@/api/railway/activities';
import * as railwayInvoices from '@/api/railway/invoices';
import * as railwayLeadAttachments from '@/api/railway/leadAttachments';
import { RAILWAY_API_URL } from '@/lib/apiConfig';

export { IdempotencyKeys };

// ── Safe logging ────────────────────────────────────────────────────────────
// Generates a short request ID for correlation. Does NOT expose secrets or PII.
let _reqCounter = 0;
function nextReqId() { _reqCounter = (_reqCounter + 1) % 1e9; return `crm-email-${Date.now().toString(36)}-${_reqCounter}`; }

function safeLog(event, data) {
  try {
    const payload = { event, ts: new Date().toISOString(), ...data };
    // Never include: PROXY_SECRET, tokens, full body, customer PII beyond count
    console.log(JSON.stringify(payload));
  } catch (_) { /* never let logging throw */ }
}

// ── Per-flow ownership ──────────────────────────────────────────────────────
// This is the single cutover switch. All flows are now 'railway' — email goes
// through POST /api/v1/emails/send with a Railway JWT. The 'base44' branches
// are kept as fallback code (not deleted) but are NOT used.
export const FLOW_OWNERSHIP = {
  GENERIC: 'railway',
  INVOICE: 'railway',
  MANUAL_REMINDER: 'railway',
  APPOINTMENT_REMINDER_PANEL: 'railway',
  TEST: 'railway',
  // Scheduled/phone/task reminders are NOT user-triggered from the browser —
  // they run on the Railway cron worker, gated by EMAIL_*_TRANSPORT. No
  // browser send path exists for them, so they are not listed here.
};

// ── Railway /api/v1/emails/send helper (JWT-authenticated) ──────────────────
/**
 * Send one email through Railway POST /api/v1/emails/send with a Railway JWT.
 * No X-Proxy-Secret is sent from the browser. The JWT is provisioned on first
 * send via migrateFromBase44 (Base44 token → Railway JWT exchange).
 * @returns { ok, gmailMessageId, idempotent, claimId }
 * @throws on any error — NEVER falls back to Base44 (prevents duplicate sends).
 */
async function sendViaRailway({ to, cc, replyTo, subject, htmlBody, attachments, idempotencyKey, role }) {
  if (!idempotencyKey) throw new Error('sendViaRailway: idempotencyKey is required');
  const reqId = nextReqId();
  const toList = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  const ccList = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? [cc] : []);

  // Ensure Railway JWT session exists (provisions on first send via Base44
  // token exchange — browser never holds PROXY_SECRET, only the Railway JWT).
  if (!railwayApi.isLoggedIn()) {
    if (!appParams.token) throw new Error('Railway session not established — sign in to send email');
    await railwayApi.migrateFromBase44(appParams.token);
  }

  safeLog('railway_send_start', {
    reqId,
    idempotencyKey,
    recipientCount: toList.length,
    ccCount: ccList.length,
    hasAttachments: !!(attachments && attachments.length),
    role: role || 'generic',
  });

  const body = {
    to: toList,
    subject,
    htmlBody,
    idempotencyKey,
  };
  if (ccList.length) body.cc = ccList;
  if (replyTo) body.replyTo = replyTo;
  if (attachments && attachments.length) body.attachments = attachments;
  // /api/v1/emails/send derives role from metadata.template_key (not a top-level role field)
  if (role) body.metadata = { template_key: role };

  let result;
  try {
    result = await railwayApi.apiCall('/api/v1/emails/send', { body });
  } catch (e) {
    safeLog('railway_send_error', {
      reqId,
      idempotencyKey,
      status: e.status || null,
      error: String(e.message || e).slice(0, 200),
    });
    throw e;
  }

  safeLog('railway_send_ok', {
    reqId,
    idempotencyKey,
    ok: !!result.ok,
    idempotent: !!result.idempotent,
    gmailMessageId: result.gmailMessageId || null,
    claimId: result.claimId || null,
  });

  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function primaryRecipient(to) { return Array.isArray(to) ? to[0] : to; }
function firstAttachment(attachments) { return Array.isArray(attachments) ? attachments[0] : attachments; }

const MICHELLE_EMAIL = 'michelle@ecconstructiongroup.com';
const YARON_EMAIL = 'yaron@ecconstructiongroup.com';
const CRM_PUBLIC_URL = (typeof window !== 'undefined' && window.location && window.location.origin) || 'https://crm.ecconstructiongroup.com';

function resolveOwnerEmail(ownerName) {
  if (!ownerName) return MICHELLE_EMAIL;
  const first = String(ownerName).trim().split(/\s+/)[0].toLowerCase();
  if (first === 'mickey' || first === 'micky') return 'micky@ecconstructiongroup.com';
  return first ? `${first}@ecconstructiongroup.com` : MICHELLE_EMAIL;
}

function fmt12(t) {
  if (!t) return '';
  const clean = String(t).replace(/\s*(AM|PM)/i, '').trim();
  const [h, m] = clean.split(':').map(Number);
  if (isNaN(h)) return t;
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

// ── GENERIC ─────────────────────────────────────────────────────────────────
export async function sendGenericEmail({ to, cc, replyTo, subject, htmlBody, attachments, leadId, clientRequestId, metadata }) {
  if (!to || !subject || !htmlBody) throw new Error('to, subject, htmlBody required');
  const recipient = primaryRecipient(to);
  const key = (metadata && metadata.idempotencyKey) || IdempotencyKeys.generic(leadId, recipient, clientRequestId);
  if (!clientRequestId && !(metadata && metadata.idempotencyKey)) {
    throw new Error('sendGenericEmail: clientRequestId (stable per logical action) is required for idempotency');
  }

  if (FLOW_OWNERSHIP.GENERIC === 'railway') {
    const att = firstAttachment(attachments);
    return sendViaRailway({
      to: recipient, cc, replyTo, subject, htmlBody,
      attachments: att ? [att] : undefined,
      idempotencyKey: key, role: 'generic',
    });
  }
  // Base44 fallback removed — all flows are Railway-owned.
  throw new Error('GENERIC email flow is Railway-owned; Base44 fallback has been removed.');
}

// ── INVOICE ──────────────────────────────────────────────────────────────────
export async function sendInvoiceEmail(invoiceId, { recipient, version } = {}) {
  if (FLOW_OWNERSHIP.INVOICE === 'railway') {
    // Client-side data lookup via Railway API (replaces Base44 entity reads)
    const invoiceRes = await railwayInvoices.get(invoiceId);
    const invoice = invoiceRes?.invoice || invoiceRes;
    if (!invoice) throw new Error('Invoice not found');
    const leadRes = invoice.lead_id ? await railwayLeads.get(invoice.lead_id) : null;
    const lead = leadRes?.lead || leadRes;
    if (!lead) throw new Error('Lead not found for invoice');

    // Collect recipients — Customer & Sales Rep only (NOT office), same as Base44
    const recipients = [];
    if (lead.email) recipients.push(lead.email);
    if (lead.assigned_rep && lead.assigned_rep !== lead.email) {
      const ownerEmail = resolveOwnerEmail(lead.assigned_rep);
      if (ownerEmail && !recipients.includes(ownerEmail)) recipients.push(ownerEmail);
    }
    if (recipient) {
      // Override with explicit recipient if provided
      recipients.length = 0;
      recipients.push(recipient);
    }
    if (recipients.length === 0) throw new Error('No customer or sales rep email found');

    // Fetch QB PDF via Railway proxy (JWT-authenticated, no proxy secret from browser)
    let attachment = null;
    try {
      const proxyUrl = RAILWAY_API_URL;
      if (proxyUrl && invoice.qb_invoice_id) {
        const token = localStorage.getItem('railway_access_token') || '';
        const pdfRes = await fetch(`${proxyUrl}/invoices/${invoice.qb_invoice_id}/pdf`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' },
        });
        if (pdfRes.ok) {
          const buf = await pdfRes.arrayBuffer();
          attachment = {
            filename: `Invoice-${invoice.qb_invoice_number || invoice.qb_invoice_id}.pdf`,
            contentType: 'application/pdf',
            contentBase64: btoa(String.fromCharCode(...new Uint8Array(buf))),
          };
        }
      }
    } catch (pdfError) {
      console.warn('[emailTransport] Failed to fetch invoice PDF:', pdfError.message);
    }

    const invoiceNumber = invoice.qb_invoice_number || invoice.invoice_number;
    const subject = `EC Construction Group Invoice #${invoiceNumber}`;
    const htmlBody = invoiceEmailHtml({
      firstName: lead.first_name,
      invoiceNumber,
      amount: invoice.amount,
      projectType: lead.project_type,
    });

    // Send to each recipient separately (preserves per-recipient idempotency)
    const results = [];
    for (const to of recipients) {
      const key = IdempotencyKeys.invoice(invoiceId, to, version);
      try {
        const r = await sendViaRailway({
          to, subject, htmlBody,
          attachments: attachment ? [attachment] : undefined,
          idempotencyKey: key, role: 'invoice',
        });
        results.push({ email: to, ok: !!r.ok, gmailMessageId: r.gmailMessageId, idempotent: r.idempotent });
      } catch (e) {
        results.push({ email: to, ok: false, error: e.message });
      }
    }

    // Update invoice with email status via Railway API
    const allOk = results.every(r => r.ok);
    const failedRecipients = results.filter(r => !r.ok);
    const emailStatus = failedRecipients.length === 0 ? 'sent' : 'failed';
    const emailError = failedRecipients.length > 0
      ? `Failed to send to: ${failedRecipients.map(r => r.email).join(', ')}`
      : null;
    try {
      await railwayInvoices.update(invoiceId, {
        email_sent_date: new Date().toISOString(),
        email_recipients: recipients,
        email_delivery_status: emailStatus,
        email_error: emailError,
        email_resend_count: (invoice.email_resend_count || 0) + 1,
      });
    } catch (e) { console.warn('[emailTransport] Failed to update invoice email status:', e.message); }

    // Save PDF to lead attachments via Railway API
    if (attachment && results.some(r => r.ok)) {
      try {
        const dataUrl = `data:application/pdf;base64,${attachment.contentBase64}`;
        await railwayLeadAttachments.create({
          lead_id: invoice.lead_id,
          file_name: attachment.filename,
          file_url: dataUrl,
          file_type: 'application/pdf',
          uploaded_by: 'system',
          qb_invoice_id: invoice.qb_invoice_id,
          qb_invoice_number: invoice.qb_invoice_number,
          invoice_amount: invoice.amount,
          invoice_date: new Date().toISOString().split('T')[0],
        });
      } catch (attachError) {
        console.warn('[emailTransport] Failed to save PDF attachment:', attachError.message);
      }
    }

    return {
      success: allOk,
      sent_to: results.filter(r => r.ok).length,
      total: recipients.length,
      failed: failedRecipients,
      attached: !!attachment,
    };
  }
  // Base44 fallback removed — all flows are Railway-owned.
  throw new Error('INVOICE email flow is Railway-owned; Base44 fallback has been removed.');
}

// ── MANUAL REMINDER ──────────────────────────────────────────────────────────
export async function sendManualReminder(leadId, { scheduledStart } = {}) {
  if (FLOW_OWNERSHIP.MANUAL_REMINDER === 'railway') {
    // Client-side data lookup via Railway API (replaces Base44 entity read)
    const leadRes = await railwayLeads.get(leadId);
    const lead = leadRes?.lead || leadRes;
    if (!lead) throw new Error('Lead not found');

    const hasFollowUp = lead.follow_up_date && lead.follow_up_type;
    const apptDate = hasFollowUp ? lead.follow_up_date : lead.appointment_date;
    const apptTime = hasFollowUp ? (lead.follow_up_time || '09:00') : (lead.appointment_time || '09:00');
    if (!apptDate) throw new Error('No appointment date on this lead');

    const clientName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
    const ownerName = lead.assigned_rep || 'Yaron Drilevich';
    const ownerEmail = resolveOwnerEmail(lead.assigned_rep);
    const address = [lead.property_address, lead.city].filter(Boolean).join(', ') || '';
    const dateFormatted = formatDate(apptDate);
    const timeFormatted = fmt12(apptTime);

    const staffRecipients = Array.from(new Set([ownerEmail, MICHELLE_EMAIL, YARON_EMAIL]));
    const staffSubject = `Manual Reminder: ${clientName} — ${dateFormatted} at ${timeFormatted}`;
    const staffHtml = manualStaffReminderHtml({
      ownerName, clientName,
      clientPhone: lead.phone || 'N/A',
      clientEmail: lead.email || 'N/A',
      date: dateFormatted, time: timeFormatted,
      address, projectType: lead.project_type || '',
      notes: lead.notes || '', leadId: lead.id, crmUrl: CRM_PUBLIC_URL,
    });

    const results = { staff: [], customer: null };

    // Send to all staff
    for (const recipient of staffRecipients) {
      const key = IdempotencyKeys.manualReminder(leadId, recipient, 'staff', scheduledStart || apptDate);
      try {
        const r = await sendViaRailway({
          to: recipient, subject: staffSubject, htmlBody: staffHtml,
          idempotencyKey: key, role: 'staff',
        });
        results.staff.push({ email: recipient, status: 'sent', ok: !!r.ok, gmailMessageId: r.gmailMessageId });
      } catch (e) {
        results.staff.push({ email: recipient, status: 'failed', error: e.message });
      }
    }

    // Send to customer if email exists and not opted out
    if (lead.customer_reminders_disabled) {
      results.customer = { status: 'skipped', reason: 'customer opted out' };
    } else if (lead.email) {
      const custSubject = `Appointment Reminder — EC Construction Group`;
      const custHtml = manualCustomerReminderHtml({
        firstName: lead.first_name || 'there',
        date: dateFormatted, time: timeFormatted,
        address, projectType: lead.project_type || '',
        ownerName,
      });
      const key = IdempotencyKeys.manualReminder(leadId, lead.email, 'customer', scheduledStart || apptDate);
      try {
        const r = await sendViaRailway({
          to: lead.email,
          cc: [MICHELLE_EMAIL, YARON_EMAIL],
          replyTo: ownerEmail,
          subject: custSubject, htmlBody: custHtml,
          idempotencyKey: key, role: 'customer',
        });
        results.customer = { email: lead.email, status: 'sent', ok: !!r.ok, gmailMessageId: r.gmailMessageId };
      } catch (e) {
        results.customer = { email: lead.email, status: 'failed', error: e.message };
      }
    } else {
      results.customer = { status: 'skipped', reason: 'No email address on lead' };
    }

    // Log to Activity for audit trail (same as Base44 function)
    const staffSent = results.staff.filter(r => r.status === 'sent').length;
    const staffFailed = results.staff.filter(r => r.status === 'failed').length;
    const allOk = staffFailed === 0 && results.customer?.status !== 'failed';
    const summary = [
      `Staff: ${staffSent}/${results.staff.length} sent`,
      results.customer?.status === 'sent' ? 'Customer: sent' :
      results.customer?.status === 'skipped' ? `Customer: skipped (${results.customer.reason})` :
      results.customer?.status === 'failed' ? `Customer: failed — ${results.customer.error}` : '',
    ].filter(Boolean).join(' · ');

    await railwayActivities.create({
      lead_id: leadId,
      type: 'note',
      content: `MANUAL_REMINDER_SENT: ${summary}`,
      author: 'System',
      source: 'manual',
    }).catch(() => {});

    return { data: { success: allOk, message: summary, results } };
  }
  // Base44 fallback removed — all flows are Railway-owned.
  throw new Error('MANUAL_REMINDER email flow is Railway-owned; Base44 fallback has been removed.');
}

// ── APPOINTMENT REMINDER PANEL ───────────────────────────────────────────────
export async function sendAppointmentReminder({ recipients, subject, htmlBody, leadId, apptDate, apptTime }) {
  const list = [...new Set((recipients || []).filter(Boolean))];
  const clientRequestId = `appt:${leadId || 'nolead'}:${apptDate || ''}:${apptTime || ''}`;
  let sent = 0;
  for (const to of list) {
    try {
      if (FLOW_OWNERSHIP.APPOINTMENT_REMINDER_PANEL === 'railway') {
        await sendViaRailway({
          to, subject, htmlBody,
          idempotencyKey: IdempotencyKeys.generic(leadId || 'appt-panel', to, clientRequestId),
          role: 'appointment-reminder',
        });
      } else {
        // Base44 fallback removed — all flows are Railway-owned.
        throw new Error('APPOINTMENT_REMINDER email flow is Railway-owned.');
      }
      sent++;
    } catch (_) { /* per-recipient best-effort */ }
  }
  return sent;
}

// ── TEST ─────────────────────────────────────────────────────────────────────
export async function sendTestEmail(to, nonce) {
  if (FLOW_OWNERSHIP.TEST === 'railway') {
    const key = IdempotencyKeys.test(to, nonce);
    const htmlBody = testEmailHtml(nonce);
    return sendViaRailway({
      to, subject: 'EC Construction Group — Test Email',
      htmlBody, idempotencyKey: key, role: 'test',
    });
  }
  // Base44 fallback removed — all flows are Railway-owned.
  throw new Error('TEST email flow is Railway-owned; Base44 fallback has been removed.');
}

export default {
  IdempotencyKeys,
  FLOW_OWNERSHIP,
  sendGenericEmail,
  sendInvoiceEmail,
  sendManualReminder,
  sendAppointmentReminder,
  sendTestEmail,
};