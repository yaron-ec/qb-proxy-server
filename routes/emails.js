/* eslint-disable no-undef */
/**
 * /api/v1 — authenticated public email endpoints (PERMANENT Railway API).
 *
 *   POST /api/v1/emails/send          { to, cc, replyTo, subject, htmlBody, idempotencyKey }
 *   POST /api/v1/emails/test          { to }                       (internal recipients only)
 *   POST /api/v1/leads/:id/remind                                 (staff + customer reminder)
 *   POST /api/v1/invoices/:id/email                               (invoice + QB PDF attachment)
 *
 * All routes require a Railway JWT (lib/rbac.requireAuth). No PROXY_SECRET,
 * no Gmail tokens, no Base44 tokens reach these routes.
 *
 * Data reads during Phase 1 use lib/dataAccess.js [TEMPORARY Base44 bridge];
 * replaced by Railway Postgres in Stage 7.
 *
 * Email sending goes exclusively through EmailService (the single sender).
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const emailService = require('../lib/emailService');
const templates = require('../lib/emailTemplates');
const data = require('../lib/dataAccess');
const transport = require('../lib/transportControl');
const { canAccessLead } = require('../lib/authorization');

const router = express.Router();

// No browser delegation (Approach A): when a flow is owned by Base44 the Railway
// route is NOT the executor for that action and returns 421 Misdirected (sends
// nothing). The frontend calls the Base44 function directly for Base44-owned
// flows per FLOW_OWNERSHIP in src/lib/emailTransport.js.
function base44Owned(res, flow) {
  return res.status(421).json({ error: `${flow} is owned by Base44; call the Base44 function directly`, transport: 'base44' });
}

const INTERNAL_TEST_RECIPIENTS = new Set([
  'michelle@ecconstructiongroup.com',
  'yaron@ecconstructiongroup.com',
]);

function isInternal(email) {
  return !!email && INTERNAL_TEST_RECIPIENTS.has(String(email).toLowerCase().trim());
}

// ── /api/v1/emails/send hardening (Phase 3) ─────────────────────────────────
const APPROVED_SENDER = 'yaron@ecconstructiongroup.com';
const APPROVED_FROM_NAME = process.env.GMAIL_FROM_NAME || 'EC Construction Group';
const ALLOWED_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'text/plain', 'text/csv', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;     // 10 MB per attachment
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;    // 25 MB total request

function normalizeAddrs(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(x => String(x || '').trim()).filter(Boolean).map(a => a.toLowerCase());
}
function validEmail(a) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a); }

// ── Generic authenticated send (raw HTML provided by caller) ────────────────
router.post('/emails/send', requireAuth, async (req, res) => {
  try {
    const selected = transport.flowTransport('GENERIC');
    transport.logDecision('GENERIC', selected, req.user);
    if (selected === 'base44') return base44Owned(res, 'GENERIC');
    const { to, cc, replyTo, subject, htmlBody, attachments, idempotencyKey, metadata, fromAddress, fromName } = req.body || {};
    // Required fields
    if (!to) return res.status(400).json({ error: 'to is required' });
    if (!subject) return res.status(400).json({ error: 'subject is required' });
    if (!htmlBody) return res.status(400).json({ error: 'htmlBody is required' });
    if (!idempotencyKey || typeof idempotencyKey !== 'string') return res.status(400).json({ error: 'idempotencyKey (string) is required' });
    // Reject any caller-supplied sender that differs from the approved sender
    if (fromAddress && String(fromAddress).toLowerCase() !== APPROVED_SENDER) return res.status(400).json({ error: 'sender is fixed; fromAddress must not be supplied' });
    // Normalize + validate recipients
    const toList = normalizeAddrs(to);
    if (!toList.length) return res.status(400).json({ error: 'no valid recipients' });
    const badTo = toList.find(a => !validEmail(a));
    if (badTo) return res.status(400).json({ error: `invalid recipient: ${badTo}` });
    const ccList = normalizeAddrs(cc).filter(validEmail);
    if (replyTo && !validEmail(String(replyTo).toLowerCase())) return res.status(400).json({ error: 'invalid replyTo' });
    // Validate attachments (filename, MIME, base64, per-file + total size)
    let totalBytes = 0;
    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        if (!a || !a.filename) return res.status(400).json({ error: 'attachment.filename required' });
        const ct = String(a.contentType || '').toLowerCase();
        if (!ALLOWED_MIME.has(ct)) return res.status(400).json({ error: `unsupported attachment MIME: ${ct}` });
        const b64 = String(a.contentBase64 || '').replace(/\s/g, '');
        if (!b64) return res.status(400).json({ error: 'attachment.contentBase64 required' });
        if (!/^[A-Za-z0-9+/=_-]+$/.test(b64)) return res.status(400).json({ error: 'invalid base64' });
        const bytes = Math.floor(b64.length * 3 / 4);
        if (bytes > MAX_FILE_BYTES) return res.status(400).json({ error: `attachment too large: ${a.filename}` });
        totalBytes += bytes;
      }
    }
    if (totalBytes > MAX_TOTAL_BYTES) return res.status(413).json({ error: 'total request too large' });
    // Send ONLY through EmailService; sender forced to the approved address.
    const result = await emailService.send({
      to: toList.length === 1 ? toList[0] : toList,
      cc: ccList, replyTo: replyTo || undefined, subject, htmlBody,
      attachments: Array.isArray(attachments) ? attachments : undefined,
      idempotencyKey, fromName: APPROVED_FROM_NAME, fromAddress: APPROVED_SENDER,
      role: (metadata && metadata.template_key) || 'api', metadata,
    });
    res.json({
      ok: !!result.ok,
      gmailMessageId: result.gmailMessageId || null,
      idempotent: !!result.idempotent,
      claimId: result.claimId || null,
      deliveryStatus: result.ok ? 'sent' : 'failed',
    });
  } catch (e) {
    res.status(e instanceof Error && /credentials/i.test(e.message) ? 503 : 500).json({ error: e.message });
  }
});

// ── Internal test send (NO customer, internal recipients only, one message) ─
router.post('/emails/test', requireAuth, async (req, res) => {
  try {
    const selected = transport.flowTransport('GENERIC');
    transport.logDecision('GENERIC', selected, req.user);
    if (selected === 'base44') return base44Owned(res, 'GENERIC');
    const { to } = req.body || {};
    if (!isInternal(to)) return res.status(400).json({ error: 'test recipients must be internal (michelle@/yaron@)' });
    const idempotencyKey = `test:${req.user.sub}:${Date.now()}`;
    const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1A1A2E;"><p>This is an internal test of the Railway Email Service. No customer email was sent.</p><p>Sent by ${req.user.email || ''}.</p></div>`;
    const result = await emailService.send({
      to, cc: ['yaron@ecconstructiongroup.com'], subject: 'Railway Email Service — Internal Test', htmlBody, idempotencyKey, role: 'test',
    });
    res.json({ ...result, recipient: to });
  } catch (e) {
    res.status(e instanceof Error && /credentials/i.test(e.message) ? 503 : 500).json({ error: e.message });
  }
});

// ── Manual reminder for a lead (staff + customer) ────────────────────────────
// Phase 1: built but NOT wired to the UI (T11 cutover). Uses [TEMPORARY]
// dataAccess.getLead; replaced by Railway Postgres `leads` in Stage 7.
router.post('/leads/:id/remind', requireAuth, async (req, res) => {
  try {
    const selected = transport.flowTransport('MANUAL_REMINDER');
    transport.logDecision('MANUAL_REMINDER', selected, req.user);
    if (selected === 'base44') return base44Owned(res, 'MANUAL_REMINDER');
    const lead = await data.getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    if (!canAccessLead(req.user, lead)) return res.status(403).json({ error: 'forbidden: not assigned to this lead' });

    const hasFollowUp = lead.follow_up_date && lead.follow_up_type;
    const apptDate = hasFollowUp ? lead.follow_up_date : lead.appointment_date;
    const apptTime = hasFollowUp ? (lead.follow_up_time || '09:00') : (lead.appointment_time || '09:00');
    if (!apptDate) return res.status(400).json({ error: 'no appointment date on this lead' });

    const ownerName = lead.assigned_rep || 'EC Construction Group';
    const ownerEmail = data.resolveOwnerEmail(lead.assigned_rep) || 'michelle@ecconstructiongroup.com';
    const clientName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
    const address = [lead.property_address, lead.city].filter(Boolean).join(', ');
    const baseKey = `manual:${lead.id}:${apptDate}:${apptTime}`;
    const results = { staff: [], customer: null };

    // Staff reminder → rep + michelle + yaron
    const staffRecipients = Array.from(new Set([ownerEmail, 'michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com']));
    const staffHtml = templates.manualStaffReminderEmail({
      ownerName, clientName, clientPhone: lead.phone || 'N/A', clientEmail: lead.email || 'N/A',
      date: apptDate, time: apptTime, address, projectType: lead.project_type || '', notes: lead.notes || '',
      leadId: lead.id, crmUrl: data.CRM_PUBLIC_URL,
    });
    for (const recipient of staffRecipients) {
      try {
        const r = await emailService.send({ to: recipient, subject: `Manual Reminder: ${clientName} — ${apptDate} at ${apptTime}`, htmlBody: staffHtml, idempotencyKey: `${baseKey}:staff:${recipient}`, role: 'staff' });
        results.staff.push({ email: recipient, ...r });
      } catch (e) { results.staff.push({ email: recipient, ok: false, error: e.message }); }
    }

    // Customer reminder (suppressed if opted out / no email)
    if (lead.customer_reminders_disabled) {
      results.customer = { status: 'skipped', reason: 'customer opted out' };
    } else if (lead.email) {
      const custHtml = templates.manualCustomerReminderEmail({ firstName: lead.first_name || 'there', date: apptDate, time: apptTime, address, projectType: lead.project_type || '', ownerName });
      try {
        const r = await emailService.send({ to: lead.email, cc: ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'], replyTo: ownerEmail, subject: 'Appointment Reminder — EC Construction Group', htmlBody: custHtml, idempotencyKey: `${baseKey}:customer`, role: 'customer' });
        results.customer = { email: lead.email, ...r };
      } catch (e) { results.customer = { email: lead.email, ok: false, error: e.message }; }
    } else {
      results.customer = { status: 'skipped', reason: 'no customer email' };
    }

    res.json({ ok: true, leadId: lead.id, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Invoice email with QB PDF attachment ─────────────────────────────────────
// Fetches the invoice + lead via [TEMPORARY] dataAccess, fetches the QB PDF
// via the Railway service's own /invoices/:id/pdf (self-call, X-Proxy-Secret),
// then sends through EmailService with the PDF attached.
router.post('/invoices/:id/email', requireAuth, async (req, res) => {
  try {
    const selected = transport.flowTransport('INVOICE');
    transport.logDecision('INVOICE', selected, req.user);
    if (selected === 'base44') return base44Owned(res, 'INVOICE');
    const invoice = await data.getInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'invoice not found' });
    const lead = invoice.lead_id ? await data.getLead(invoice.lead_id) : null;
    if (!lead) return res.status(404).json({ error: 'lead not found for invoice' });
    if (!canAccessLead(req.user, lead)) return res.status(403).json({ error: 'forbidden: not assigned to this lead' });

    const recipients = [];
    if (lead.email) recipients.push(lead.email);
    const ownerEmail = data.resolveOwnerEmail(lead.assigned_rep);
    if (ownerEmail && ownerEmail !== lead.email) recipients.push(ownerEmail);
    if (!recipients.length) return res.status(400).json({ error: 'no recipients' });

    // Fetch the QB PDF via the Railway service's own endpoint (no refactor of
    // the QB token helpers required; self-call with X-Proxy-Secret).
    const PROXY_SECRET = process.env.PROXY_SECRET;
    const PORT = process.env.PORT || '3000';
    let attachment = null;
    if (invoice.qb_invoice_id) {
      const pdfRes = await fetch(`http://localhost:${PORT}/invoices/${invoice.qb_invoice_id}/pdf`, {
        headers: { 'X-Proxy-Secret': PROXY_SECRET || '', Accept: 'application/pdf' },
      });
      if (pdfRes.ok) {
        const buf = Buffer.from(await pdfRes.arrayBuffer());
        attachment = {
          filename: `Invoice-${invoice.qb_invoice_number || invoice.qb_invoice_id}.pdf`,
          contentType: 'application/pdf',
          contentBase64: buf.toString('base64'),
        };
      }
    }

    const html = templates.invoiceEmail({
      clientName: `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Customer',
      invoiceNumber: invoice.qb_invoice_number || invoice.invoice_number || invoice.qb_invoice_id,
      amount: invoice.amount, projectType: lead.project_type,
    });
    const results = [];
    for (const recipient of recipients) {
      try {
        const r = await emailService.send({
          to: recipient, subject: `Invoice #${invoice.qb_invoice_number || invoice.invoice_number || invoice.qb_invoice_id} — EC Construction Group`,
          htmlBody: html, attachments: attachment ? [attachment] : [],
          idempotencyKey: `invoice:${invoice.id}:${recipient}`, role: 'invoice',
        });
        results.push({ email: recipient, ...r });
      } catch (e) { results.push({ email: recipient, ok: false, error: e.message }); }
    }
    res.json({ ok: true, invoiceId: invoice.id, results, attachmentAttached: !!attachment });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;