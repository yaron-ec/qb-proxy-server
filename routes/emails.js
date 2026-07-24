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

const router = express.Router();

const INTERNAL_TEST_RECIPIENTS = new Set([
  'michelle@ecconstructiongroup.com',
  'yaron@ecconstructiongroup.com',
]);

function isInternal(email) {
  return !!email && INTERNAL_TEST_RECIPIENTS.has(String(email).toLowerCase().trim());
}

// ── Generic authenticated send (raw HTML provided by caller) ────────────────
router.post('/emails/send', requireAuth, async (req, res) => {
  try {
    const { to, cc, replyTo, subject, htmlBody, idempotencyKey } = req.body || {};
    if (!to || !subject || !htmlBody) return res.status(400).json({ error: 'to, subject, htmlBody required' });
    if (!idempotencyKey) return res.status(400).json({ error: 'idempotencyKey required' });
    const result = await emailService.send({
      to, cc, replyTo, subject, htmlBody, idempotencyKey, role: 'api',
    });
    res.json(result);
  } catch (e) {
    res.status(e instanceof Error && /credentials/i.test(e.message) ? 503 : 500).json({ error: e.message });
  }
});

// ── Internal test send (NO customer, internal recipients only, one message) ─
router.post('/emails/test', requireAuth, async (req, res) => {
  try {
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
    const lead = await data.getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead not found' });

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
    const invoice = await data.getInvoice(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'invoice not found' });
    const lead = invoice.lead_id ? await data.getLead(invoice.lead_id) : null;
    if (!lead) return res.status(404).json({ error: 'lead not found for invoice' });

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