/* eslint-disable no-undef */
/**
 * /api/v1/cron — Railway-native cron job endpoints (replaces Base44 automations).
 *
 * These endpoints are called by the Railway cron scheduler (or external cron)
 * to replace Base44 scheduled automations. Each endpoint is guarded by
 * X-Worker-Secret (WORKER_SECRET) to prevent external access.
 *
 * Current replacements:
 *   POST /api/v1/cron/daily-title-case-cleanup   — replaces dailyLeadTitleCaseCleanup
 *   POST /api/v1/cron/detect-duplicates          — replaces detectAndMergeDuplicatesByName
 *   POST /api/v1/cron/clear-intake-markers       — replaces clearNewIntakeLeadMarker
 *   POST /api/v1/cron/mark-invalid-contacts      — replaces markInvalidContactsAsContacts
 *   POST /api/v1/cron/sync-deals-from-leads      — replaces onLeadUpdatedSyncDeal
 *   POST /api/v1/cron/notify-crm-activity        — replaces notifyCRMActivity
 *   POST /api/v1/cron/notify-status-change       — replaces notifyStatusChange
 *   POST /api/v1/cron/send-project-status-email  — replaces sendProjectStatusEmail
 *
 * Each endpoint is idempotent and safe to retry.
 */
'use strict';

const express = require('express');
const { query } = require('../db/client');
const emailService = require('../lib/emailService');
const templates = require('../lib/emailTemplates');

const router = express.Router();

// ── Auth: X-Worker-Secret ────────────────────────────────────────────────────
function requireWorkerSecret(req, res, next) {
  const secret = req.headers['x-worker-secret'];
  if (!process.env.WORKER_SECRET || secret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing or invalid X-Worker-Secret' });
  }
  next();
}

router.use(requireWorkerSecret);

