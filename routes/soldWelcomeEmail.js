/* eslint-disable no-undef */
/**
 * Admin-only CRM surface for the automated Sold-customer welcome email
 * (lib/soldWelcomeEmail.js). Three routes, all requireAuth + requireAdmin
 * (same convention as routes/reminderDiagnostics.js / routes/systemInfo.js):
 *
 *   GET  /leads/:id/sold-welcome-email/preview — renders the EXACT branded
 *        HTML this lead would receive, using the lead's real first name
 *        (never placeholder branding). Pure render — no DB write, no send.
 *   GET  /leads/:id/sold-welcome-email         — the current audit record
 *        for this lead (sent/skipped/failed/never-attempted), for the CRM
 *        UI to show before/after a manual send.
 *   POST /leads/:id/sold-welcome-email/send    — manually triggers the real
 *        send for this ONE lead. Deliberately bypasses the automatic-
 *        trigger feature gate (SOLD_WELCOME_EMAIL_ENABLED) — this is an
 *        explicit, human-authorized admin action on a single lead, not the
 *        automatic Sold-status-change trigger that flag holds back — but
 *        does NOT bypass the per-lead idempotency check: a lead whose
 *        record already shows 'sent' is refused with 409, never re-sent.
 */
'use strict';

const express = require('express');
const { requireAuth, requireAdmin } = require('../lib/rbac');
const db = require('../db/client');
const emailTemplates = require('../lib/emailTemplates');
const soldWelcomeEmail = require('../lib/soldWelcomeEmail');

const router = express.Router();

async function loadLead(leadId) {
  const { rows } = await db.query(`SELECT id, first_name, last_name, email, status FROM leads WHERE id = $1`, [leadId]);
  return rows[0] || null;
}

router.get('/leads/:id/sold-welcome-email/preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const lead = await loadLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });
    const rendered = emailTemplates.soldWelcomeEmail({ firstName: lead.first_name });
    res.json({ subject: rendered.subject, html: rendered.html, text: rendered.text, recipient_email: lead.email || null });
  } catch (e) {
    console.error('[sold-welcome-email] preview error:', e.message);
    res.status(500).json({ error: 'sold_welcome_email_preview_failed', message: e.message });
  }
});

router.get('/leads/:id/sold-welcome-email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const lead = await loadLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });
    const record = await soldWelcomeEmail.getRecordForLead(req.params.id);
    res.json({ record: record || null, autoTriggerEnabled: soldWelcomeEmail.autoTriggerEnabled() });
  } catch (e) {
    console.error('[sold-welcome-email] status error:', e.message);
    res.status(500).json({ error: 'sold_welcome_email_status_failed', message: e.message });
  }
});

router.post('/leads/:id/sold-welcome-email/send', requireAuth, requireAdmin, async (req, res) => {
  try {
    const lead = await loadLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });
    const existing = await soldWelcomeEmail.getRecordForLead(req.params.id);
    if (existing && existing.status === 'sent') {
      return res.status(409).json({ error: 'already_sent', record: existing });
    }
    const result = await soldWelcomeEmail.sendWelcomeEmailForLead(lead, { triggeredBy: req.user?.email, source: 'manual_admin' });
    res.json(result);
  } catch (e) {
    console.error('[sold-welcome-email] send error:', e.message);
    res.status(500).json({ error: 'sold_welcome_email_send_failed', message: e.message });
  }
});

module.exports = router;
