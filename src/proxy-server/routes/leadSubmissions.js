/* eslint-disable no-undef */
/**
 * /api/v1/lead-submissions — Native Railway submission history for Lead Detail.
 *
 *   GET  /api/v1/lead-submissions/by-external/:externalRef  — list submissions for a lead
 *   POST /api/v1/lead-submissions/by-external/:externalRef  — create a submission record
 *
 * Reads from the `lead_submissions` Postgres table. Replaces the Base44
 * LeadSubmission entity.
 *
 * Auth: Railway JWT (requireAuth). All roles can read; admin/manager can create.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { resolveLeadByIdentifier } = require('../lib/leadResolver');

const router = express.Router();
router.use(requireAuth);

const requireAdminManager = requireRole('admin', 'manager');

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    submitted_at: row.submitted_at,
    source: row.source,
    form_type: row.form_type,
    project_type: row.project_type,
    message: row.message,
    assigned_rep_at_time: row.assigned_rep_at_time,
    lead_status_at_time: row.lead_status_at_time,
    submission_number: row.submission_number,
    was_reactivation: row.was_reactivation,
    previous_status: row.previous_status,
    created_date: row.created_at,
  };
}

// ── GET /by-external/:externalRef — list submissions for a lead ─────────────
router.get('/by-external/:externalRef', async (req, res) => {
  try {
    const { externalRef } = req.params;
    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    const { rows } = await query(
      `SELECT * FROM lead_submissions WHERE lead_id = $1 ORDER BY submitted_at DESC LIMIT 100`,
      [lead.id]
    );
    res.json({ items: rows.map(serialize), total: rows.length });
  } catch (e) {
    console.error('[lead-submissions] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /by-external/:externalRef — create a submission record ─────────────
router.post('/by-external/:externalRef', requireAdminManager, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });

    const b = req.body || {};
    const { source, form_type, project_type, message } = b;

    // Determine submission number (count existing + 1)
    const countRes = await query(
      'SELECT COUNT(*) as cnt FROM lead_submissions WHERE lead_id = $1',
      [lead.id]
    );
    const submissionNumber = parseInt(countRes.rows[0].cnt, 10) + 1;

    // Check if this is a reactivation (lead was previously closed/lost)
    const wasReactivation = ['Lost', 'DNQ', 'No show'].includes(lead.status);
    const previousStatus = wasReactivation ? lead.status : null;

    const ins = await query(
      `INSERT INTO lead_submissions
         (lead_id, source, form_type, project_type, message,
          assigned_rep_at_time, lead_status_at_time, submission_number,
          was_reactivation, previous_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [lead.id, source || null, form_type || null, project_type || null, message || null,
       lead.owner_name || null, lead.status || null, submissionNumber,
       wasReactivation, previousStatus]
    );

    res.status(201).json({ submission: serialize(ins.rows[0]) });
  } catch (e) {
    console.error('[lead-submissions] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;