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

// ── POST /diagnose-reminder-lead ─────────────────────────────────────────────
// READ-ONLY diagnostic: searches canonical Railway `leads` by phone, name, or
// external_ref, then checks whether the matched lead is present in
// `reminder_leads`. No writes. Used to prove presence/absence without inferring
// from Base44 fields.
router.post('/diagnose-reminder-lead', async (req, res) => {
  try {
    const { phone, first_name, last_name, external_ref } = req.body || {};
    const conditions = [];
    const params = [];
    let idx = 1;

    if (external_ref) {
      conditions.push(`l.external_ref = $${idx++}`);
      params.push(external_ref);
    }
    if (phone) {
      // Normalize: strip non-digits for comparison
      conditions.push(`REGEXP_REPLACE(l.phone, '\\D', '', 'g') = REGEXP_REPLACE($${idx++}, '\\D', '', 'g')`);
      params.push(phone);
    }
    if (first_name && last_name) {
      conditions.push(`LOWER(l.first_name) = LOWER($${idx++}) AND LOWER(l.last_name) = LOWER($${idx++})`);
      params.push(first_name);
      params.push(last_name);
    }

    if (conditions.length === 0) {
      return res.status(400).json({ error: 'At least one of phone, first_name+last_name, or external_ref is required' });
    }

    // Appointments live in a separate `appointments` table (start_at TIMESTAMPTZ).
    // Derive appointment_date/time in Pacific from the earliest active appointment.
    const leadSql = `
      SELECT l.id, l.external_ref, l.first_name, l.last_name, l.email, l.phone,
             l.property_address, l.city, l.project_type, l.follow_up_date,
             l.follow_up_time, l.follow_up_type,
             to_char(appt.start_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS appointment_date,
             to_char(appt.start_at AT TIME ZONE 'America/Los_Angeles', 'HH24:MI') AS appointment_time,
             l.budget_range, l.notes, l.customer_reminders_disabled,
             l.crm_created_date, l.created_at,
             o.display_name AS owner_display_name, o.email AS owner_email
      FROM leads l
      LEFT JOIN owners o ON o.id = l.owner_id
      LEFT JOIN LATERAL (
        SELECT a.start_at FROM appointments a
        WHERE a.lead_id = l.id
          AND a.status IN ('scheduled','confirmed')
        ORDER BY a.start_at ASC
        LIMIT 1
      ) appt ON true
      WHERE ${conditions.join(' OR ')}
      ORDER BY l.created_at DESC
      LIMIT 10`;
    const { rows: leadRows } = await query(leadSql, params);

    // For each matched lead, check if it exists in reminder_leads
    const reminderIdFor = (r) => r.external_ref || r.id;
    const reminderIds = leadRows.map(reminderIdFor);
    let reminderRows = [];
    if (reminderIds.length > 0) {
      const { rows } = await query(
        `SELECT id, follow_up_date, appointment_date, customer_reminders_disabled, updated_at
         FROM reminder_leads WHERE id = ANY($1::text[])`,
        [reminderIds]
      );
      reminderRows = rows;
    }
    const reminderMap = new Map(reminderRows.map(r => [r.id, r]));

    const results = leadRows.map(r => {
      const rid = reminderIdFor(r);
      const rem = reminderMap.get(rid);
      return {
        railway_id: r.id,
        external_ref: r.external_ref,
        reminder_id: rid,
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
        phone: r.phone,
        appointment_date: r.appointment_date,
        appointment_time: r.appointment_time,
        follow_up_date: r.follow_up_date,
        follow_up_time: r.follow_up_time,
        assigned_rep: r.assigned_rep,
        owner_display_name: r.owner_display_name,
        customer_reminders_disabled: r.customer_reminders_disabled,
        crm_created_date: r.crm_created_date,
        in_reminder_leads: !!rem,
        reminder_leads_row: rem || null,
      };
    });

    res.json({
      search_criteria: { phone, first_name, last_name, external_ref },
      matches: results.length,
      leads: results,
    });
  } catch (e) {
    console.error('[cron] diagnose-reminder-lead error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /backfill-reminder-leads ─────────────────────────────────────────────
// Railway-native backfill: reconciles reminder_leads with canonical Railway leads.
// No Base44 dependency. Runs scripts/backfillReminderLeadsFromRailway.js.
// Idempotent: upserts eligible leads, clears stale dates, deletes orphans.
router.post('/backfill-reminder-leads', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'backfillReminderLeadsFromRailway.js');
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: 'backfillReminderLeadsFromRailway.js not found', path: scriptPath });
  }

  const isDryRun = req.body && req.body.dryRun === true;
  const args = [scriptPath];
  if (isDryRun) args.push('--dry-run');

  try {
    execFile('node', args, {
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
      cwd: path.resolve(__dirname, '..'),
    }, (err, stdout, stderr) => {
      if (err && err.code !== 0) {
        console.error('[cron] backfill-reminder-leads process error:', err.message);
      }
      res.json({
        ok: !err || err.code === 0,
        exitCode: err ? err.code : 0,
        stdout,
        stderr: stderr || '',
        job: 'backfill-reminder-leads',
        dryRun: isDryRun,
      });
    });
  } catch (e) {
    console.error('[cron] backfill-reminder-leads error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /diagnose-reminder-delivery ─────────────────────────────────────────
// READ-ONLY diagnostic: traces a lead's full reminder delivery pipeline.
// Queries reminder_claims, email_send_claims, email_send_logs, and Gmail
// message IDs for a given lead_id. No writes. Used for delivery acceptance.
router.post('/diagnose-reminder-delivery', async (req, res) => {
  try {
    const { lead_id, name } = req.body || {};
    if (!lead_id && !name) return res.status(400).json({ error: 'lead_id or name required' });

    // 1. Get the lead from reminder_leads — by UUID or by name
    let leadRows;
    if (name) {
      const parts = name.trim().split(/\s+/);
      const first = parts[0] || '';
      const last = parts.slice(1).join(' ') || '';
      const { rows } = await query(
        `SELECT id, first_name, last_name, email, phone, assigned_rep,
                appointment_date, appointment_time, follow_up_date, follow_up_time, follow_up_type,
                customer_reminders_disabled
         FROM reminder_leads WHERE first_name ILIKE $1 AND last_name ILIKE $2 LIMIT 5`,
        [`%${first}%`, `%${last}%`]
      );
      leadRows = rows;
    } else {
      const { rows } = await query(
        `SELECT id, first_name, last_name, email, phone, assigned_rep,
                appointment_date, appointment_time, follow_up_date, follow_up_time, follow_up_type,
                customer_reminders_disabled
         FROM reminder_leads WHERE id = $1 LIMIT 1`,
        [lead_id]
      );
      leadRows = rows;
    }
    const lead = leadRows[0];
    if (!lead) return res.json({ found: false, lead_id: lead_id || name, message: 'Lead not found in reminder_leads' });
    if (leadRows.length > 1) return res.json({ found: true, multiple: true, leads: leadRows.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name}` })) });
    const effectiveLeadId = lead.id;

    // 2. Get reminder_claims for this lead
    const { rows: claims } = await query(
      `SELECT id, reminder_key, reminder_window, status, owner, sent_at, last_error, last_error_type,
              gmail_message_ids, created_at, appointment_date
       FROM reminder_claims WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [effectiveLeadId]
    );

    // 3. Get email_send_claims matching this lead's reminder keys
    const { rows: emailClaims } = await query(
      `SELECT id, idempotency_key, status, recipient, subject, gmail_message_id, last_error, attempts,
              created_at, sent_at
       FROM email_send_claims
       WHERE idempotency_key LIKE $1
       ORDER BY created_at DESC LIMIT 30`,
      [`%${effectiveLeadId}%`]
    );

    // 4. Get email_send_logs for those claims
    let emailLogs = [];
    if (emailClaims.length > 0) {
      const claimIds = emailClaims.map(c => c.id);
      const { rows: logs } = await query(
        `SELECT id, claim_id, role, recipient, sender, subject, gmail_message_id, status, error, attempts, created_at
         FROM email_send_logs WHERE claim_id::text = ANY($1::text[]) ORDER BY created_at DESC LIMIT 30`,
        [claimIds]
      );
      emailLogs = logs;
    }

    // 5. Summarize delivery evidence
    const customerClaims = emailClaims.filter(c => c.idempotency_key.includes(':customer:'));
    const staffClaims = emailClaims.filter(c => c.idempotency_key.includes(':staff:'));
    const customerLogs = emailLogs.filter(l => l.role === 'customer');
    const staffLogs = emailLogs.filter(l => l.role === 'staff');

    res.json({
      found: true,
      lead: {
        id: lead.id,
        name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
        email: lead.email,
        phone: lead.phone,
        assigned_rep: lead.assigned_rep,
        appointment_date: lead.appointment_date,
        appointment_time: lead.appointment_time,
        customer_reminders_disabled: lead.customer_reminders_disabled,
      },
      reminder_claims: claims.map(c => ({
        window: c.reminder_window,
        status: c.status,
        sent_at: c.sent_at,
        gmail_message_ids: c.gmail_message_ids,
        last_error: c.last_error,
        last_error_type: c.last_error_type,
        created_at: c.created_at,
      })),
      customer_delivery: {
        email_exists: !!lead.email,
        claims_count: customerClaims.length,
        claims: customerClaims.map(c => ({
          status: c.status,
          recipient: c.recipient,
          subject: c.subject,
          gmail_message_id: c.gmail_message_id,
          sent_at: c.sent_at,
          last_error: c.last_error,
        })),
        logs_count: customerLogs.length,
        logs: customerLogs.map(l => ({
          status: l.status,
          recipient: l.recipient,
          gmail_message_id: l.gmail_message_id,
          subject: l.subject,
        })),
        gmail_message_ids: customerLogs.filter(l => l.gmail_message_id).map(l => l.gmail_message_id),
      },
      staff_delivery: {
        claims_count: staffClaims.length,
        claims: staffClaims.map(c => ({
          status: c.status,
          recipient: c.recipient,
          subject: c.subject,
          gmail_message_id: c.gmail_message_id,
          sent_at: c.sent_at,
          last_error: c.last_error,
        })),
        logs_count: staffLogs.length,
        logs: staffLogs.map(l => ({
          status: l.status,
          recipient: l.recipient,
          gmail_message_id: l.gmail_message_id,
          subject: l.subject,
        })),
        gmail_message_ids: staffLogs.filter(l => l.gmail_message_id).map(l => l.gmail_message_id),
      },
    });
  } catch (e) {
    console.error('[cron] diagnose-reminder-delivery error:', e.message);
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
    // Cast $1 to uuid for the id comparison — PostgreSQL cannot compare text = uuid.
    let dealRows;
    if (isUuid) {
      // Use separate params: $1::uuid for id, $2 (text) for legacy_base44_id.
      // Sharing $1 causes PostgreSQL to infer uuid type for BOTH comparisons.
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
      // Not found — check total deal count and recent deals for context
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

    // Deal found — check linked lead
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

// ── POST /reconcile-calendar-appointments ─────────────────────────────────────
// Reconciles leads that have follow_up_date + follow_up_type (Phone Call or
// Meeting) but NO active appointment. Creates appointments + calendar outbox
// entries for them so the outbox worker creates the Google Calendar events.
// Also resets 'dead' calendar_outbox rows to 'pending' so the worker retries.
// Idempotent: leads with existing active appointments are skipped.
router.post('/reconcile-calendar-appointments', async (req, res) => {
  const { pool } = require('../db/client');
  const calendarOutbox = require('../lib/booking/calendarOutbox');
  const { toUtcIso } = require('../lib/booking/slotBlocking');

  try {
    // 1. Find leads with follow_up_date + follow_up_type but no active appointment
    const { rows: orphanLeads } = await query(`
      SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
      FROM leads l
      LEFT JOIN owners o ON o.id = l.owner_id
      WHERE l.follow_up_date IS NOT NULL
        AND l.follow_up_type IN ('Phone Call', 'Meeting')
        AND NOT EXISTS (
          SELECT 1 FROM appointments a
          WHERE a.lead_id = l.id AND a.status IN ('scheduled', 'confirmed')
        )
      LIMIT 200
    `);

    let created = 0, skipped = 0, errors = 0;
    const errorDetails = [];

    for (const lead of orphanLeads) {
      try {
        const apptDate = lead.follow_up_date;
        const apptTime = lead.follow_up_time || '09:00';
        const isPhoneCall = lead.follow_up_type === 'Phone Call';
        const startAt = new Date(toUtcIso(apptDate, apptTime, 'America/Los_Angeles'));
        const durationMin = 60;
        const endAt = new Date(startAt.getTime() + durationMin * 60 * 1000);
        const busyStart = isPhoneCall ? startAt : new Date(startAt.getTime() - 60 * 60 * 1000);
        const busyEnd = isPhoneCall ? endAt : new Date(endAt.getTime() + 60 * 60 * 1000);

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const typeRes = await client.query('SELECT id FROM appointment_types ORDER BY id LIMIT 1');
          if (!typeRes.rows[0]) {
            await client.query('ROLLBACK');
            errors++;
            errorDetails.push({ lead_id: lead.id, error: 'No appointment types configured' });
            continue;
          }
          const typeId = typeRes.rows[0].id;
          const idempotencyKey = `reconcile:${lead.id}:${apptDate}:${apptTime}`;
          const insRes = await client.query(
            `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status, calendar_sync_status, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, tstzrange($7, $8, '[)'), 'scheduled', 'pending', $9)
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING *`,
            [lead.id, lead.owner_id, typeId, startAt.toISOString(), endAt.toISOString(),
             'America/Los_Angeles', busyStart.toISOString(), busyEnd.toISOString(), idempotencyKey]
          );
          const newAppt = insRes.rows[0];
          if (newAppt) {
            await calendarOutbox.enqueueCreate(client, newAppt, lead, lead.owner_email, isPhoneCall);
          }
          await client.query('COMMIT');
          created++;
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          errors++;
          errorDetails.push({ lead_id: lead.id, error: e.message.substring(0, 150) });
        } finally {
          client.release();
        }
      } catch (e) {
        errors++;
        errorDetails.push({ lead_id: lead.id, error: e.message.substring(0, 150) });
      }
    }

    // 2. Reset 'dead' calendar_outbox rows to 'pending' (retry)
    let resetDead = 0;
    try {
      const { rowCount } = await query(`
        UPDATE calendar_outbox SET status = 'pending', next_attempt_at = NOW(),
               claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
        WHERE status = 'dead'
      `);
      resetDead = rowCount || 0;
    } catch (e) {
      console.warn('[cron] reconcile-calendar: dead reset failed:', e.message);
    }

    res.json({
      ok: true,
      job: 'reconcile-calendar-appointments',
      orphan_leads_found: orphanLeads.length,
      appointments_created: created,
      errors,
      error_details: errorDetails.slice(0, 10),
      dead_outbox_reset: resetDead,
    });
  } catch (e) {
    console.error('[cron] reconcile-calendar-appointments error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /diagnose-calendar-outbox ──────────────────────────────────────────
// READ-ONLY diagnostic: queries calendar_outbox status counts, recent entries,
// and appointment sync state. No writes. Used to prove the outbox worker is
// processing entries and Google Calendar events are being created/updated/cancelled.
router.post('/diagnose-calendar-outbox', async (req, res) => {
  try {
    const { lead_id } = req.body || {};

    // 1. Outbox status counts
    const { rows: statusRows } = await query(`
      SELECT status, count(*) as cnt
      FROM calendar_outbox
      GROUP BY status
      ORDER BY status
    `);
    const statusCounts = {};
    for (const r of statusRows) statusCounts[r.status] = parseInt(r.cnt, 10);

    // 2. Recent outbox entries (last 20)
    const { rows: recentRows } = await query(`
      SELECT id, appointment_id, action, slot, version, google_event_id,
             status, attempts, last_error, created_at, updated_at, next_attempt_at
      FROM calendar_outbox
      ORDER BY created_at DESC
      LIMIT 20
    `);

    // 3. Appointments with sync state
    let appointmentStats = {};
    const { rows: apptStatsRows } = await query(`
      SELECT calendar_sync_status, count(*) as cnt
      FROM appointments
      GROUP BY calendar_sync_status
    `);
    for (const r of apptStatsRows) appointmentStats[r.calendar_sync_status || 'null'] = parseInt(r.cnt, 10);

    // 4. Appointments with google_event_id set (proves worker processed creates)
    const { rows: syncedAppts } = await query(`
      SELECT a.id, a.lead_id, a.start_at, a.end_at, a.status, a.calendar_sync_status,
             a.google_event_id, a.google_travel_event_id, a.calendar_synced_at,
             l.first_name, l.last_name, l.follow_up_type
      FROM appointments a
      LEFT JOIN leads l ON l.id = a.lead_id
      WHERE a.google_event_id IS NOT NULL
      ORDER BY a.calendar_synced_at DESC
      LIMIT 10
    `);

    // 5. Appointments NOT synced (pending or error)
    const { rows: unsyncedAppts } = await query(`
      SELECT a.id, a.lead_id, a.start_at, a.status, a.calendar_sync_status,
             a.google_event_id, a.google_travel_event_id,
             l.first_name, l.last_name, l.follow_up_type
      FROM appointments a
      LEFT JOIN leads l ON l.id = a.lead_id
      WHERE a.calendar_sync_status IS NULL OR a.calendar_sync_status != 'synced'
      ORDER BY a.start_at DESC
      LIMIT 10
    `);

    // 6. If lead_id specified, get that lead's outbox entries
    let leadOutbox = null;
    if (lead_id) {
      const { rows: leadAppts } = await query(
        `SELECT id, start_at, end_at, status, calendar_sync_status,
                google_event_id, google_travel_event_id, calendar_synced_at
         FROM appointments WHERE lead_id = $1 ORDER BY start_at DESC LIMIT 5`,
        [lead_id]
      );
      const apptIds = leadAppts.map(a => a.id);
      let leadOutboxRows = [];
      if (apptIds.length > 0) {
        const { rows } = await query(
          `SELECT id, appointment_id, action, slot, version, google_event_id,
                  status, attempts, last_error, created_at, updated_at
           FROM calendar_outbox WHERE appointment_id = ANY($1::uuid[])
           ORDER BY created_at DESC LIMIT 20`,
          [apptIds]
        );
        leadOutboxRows = rows;
      }
      leadOutbox = { appointments: leadAppts, outbox: leadOutboxRows };
    }

    res.json({
      outbox_status_counts: statusCounts,
      appointment_sync_counts: appointmentStats,
      recent_outbox: recentRows.map(r => ({
        action: r.action,
        status: r.status,
        google_event_id: r.google_event_id,
        attempts: r.attempts,
        last_error: r.last_error ? r.last_error.substring(0, 100) : null,
        created_at: r.created_at,
        updated_at: r.updated_at
      })),
      synced_appointments: syncedAppts.map(a => ({
        id: a.id,
        lead: a.first_name ? `${a.first_name} ${a.last_name}` : null,
        follow_up_type: a.follow_up_type,
        start_at: a.start_at,
        status: a.status,
        calendar_sync_status: a.calendar_sync_status,
        google_event_id: a.google_event_id,
        google_travel_event_id: a.google_travel_event_id,
        synced_at: a.calendar_synced_at
      })),
      unsynced_appointments: unsyncedAppts.map(a => ({
        id: a.id,
        lead: a.first_name ? `${a.first_name} ${a.last_name}` : null,
        follow_up_type: a.follow_up_type,
        start_at: a.start_at,
        status: a.status,
        calendar_sync_status: a.calendar_sync_status,
        google_event_id: a.google_event_id
      })),
      lead_specific: leadOutbox,
    });
  } catch (e) {
    console.error('[cron] diagnose-calendar-outbox error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /drain-calendar-outbox ──────────────────────────────────────────────
// Drains the calendar_outbox: reaps stuck 'processing' rows, then claims and
// processes pending/failed rows via the canonical calendarOutbox library.
//
// CANONICAL DRAINER: noble-illumination (scripts/calendarOutboxWorker.js,
// continuous loop). This endpoint is a MANUAL BACKUP only — it is NOT invoked
// by any Railway cron or scheduler. artistic-determination (the */15 cron)
// runs reminderWorker.js only and does NOT call this endpoint.
//
// Uses the SAME lib/booking/calendarOutbox.js as the standalone worker.
// The FOR UPDATE SKIP LOCKED claim pattern prevents duplicate processing
// even if both run concurrently. Idempotency keys + deterministic Google
// event IDs prevent duplicate events on retry.
//
// No Base44. No direct Google API calls from the caller. Uses the durable
// outbox pattern with service-account DWD impersonation.
router.post('/drain-calendar-outbox', async (req, res) => {
  try {
    const { pool } = require('../db/client');
    const outbox = require('../lib/booking/calendarOutbox');

    const workerId = `cron-drain-${process.pid}-${Date.now()}`;
    const opts = {
      batchSize: parseInt(process.env.CALENDAR_OUTBOX_BATCH || '20', 10),
      leaseMs: parseInt(process.env.CALENDAR_OUTBOX_LEASE_MS || '60000', 10),
    };

    // 1. Reap stuck 'processing' rows whose lease expired → back to 'pending'
    await outbox.reapStuck(pool, opts.leaseMs);

    // 2. Claim + process pending/failed rows (FOR UPDATE SKIP LOCKED)
    const result = await outbox.claimAndProcess(pool, workerId, opts);

    // 3. Get current status counts for the response
    const { rows: statusRows } = await query(`
      SELECT status, count(*) as cnt FROM calendar_outbox GROUP BY status ORDER BY status
    `);
    const statusCounts = {};
    for (const r of statusRows) statusCounts[r.status] = parseInt(r.cnt, 10);

    res.json({
      ok: true,
      job: 'drain-calendar-outbox',
      worker_id: workerId,
      claimed: result.claimed,
      processed: result.processed,
      remaining: statusCounts,
    });
  } catch (e) {
    console.error('[cron] drain-calendar-outbox error:', e.message);
    res.status(500).json({ error: e.message, job: 'drain-calendar-outbox' });
  }
});

// ── POST /reset-calendar-outbox-stuck — reset stuck pending/failed outbox rows ──
// Resets calendar_outbox rows that are stuck in 'pending' or 'failed' with
// future next_attempt_at (retry backoff) back to 'pending' with immediate
// next_attempt_at = NOW(). Also resets 'dead' rows. Use when the standalone
// calendar-outbox-worker is down and the backlog is growing.
router.post('/reset-calendar-outbox-stuck', async (req, res) => {
  try {
    const { rowCount } = await query(`
      UPDATE calendar_outbox
      SET status = 'pending', next_attempt_at = NOW(),
          claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
      WHERE status IN ('pending', 'failed', 'dead', 'processing')
        AND (next_attempt_at IS NULL OR next_attempt_at > NOW() OR status IN ('dead', 'processing'))
    `);
    const { rows: statusRows } = await query(`
      SELECT status, count(*) as cnt FROM calendar_outbox GROUP BY status ORDER BY status
    `);
    const statusCounts = {};
    for (const r of statusRows) statusCounts[r.status] = parseInt(r.cnt, 10);
    res.json({ ok: true, reset: rowCount, remaining: statusCounts, job: 'reset-calendar-outbox-stuck' });
  } catch (e) {
    console.error('[cron] reset-calendar-outbox-stuck error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /diagnose-watchdog — runs watchdog probes inline and returns results ──
// Diagnoses why the production-watchdog cron service might be failing.
// Runs the SAME logic as productionWatchdog.js but returns results instead
// of calling process.exit(). This reveals the exact failure point.
router.post('/diagnose-watchdog', async (req, res) => {
  try {
    const db = require('../db/client');
    const { getMonitoredServices } = require('../lib/monitoring/serviceInventory');
    const { probeService } = require('../lib/monitoring/healthProbes');
    const crashLoop = require('../lib/monitoring/crashLoopDetector');
    const { verifyAndPromote } = require('../lib/monitoring/knownGoodBaseline');
    const { dispatchMonitoringAlert } = require('../lib/monitoring/alertDispatcher');
    const { evaluateRecovery } = require('../lib/monitoring/recoveryPolicy');

    const steps = [];

    // Step 1: ensureSchema
    try {
      await db.ensureSchema();
      steps.push({ step: 'ensureSchema', ok: true });
    } catch (e) {
      steps.push({ step: 'ensureSchema', ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') });
      return res.json({ ok: false, steps, fatal: 'ensureSchema failed' });
    }

    // Step 2: Check monitoring tables exist
    try {
      const { rows } = await db.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('monitoring_health_checks', 'monitoring_incidents', 'monitoring_known_good')
        ORDER BY table_name
      `);
      steps.push({ step: 'checkTables', ok: true, tables: rows.map(r => r.table_name) });
    } catch (e) {
      steps.push({ step: 'checkTables', ok: false, error: e.message });
    }

    // Step 3: Get monitored services
    let services;
    try {
      services = getMonitoredServices();
      steps.push({ step: 'getServices', ok: true, count: services.length, ids: services.map(s => s.id) });
    } catch (e) {
      steps.push({ step: 'getServices', ok: false, error: e.message });
      return res.json({ ok: false, steps, fatal: 'getMonitoredServices failed' });
    }

    // Step 4: Probe each service
    const baseUrl = process.env.CRM_API_URL || `http://localhost:${process.env.PORT || 3000}`;
    const probeResults = [];
    for (const service of services) {
      try {
        const result = await probeService(service, baseUrl);
        probeResults.push({ serviceId: service.id, healthy: result.healthy, error: result.error, checkType: result.checkType });

        // Step 4a: recordHealthCheck
        try {
          await db.query(
            `INSERT INTO monitoring_health_checks (service_id, check_type, healthy, response_time_ms, http_status, details, error)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [result.serviceId, result.checkType, result.healthy, result.responseTimeMs || null,
             result.httpStatus || null, JSON.stringify(result.details || {}), result.error || null]
          );
        } catch (e) {
          probeResults.push({ serviceId: service.id, step: 'recordHealthCheck', error: e.message });
        }

        // Step 4b: handleSuccess or handleFailure
        if (result.healthy) {
          try {
            const { resolved, incident } = await crashLoop.recordSuccess(service.id);
            const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA;
            const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
            if (commitSha && service.classification === 'CRITICAL_PRODUCTION') {
              await verifyAndPromote(service.id, commitSha, deploymentId, result);
            }
          } catch (e) {
            probeResults.push({ serviceId: service.id, step: 'handleSuccess', error: e.message, stack: e.stack?.split('\n').slice(0, 3).join('\n') });
          }
        } else {
          try {
            const { incident, isNew, isCrashLoop } = await crashLoop.recordFailure(
              service.id, result.error || 'Unknown failure', result.checkType, result.details || {}
            );
            if (incident) {
              const shouldAlert = isNew || isCrashLoop || (incident.failure_count % 5 === 0);
              if (shouldAlert) {
                const recoveryDecision = evaluateRecovery(service.id, {
                  errorSummary: result.error, isCrashLoop, isNewIncident: isNew, previousHealthy: !isCrashLoop,
                });
                await dispatchMonitoringAlert({
                  serviceId: service.id, level: isCrashLoop ? 'critical' : 'warning',
                  errorSummary: result.error, errorType: result.checkType, httpStatus: result.httpStatus,
                  isCrashLoop, recoveryAction: recoveryDecision.action, recoveryResult: recoveryDecision.reason, logLines: [],
                });
                await crashLoop.markAlertSent(incident.id);
              }
            }
          } catch (e) {
            probeResults.push({ serviceId: service.id, step: 'handleFailure', error: e.message, stack: e.stack?.split('\n').slice(0, 3).join('\n') });
          }
        }
      } catch (e) {
        probeResults.push({ serviceId: service.id, step: 'probe', error: e.message });
      }
    }

    res.json({
      ok: true,
      steps,
      baseUrl,
      probeResults,
      summary: {
        total: probeResults.filter(r => r.healthy !== undefined).length,
        healthy: probeResults.filter(r => r.healthy === true).length,
        unhealthy: probeResults.filter(r => r.healthy === false).length,
        errors: probeResults.filter(r => r.error && r.step).length,
      },
    });
  } catch (e) {
    console.error('[cron] diagnose-watchdog error:', e.message);
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 10).join('\n') });
  }
});

// ── POST /audit-reminder-ownership — TEMPORARY READ-ONLY diagnostic for retirement proof ──
// Proves the canonical Railway reminder-worker is the sole production sender.
// Queries email_send_logs, reminder_heartbeats, reminder_claims. No writes.
// TO BE REMOVED after adaptable-cooperation retirement is complete.
router.post('/audit-reminder-ownership', async (req, res) => {
  try {
    const sinceHours = parseInt(req.body?.hours || '168', 10); // 7 days
    const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();

    // 1. Email send logs by role+status (last N hours)
    const { rows: roleRows } = await query(`
      SELECT role, status, count(*) as cnt, max(created_at) as last_at
      FROM email_send_logs WHERE created_at >= $1
      GROUP BY role, status ORDER BY role, status
    `, [since]);
    const byRole = {};
    for (const r of roleRows) {
      if (!byRole[r.role]) byRole[r.role] = {};
      byRole[r.role][r.status] = { count: parseInt(r.cnt, 10), last_at: r.last_at };
    }

    // 2. Recent sent reminder emails (proves dryRun=false)
    const { rows: sentReminders } = await query(`
      SELECT role, recipient, subject, gmail_message_id, created_at
      FROM email_send_logs
      WHERE created_at >= $1 AND role LIKE '%reminder%' AND status = 'sent'
      ORDER BY created_at DESC LIMIT 10
    `, [since]);

    // 3. Reminder heartbeats (proves worker ran)
    const { rows: heartbeats } = await query(`
      SELECT source, status, created_at FROM reminder_heartbeats
      ORDER BY created_at DESC LIMIT 10
    `).catch(() => []);

    // 4. Reminder claims summary (proves idempotent execution)
    const { rows: claimSummary } = await query(`
      SELECT status, count(*) as cnt, max(created_at) as last_at
      FROM reminder_claims GROUP BY status ORDER BY status
    `).catch(() => []);

    // 5. Failed invoice emails (proves whether retryFailedInvoices has work)
    const { rows: failedInvoices } = await query(`
      SELECT count(*) as cnt FROM invoices WHERE email_delivery_status = 'failed'
    `).catch(() => []);

    // 6. Check if ANY Base44 function calls were logged recently (proves adaptable-cooperation 405s)
    const { rows: base44Calls } = await query(`
      SELECT count(*) as cnt FROM email_send_logs
      WHERE created_at >= $1 AND role LIKE '%base44%'
    `, [since]).catch(() => []);

    res.json({
      ok: true,
      since_hours: sinceHours,
      sends_by_role: byRole,
      recent_sent_reminders: sentReminders.map(r => ({
        role: r.role, recipient: r.recipient, has_gmail_id: !!r.gmail_message_id, created_at: r.created_at,
      })),
      reminder_worker_heartbeats: heartbeats,
      reminder_claim_summary: claimSummary.map(c => ({ status: c.status, count: parseInt(c.cnt, 10), last_at: c.last_at })),
      failed_invoice_count: parseInt(failedInvoices[0]?.cnt || 0, 10),
      base44_function_calls_recent: parseInt(base44Calls[0]?.cnt || 0, 10),
      canonical_reminder_active: Object.keys(byRole).some(k => k.includes('reminder') && byRole[k]['sent']),
    });
  } catch (e) {
    console.error('[cron] audit-reminder-ownership error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /run-reminder-engine — manually trigger the reminder engine ──────────
// Runs one pass of the appointment reminder engine with dryRun=false (real sends).
// Used for end-to-end verification of the reminder pipeline.
router.post('/run-reminder-engine', async (req, res) => {
  try {
    const engine = require('../lib/reminderEngine');
    const phoneEngine = require('../lib/phoneCallReminders');
    // FORCED dryRun=true — artistic-determination (reminderWorker.js) is the
    // ONE canonical execution path for real sends. This endpoint is diagnostic
    // only and must NOT provide a duplicate production execution path.
    const apt = await engine.processReminders({ dryRun: true, triggeredBy: 'manual-diagnostic' });
    const phone = await phoneEngine.processPhoneCallReminders({ dryRun: true, triggeredBy: 'manual-diagnostic' });
    res.json({ ok: true, appointment: apt, phone });
  } catch (e) {
    console.error('[cron] run-reminder-engine error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;