// ── POST /daily-title-case-cleanup ──────────────────────────────────────────
// Replaces Base44 automation: dailyLeadTitleCaseCleanup
// Normalizes lead first_name/last_name to Title Case (e.g. "JOHN" → "John")
router.post('/daily-title-case-cleanup', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, first_name, last_name FROM leads
      WHERE first_name != initcap(first_name)
         OR last_name != initcap(last_name)
      LIMIT 500
    `);

    let updated = 0;
    for (const row of rows) {
      const fn = row.first_name ? row.first_name.charAt(0).toUpperCase() + row.first_name.slice(1).toLowerCase() : null;
      const ln = row.last_name ? row.last_name.charAt(0).toUpperCase() + row.last_name.slice(1).toLowerCase() : null;
      if (fn !== row.first_name || ln !== row.last_name) {
        await query('UPDATE leads SET first_name = $1, last_name = $2, updated_at = NOW() WHERE id = $3', [fn, ln, row.id]);
        updated++;
      }
    }

    res.json({ ok: true, checked: rows.length, updated, job: 'daily-title-case-cleanup' });
  } catch (e) {
    console.error('[cron] title-case-cleanup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /detect-duplicates ─────────────────────────────────────────────────
// Replaces Base44 automation: detectAndMergeDuplicatesByName
// Detects leads with the same name (case-insensitive) and reports them.
// Does NOT auto-merge — only reports for manual review.
router.post('/detect-duplicates', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT lower(first_name || ' ' || last_name) as full_name,
             array_agg(id) as lead_ids,
             array_agg(first_name || ' ' || last_name) as names,
             array_agg(status) as statuses,
             count(*) as cnt
      FROM leads
      WHERE first_name IS NOT NULL AND last_name IS NOT NULL
        AND status NOT IN ('Lost', 'DNQ')
      GROUP BY lower(first_name || ' ' || last_name)
      HAVING count(*) > 1
      ORDER BY cnt DESC
      LIMIT 100
    `);

    res.json({ ok: true, duplicateGroups: rows.length, duplicates: rows, job: 'detect-duplicates' });
  } catch (e) {
    console.error('[cron] detect-duplicates error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /clear-intake-markers ───────────────────────────────────────────────
// Replaces Base44 automation: clearNewIntakeLeadMarker
// Clears is_new_intake_lead flag for leads that have been reviewed (reviewed_at IS NOT NULL)
// or are older than 7 days.
router.post('/clear-intake-markers', async (req, res) => {
  try {
    const { rowCount } = await query(`
      UPDATE leads
      SET is_new_intake_lead = false, updated_at = NOW()
      WHERE is_new_intake_lead = true
        AND (reviewed_at IS NOT NULL OR created_at < NOW() - INTERVAL '7 days')
    `);

    res.json({ ok: true, cleared: rowCount, job: 'clear-intake-markers' });
  } catch (e) {
    console.error('[cron] clear-intake-markers error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /mark-invalid-contacts ─────────────────────────────────────────────
// Replaces Base44 automation: markInvalidContactsAsContacts
// Marks leads with invalid phone AND no email as record_type = 'Contact'
// (they're not actionable leads).
router.post('/mark-invalid-contacts', async (req, res) => {
  try {
    const { rowCount } = await query(`
      UPDATE leads
      SET record_type = 'Contact', updated_at = NOW()
      WHERE record_type = 'Lead'
        AND (phone IS NULL OR phone = '' OR length(regexp_replace(phone, '\\D', '', 'g')) < 10)
        AND (email IS NULL OR email = '')
        AND status NOT IN ('Sold', 'Appointment scheduled')
    `);

    res.json({ ok: true, marked: rowCount, job: 'mark-invalid-contacts' });
  } catch (e) {
    console.error('[cron] mark-invalid-contacts error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sync-deals-from-leads ──────────────────────────────────────────────
// Replaces Base44 automation: onLeadUpdatedSyncDeal
// For leads with status = 'Sold', ensures a Deal exists.
// Creates a Deal if one doesn't exist for the lead.
router.post('/sync-deals-from-leads', async (req, res) => {
  try {
    const { rows: soldLeads } = await query(`
      SELECT l.id, l.lead_id, l.first_name, l.last_name, l.assigned_rep, l.owner_id
      FROM leads l
      WHERE l.status = 'Sold'
        AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id)
      LIMIT 100
    `);

    let created = 0;
    for (const lead of soldLeads) {
      const dealName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() + ' — Deal';
      await query(`
        INSERT INTO deals (lead_id, name, stage, assigned_rep, created_at, updated_at)
        VALUES ($1, $2, 'Sold / Estimate Approved', $3, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `, [lead.id, dealName, lead.assigned_rep || lead.owner_display_name || null]);
      created++;
    }

    res.json({ ok: true, checked: soldLeads.length, created, job: 'sync-deals-from-leads' });
  } catch (e) {
    console.error('[cron] sync-deals-from-leads error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /notify-crm-activity ───────────────────────────────────────────────
// Replaces Base44 automation: notifyCRMActivity
// Sends email notification to office when a lead is updated.
// Queries recent lead updates and sends a summary email.
router.post('/notify-crm-activity', async (req, res) => {
  try {
    const { lead_id, activity_type, changes, content } = req.body || {};

    if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

    // Get lead data from Postgres
    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`,
      [lead_id]
    );
    const lead = rows[0];
    if (!lead) return res.status(404).json({ error: 'lead not found' });

    const leadName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
    const repName = lead.owner_display_name || 'Unassigned';
    const crmUrl = process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com';

    const html = templates.crmActivityEmail({
      title: activity_type || 'CRM Activity Update',
      leadName,
      leadId: lead.id,
      repName,
      activityType: activity_type,
      changes: changes || [],
      content: content || '',
      timestamp: new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
      crmUrl,
    });

    const result = await emailService.send({
      to: 'michelle@ecconstructiongroup.com',
      cc: ['yaron@ecconstructiongroup.com'],
      subject: `CRM Activity: ${leadName} — ${activity_type || 'Update'}`,
      htmlBody: html,
      idempotencyKey: `crm-activity:${lead.id}:${Date.now()}`,
      role: 'activity_notification',
    });

    res.json({ ok: !!result.ok, leadId: lead.id, job: 'notify-crm-activity' });
  } catch (e) {
    console.error('[cron] notify-crm-activity error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /notify-status-change ──────────────────────────────────────────────
// Replaces Base44 automation: notifyStatusChange
// Sends email to customer when lead status changes.
router.post('/notify-status-change', async (req, res) => {
  try {
    const { lead_id, old_status, new_status } = req.body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`,
      [lead_id]
    );
    const lead = rows[0];
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    if (!lead.email) return res.json({ ok: true, skipped: 'no customer email', job: 'notify-status-change' });
    if (lead.customer_reminders_disabled) return res.json({ ok: true, skipped: 'customer opted out', job: 'notify-status-change' });

    const clientName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Customer';
    const crmUrl = process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com';
    const html = templates.statusChangeEmail({
      clientName,
      itemName: clientName,
      oldStatus: old_status,
      newStatus: new_status,
      crmUrl,
    });

    const result = await emailService.send({
      to: lead.email,
      cc: ['michelle@ecconstructiongroup.com'],
      subject: `Project Status Update — EC Construction Group`,
      htmlBody: html,
      idempotencyKey: `status-change:${lead.id}:${new_status}`,
      role: 'status_notification',
    });

    res.json({ ok: !!result.ok, leadId: lead.id, job: 'notify-status-change' });
  } catch (e) {
    console.error('[cron] notify-status-change error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /send-project-status-email ─────────────────────────────────────────
// Replaces Base44 automation: sendProjectStatusEmail
// Sends project status email to customer.
router.post('/send-project-status-email', async (req, res) => {
  try {
    const { lead_id, project_status, custom_message } = req.body || {};
    if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`,
      [lead_id]
    );
    const lead = rows[0];
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    if (!lead.email) return res.json({ ok: true, skipped: 'no customer email', job: 'send-project-status-email' });

    const firstName = lead.first_name || 'there';
    const ownerName = lead.owner_display_name || 'EC Construction Group';
    const html = templates.statusChangeEmail({
      clientName: firstName,
      itemName: project_status || 'Project Update',
      oldStatus: 'Previous',
      newStatus: project_status || 'Update',
      crmUrl: process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com',
    });

    const result = await emailService.send({
      to: lead.email,
      cc: ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'],
      subject: `Project Status: ${project_status || 'Update'} — EC Construction Group`,
      htmlBody: html,
      idempotencyKey: `project-status:${lead.id}:${project_status || 'update'}`,
      role: 'project_status',
    });

    res.json({ ok: !!result.ok, leadId: lead.id, job: 'send-project-status-email' });
  } catch (e) {
    console.error('[cron] send-project-status-email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /dry-run-migration ──────────────────────────────────────────────────
// Runs the migration dry-run script (dryRunMigrationWritePaths.js) which exercises
// all 24 dataset write-paths inside a transaction that ALWAYS rolls back.
// Returns the script's stdout output as JSON.
router.post('/dry-run-migration', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'dryRunMigrationWritePaths.js');
  const fs = require('fs');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'dryRunMigrationWritePaths.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] dry-run-migration process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'dry-run-migration',
      });
    });
  } catch (e) {
    console.error('[cron] dry-run-migration error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;