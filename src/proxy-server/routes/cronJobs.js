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

// ── POST /apply-migrations ─────────────────────────────────────────────────
// Runs node db/migrate.js to apply all pending schema migrations.
// Returns the script's stdout/stderr as JSON.
router.post('/apply-migrations', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const migratePath = path.resolve(__dirname, '..', 'db', 'migrate.js');
  if (!fs.existsSync(migratePath)) {
    return res.status(404).json({ error: 'db/migrate.js not found', path: migratePath });
  }

  try {
    execFile('node', [migratePath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] apply-migrations process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'apply-migrations',
      });
    });
  } catch (e) {
    console.error('[cron] apply-migrations error:', e.message);
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

// ── POST /audit-owner-resolution ────────────────────────────────────────────
// READ-ONLY validation: verifies every Base44 lead's assigned_rep resolves to
// a Railway owner. No writes. Safe to run at any time.
router.post('/audit-owner-resolution', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'auditOwnerResolution.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'auditOwnerResolution.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] audit-owner-resolution process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'audit-owner-resolution',
      });
    });
  } catch (e) {
    console.error('[cron] audit-owner-resolution error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-activities ────────────────────────────────────────
// Production-path rollback validation for Activities: runs the EXACT same
// runActivityMigration() function used by the production script, inside a
// transaction that is ALWAYS ROLLED BACK. Validates source normalization,
// orphan handling, and all 5916 activities.
router.post('/rollback-validate-activities', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateActivities.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateActivities.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-activities process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-activities',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-activities error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-deals ─────────────────────────────────────────────
// Production-path rollback validation for Deals: runs the EXACT same
// runDealMigration() function used by the production script, inside a
// transaction that is ALWAYS ROLLED BACK. Validates stage normalization,
// FK resolution, and all 46 deals.
router.post('/rollback-validate-deals', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateDeals.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateDeals.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-deals process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-deals',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-deals error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /audit-property-coverage ─────────────────────────────────────────────
// READ-ONLY audit: proves destination coverage for all 133 Base44 Property
// records before excluding them. Queries integration_credentials, settings,
// company_settings, and qb_lead_match_mappings. No secret values printed.
router.post('/audit-property-coverage', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'auditPropertyCoverage.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'auditPropertyCoverage.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] audit-property-coverage process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'audit-property-coverage',
      });
    });
  } catch (e) {
    console.error('[cron] audit-property-coverage error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /audit-property-coverage2 ───────────────────────────────────────────
// READ-ONLY audit phase 2: settings schema, leads QB columns, SignNow/Handoff credentials
router.post('/audit-property-coverage2', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'auditPropertyCoverage2.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'auditPropertyCoverage2.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] audit-property-coverage2 process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'audit-property-coverage2',
      });
    });
  } catch (e) {
    console.error('[cron] audit-property-coverage2 error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-estimates ─────────────────────────────────────────
// Production-path rollback validation for Estimates: runs the EXACT same
// runEstimateMigration() function used by the production script, inside a
// transaction that is ALWAYS ROLLED BACK. Validates FK resolution (lead_id,
// nullable for orphans), field constraints, and all 191 Base44 estimates.
router.post('/rollback-validate-estimates', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateEstimates.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateEstimates.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-estimates process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-estimates',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-estimates error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-invoices ──────────────────────────────────────────
// Production-path rollback validation for Invoices: runs the EXACT same
// runInvoiceMigration() function used by the production script, inside a
// transaction that is ALWAYS ROLLED BACK. Validates FK resolution (lead_id,
// deal_id), field constraints, and all Base44 invoices.
router.post('/rollback-validate-invoices', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateInvoices.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateInvoices.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-invoices process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-invoices',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-invoices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-tasks ────────────────────────────────────────────
// Production-path rollback validation for Tasks: runs the EXACT same
// runTaskMigration() function used by the production script, inside a
// transaction that is ALWAYS ROLLED BACK. Validates FK resolution,
// field constraints, and all Base44 tasks.
router.post('/rollback-validate-tasks', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateTasks.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateTasks.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-tasks process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-tasks',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-tasks error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /audit-qb-identity ──────────────────────────────────────────────────
// READ-ONLY audit: checks Railway leads table for qb_customer_id column,
// qb_invoice_sale_map entries, handoff_estimates, and key lead data.
router.post('/audit-qb-identity', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'auditQbIdentity.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'auditQbIdentity.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] audit-qb-identity process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'audit-qb-identity',
      });
    });
  } catch (e) {
    console.error('[cron] audit-qb-identity error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-qb-identity ──────────────────────────────────────
// Production-path rollback validation for leads.qb_customer_id backfill.
// Runs the EXACT same runQbCustomerIdMigration() function used by the
// production script, inside a transaction that is ALWAYS ROLLED BACK.
router.post('/rollback-validate-qb-identity', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateQbIdentity.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateQbIdentity.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-qb-identity process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-qb-identity',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-qb-identity error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-handoff-estimates ─────────────────────────────────
// Production-path rollback validation for handoff_estimates: runs the EXACT
// same runHandoffEstimateMigration() function used by the production script,
// inside a transaction that is ALWAYS ROLLED BACK. Validates FK resolution
// (lead_id, nullable for orphans), NOT NULL (customer_name, match_status),
// UNIQUE (external_ref), types, and all Base44 HandoffEstimate records.
router.post('/rollback-validate-handoff-estimates', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateHandoffEstimates.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateHandoffEstimates.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-handoff-estimates process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-handoff-estimates',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-handoff-estimates error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-shlomi-merge ─────────────────────────────────────
// Production-path rollback validation for the Shlomi→Simon identity merge:
// runs the EXACT same runShlomiMerge() function used by the production merge
// script, inside a transaction that is ALWAYS ROLLED BACK. Validates the
// comprehensive audit, owner re-point (leads/appointments), text re-points
// (deals/tasks/commissions), historical preservation (lead_submissions/
// appointment_events), idempotency, and rollback integrity. Does NOT touch
// Base44 (the UserAllowlist delete is a separate permanent step).
router.post('/rollback-validate-shlomi-merge', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateShlomiMerge.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateShlomiMerge.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-shlomi-merge process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-shlomi-merge',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-shlomi-merge error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-small-datasets ───────────────────────────────────
// Production-path rollback validation for small datasets (UserAllowlist,
// CompanySettings, SyncCursor, LeadAttachment, DealExpense): runs the EXACT
// same runSmallDatasetsMigration() function used by the production script,
// inside a transaction that is ALWAYS ROLLED BACK. Validates FK resolution,
// NOT NULL, UNIQUE natural keys, value domains, idempotency, and detects
// semantic defects (e.g. UserAllowlist duplicate email → data loss).
router.post('/rollback-validate-small-datasets', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateSmallDatasets.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateSmallDatasets.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-small-datasets process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-small-datasets',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-small-datasets error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-leads-appts ──────────────────────────────────────
// Production-path rollback validation: runs the EXACT same runLeadMigration()
// and runAppointmentMigration() functions used by the production scripts,
// inside a transaction that is ALWAYS ROLLED BACK. No parallel dry-run —
// it requires() the production modules and calls their exported functions.
router.post('/rollback-validate-leads-appts', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateLeadsAppts.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateLeadsAppts.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-leads-appts process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-leads-appts',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-leads-appts error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /audit-shlomi-identity ─────────────────────────────────────────────
// READ-ONLY audit: runs auditShlomiIdentity.js which ONLY executes SELECT
// queries (no writes, no transactions). Reports active/canonical vs
// historical/free-text Shlomi references + Railway user_allowlist state.
// Safe to run at any time — zero side effects.
router.post('/audit-shlomi-identity', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'auditShlomiIdentity.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'auditShlomiIdentity.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] audit-shlomi-identity process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'audit-shlomi-identity',
      });
    });
  } catch (e) {
    console.error('[cron] audit-shlomi-identity error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /reconcile-small-datasets ───────────────────────────────────────────
// READ-ONLY production reconciliation: runs reconcileSmallDatasets.js which ONLY
// executes SELECT queries (no writes, no transactions). Compares the permanently
// written small-dataset state (user_allowlist, company_settings, sync_cursors,
// lead_attachments, deal_expenses) against the Base44 source — counts, natural
// keys, field-level values, FK resolution, identity checks. Safe to run any time.
router.post('/reconcile-small-datasets', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'reconcileSmallDatasets.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'reconcileSmallDatasets.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] reconcile-small-datasets process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'reconcile-small-datasets',
      });
    });
  } catch (e) {
    console.error('[cron] reconcile-small-datasets error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /reconcile-leads-extra ───────────────────────────────────────────────
// READ-ONLY reconciliation: identifies the Railway lead(s) with no Base44 counterpart
// (the +1 diff). Reports identity, Base44 match by email/phone/name, dependency counts
// across all migrated tables, and 1:1 mapping confirmation. SELECT queries only.
router.post('/reconcile-leads-extra', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'reconcileLeadsExtra.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'reconcileLeadsExtra.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] reconcile-leads-extra process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'reconcile-leads-extra',
      });
    });
  } catch (e) {
    console.error('[cron] reconcile-leads-extra error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /cleanup-test-probe ──────────────────────────────────────────────────
// One-time guarded cleanup of the confirmed Railway-native "Test Probe" test record.
// Re-verifies identity + dependencies, cancels the single appointment, deletes the
// lead — all inside a single transaction that rolls back on any mismatch.
router.post('/cleanup-test-probe', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'cleanupTestProbe.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'cleanupTestProbe.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, APPLY: '1' },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] cleanup-test-probe process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'cleanup-test-probe',
      });
    });
  } catch (e) {
    console.error('[cron] cleanup-test-probe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /run-leads-appts-migration ──────────────────────────────────────────
// PERMANENT migration (auto-commit): runs the EXACT same runLeadMigration() and
// runAppointmentMigration() functions that passed rollback validation, but with
// the default auto-commit query (no transaction wrapper). Changes persist.
// Halts on first stage error (unresolved owners throw; per-lead write errors
// block the appointments stage). Idempotent (ON CONFLICT DO UPDATE).
router.post('/run-leads-appts-migration', async (req, res) => {
  const { runLeadMigration } = require('../scripts/migrateLeadsToRailway');
  const { runAppointmentMigration } = require('../scripts/migrateAppointmentsToRailway');

  try {
    // ── Pre-flight: current Railway counts ────────────────────────────────
    const beforeLeads = parseInt((await query('SELECT COUNT(*) as cnt FROM leads')).rows[0].cnt, 10);
    const beforeAppts = parseInt((await query('SELECT COUNT(*) as cnt FROM appointments')).rows[0].cnt, 10);

    // ── Step 1: Permanent Leads migration (auto-commit) ──────────────────
    console.log('[cron] run-leads-appts-migration: starting permanent Leads migration');
    const leadResult = await runLeadMigration(query);

    // Halt on per-lead write errors (unresolved named owners already threw)
    if (leadResult.errors > 0) {
      return res.status(500).json({
        ok: false,
        error: `Leads migration completed with ${leadResult.errors} write error(s) — appointments NOT run`,
        beforeLeads, leadResult,
        job: 'run-leads-appts-migration',
      });
    }

    // ── Step 2: Permanent Appointments migration (auto-commit) ───────────
    console.log('[cron] run-leads-appts-migration: Leads complete, starting Appointments migration');
    const apptResult = await runAppointmentMigration(query);

    // ── Post counts ────────────────────────────────────────────────────────
    const afterLeads = parseInt((await query('SELECT COUNT(*) as cnt FROM leads')).rows[0].cnt, 10);
    const afterAppts = parseInt((await query('SELECT COUNT(*) as cnt FROM appointments')).rows[0].cnt, 10);

    res.json({
      ok: apptResult.errors === 0,
      beforeLeads, afterLeads, beforeAppts, afterAppts,
      leadResult, apptResult,
      job: 'run-leads-appts-migration',
    });
  } catch (e) {
    console.error('[cron] run-leads-appts-migration error:', e.message);
    res.status(500).json({ error: e.message, job: 'run-leads-appts-migration' });
  }
});

// ── POST /run-delta-migration ──────────────────────────────────────────────────
// PERMANENT delta migration: re-runs all idempotent migration scripts for datasets
// with confirmed live deltas since the 2026-08-27 cutover. Auto-commit (no rollback).
// Idempotent (ON CONFLICT DO UPDATE). Preserves Railway-native data (no deletes).
// Order: Leads+Appointments → Activities → Deals → Small Datasets (DealExpenses, LeadAttachments)
router.post('/run-delta-migration', async (req, res) => {
  try {
    const { runLeadMigration } = require('../scripts/migrateLeadsToRailway');
    const { runAppointmentMigration } = require('../scripts/migrateAppointmentsToRailway');
    const { runActivityMigration } = require('../scripts/migrateActivitiesToRailway');
    const { runDealMigration } = require('../scripts/migrateDealsToRailway');
    const { runSmallDatasetsMigration } = require('../scripts/migrateSmallDatasetsToRailway');

    // ── Before counts ──────────────────────────────────────────────────────
    const before = {};
    for (const [key, table] of [['leads','leads'],['appointments','appointments'],['activities','activities'],['deals','deals'],['deal_expenses','deal_expenses'],['lead_attachments','lead_attachments']]) {
      before[key] = parseInt((await query(`SELECT COUNT(*) as cnt FROM ${table}`)).rows[0].cnt, 10);
    }

    // ── 1. Leads + Appointments ─────────────────────────────────────────────
    console.log('[delta-migration] Step 1: Leads + Appointments');
    const leadResult = await runLeadMigration(query);
    const apptResult = await runAppointmentMigration(query);

    // ── 2. Activities ──────────────────────────────────────────────────────
    console.log('[delta-migration] Step 2: Activities');
    const activityResult = await runActivityMigration(query);

    // ── 3. Deals ───────────────────────────────────────────────────────────
    console.log('[delta-migration] Step 3: Deals');
    const dealResult = await runDealMigration(query);

    // ── 4. Small Datasets (DealExpenses, LeadAttachments, etc.) ────────────
    console.log('[delta-migration] Step 4: Small Datasets');
    const smallResult = await runSmallDatasetsMigration(query);

    // ── After counts ───────────────────────────────────────────────────────
    const after = {};
    for (const [key, table] of [['leads','leads'],['appointments','appointments'],['activities','activities'],['deals','deals'],['deal_expenses','deal_expenses'],['lead_attachments','lead_attachments']]) {
      after[key] = parseInt((await query(`SELECT COUNT(*) as cnt FROM ${table}`)).rows[0].cnt, 10);
    }

    res.json({
      ok: true,
      before, after,
      leadResult, apptResult, activityResult, dealResult, smallResult,
      job: 'run-delta-migration',
    });
  } catch (e) {
    console.error('[cron] run-delta-migration error:', e.message);
    res.status(500).json({ error: e.message, job: 'run-delta-migration' });
  }
});

// ── POST /rollback-validate-lead-submissions ─────────────────────────────────
// Production-path rollback validation for lead_submissions: runs the EXACT same
// runLeadSubmissionMigration() function used by the production script, inside a
// transaction that is ALWAYS ROLLED BACK. Validates FK resolution (lead_id),
// NOT NULL, UNIQUE (external_ref), field values, and all 3 Base44 records.
router.post('/rollback-validate-lead-submissions', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateLeadSubmissions.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateLeadSubmissions.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-lead-submissions process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-lead-submissions',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-lead-submissions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /rollback-validate-signnow-documents ────────────────────────────────
// Production-path rollback validation for signnow_documents: runs the EXACT same
// runSignNowDocumentMigration() function used by the production script, inside a
// transaction that is ALWAYS ROLLED BACK. Validates FK resolution (lead_id),
// NOT NULL, UNIQUE (external_ref), status domain, field values, idempotency,
// and all 13 Base44 SignNowDocument records (10 resolvable + 3 orphan skipped).
router.post('/rollback-validate-signnow-documents', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'rollbackValidateSignNowDocuments.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'rollbackValidateSignNowDocuments.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] rollback-validate-signnow-documents process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'rollback-validate-signnow-documents',
      });
    });
  } catch (e) {
    console.error('[cron] rollback-validate-signnow-documents error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /system-wide-reconciliation ──────────────────────────────────────────
// READ-ONLY system-wide reconciliation: fetches current Base44 source counts AND
// current Railway destination counts, compares, checks FK integrity, admin roles,
// owner mappings, Simon identity, duplicates, external_ref coverage, and recent
// Base44 deltas since cutover. Zero writes. Safe to run any time.
router.post('/system-wide-reconciliation', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'systemWideReconciliation.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'systemWideReconciliation.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 300000,
      maxBuffer: 30 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] system-wide-reconciliation process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'system-wide-reconciliation',
      });
    });
  } catch (e) {
    console.error('[cron] system-wide-reconciliation error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /audit-deal-payment-datasets ────────────────────────────────────────
// READ-ONLY audit for the three deal-payment datasets (DealExpensePayment,
// DealCommission, DealLoanPayment) that have ZERO Base44 source records.
// Verifies Base44 count=0, Railway table existence, Railway row count, schema,
// FK constraints, UNIQUE(external_ref), and no inbound FK dependencies. No writes.
router.post('/audit-deal-payment-datasets', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'auditDealPaymentDatasets.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'auditDealPaymentDatasets.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] audit-deal-payment-datasets process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'audit-deal-payment-datasets',
      });
    });
  } catch (e) {
    console.error('[cron] audit-deal-payment-datasets error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /audit-test-probe-fk-references ─────────────────────────────────────
// READ-ONLY horizontal FK audit: enumerates ALL foreign-key constraints that can
// reference the Test Probe lead/appointment using PostgreSQL catalog metadata
// (no predefined list). Counts rows, scans non-FK text/uuid/jsonb references,
// and derives the complete deletion order. BEGIN READ ONLY → ROLLBACK. No writes.
router.post('/audit-test-probe-fk-references', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'auditTestProbeFkReferences.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'auditTestProbeFkReferences.js not found', path: scriptPath });
  }

  try {
    execFile('node', [scriptPath], {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] audit-test-probe-fk-references process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'audit-test-probe-fk-references',
      });
    });
  } catch (e) {
    console.error('[cron] audit-test-probe-fk-references error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /diagnose-deal ──────────────────────────────────────────────────────
// READ-ONLY diagnostic: queries the canonical Railway `deals` table by UUID
// (id) or legacy_base44_id, then checks the linked lead. No writes. Used to
// trace why a Deal Detail page shows "Deal not found" for a real Railway UUID.
router.post('/diagnose-deal', async (req, res) => {
  try {
    const { deal_id } = req.body || {};
    if (!deal_id) return res.status(400).json({ error: 'deal_id required' });

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = UUID_RE.test(String(deal_id));

    // Query by id (UUID) OR legacy_base44_id (TEXT).
    // Use separate params: $1::uuid for id, $2 (text) for legacy_base44_id.
    // Sharing $1 causes PostgreSQL to infer uuid type for BOTH comparisons.
    let dealRows;
    if (isUuid) {
      const { rows } = await query(
        'SELECT * FROM deals WHERE id = $1::uuid OR legacy_base44_id = $2 LIMIT 1',
        [deal_id, deal_id]
      );
      dealRows = rows;
    } else {
      const { rows } = await query(
        'SELECT * FROM deals WHERE legacy_base44_id = $1 LIMIT 1',
        [deal_id]
      );
      dealRows = rows;
    }

    const deal = dealRows[0];
    if (!deal) {
      const { rows: countRows } = await query('SELECT COUNT(*) as cnt FROM deals');
      const { rows: recentRows } = await query(
        'SELECT id, legacy_base44_id, name, lead_id, created_at FROM deals ORDER BY created_at DESC LIMIT 5'
      );
      return res.json({
        found: false,
        deal_id,
        is_uuid: isUuid,
        total_deals: parseInt(countRows[0].cnt, 10),
        recent_deals: recentRows,
      });
    }

    let lead = null;
    if (deal.lead_id) {
      const { rows: leadRows } = await query(
        'SELECT id, external_ref, first_name, last_name, email, phone, status FROM leads WHERE id = $1 LIMIT 1',
        [deal.lead_id]
      );
      lead = leadRows[0] || null;
    }

    res.json({
      found: true,
      deal_id,
      is_uuid: isUuid,
      deal: {
        id: deal.id,
        legacy_base44_id: deal.legacy_base44_id,
        name: deal.name,
        lead_id: deal.lead_id,
        stage: deal.stage,
        amount: deal.amount,
        assigned_rep: deal.assigned_rep,
        created_at: deal.created_at,
        updated_at: deal.updated_at,
      },
      lead,
    });
  } catch (e) {
    console.error('[cron] diagnose-deal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
