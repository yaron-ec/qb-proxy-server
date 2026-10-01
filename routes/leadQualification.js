/* eslint-disable no-undef */
/**
 * /api/v1/leads/:id/qualification — explicit, versioned Qualified decisions
 * (lib/marketing/qualification.js). Qualified is a marketing/funnel
 * attribute, NOT a lead status: nothing here touches leads.status.
 *
 *   GET  /api/v1/leads/:id/qualification   decision history (newest first)
 *   POST /api/v1/leads/:id/qualification   record one decision
 *        body: { criteria: { usable_contact, service_offered, in_service_area,
 *                            not_dnq, not_spam, not_duplicate },   // all booleans
 *                definition_version?: 'v1', notes?, idempotency_key? }
 *        The outcome is derived (all true → qualified); it is never supplied.
 *
 * Auth: admin / manager (a decision affects marketing reporting for every
 * lead source, so it is not left to the lead's own rep for now).
 */
'use strict';
const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');
const { recordQualification, CURRENT_DEFINITION } = require('../lib/marketing/qualification');

const router = express.Router();

router.get('/:id/qualification', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'invalid_id' });
  try {
    const { rows } = await query(
      `SELECT id, outcome, definition_version, criteria, decided_by, decision_source, notes, decided_at, merged_from_lead_id
         FROM lead_qualification_events WHERE lead_id = $1 ORDER BY decided_at DESC`, [req.params.id]);
    res.json({ current_definition: CURRENT_DEFINITION, events: rows });
  } catch (e) {
    console.error('[qualification] list error:', e.message);
    res.status(500).json({ error: 'list_failed' });
  }
});

router.post('/:id/qualification', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'invalid_id' });
  const body = req.body || {};
  try {
    const lead = (await query('SELECT id, merged_into_lead_id FROM leads WHERE id = $1', [req.params.id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'not_found' });
    if (lead.merged_into_lead_id) return res.status(409).json({ error: 'merged', merged_into_lead_id: lead.merged_into_lead_id });
    const key = typeof body.idempotency_key === 'string' && /^[A-Za-z0-9:_-]{8,100}$/.test(body.idempotency_key) ? body.idempotency_key : null;
    const r = await recordQualification({ query }, {
      leadId: lead.id, criteria: body.criteria, version: body.definition_version || CURRENT_DEFINITION,
      decidedBy: req.user && req.user.email, notes: body.notes, idempotencyKey: key,
    });
    res.status(r.duplicate ? 200 : 201).json({ event: r.event, duplicate: r.duplicate });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: 'validation_failed', details: e.details });
    console.error('[qualification] record error:', e.message);
    res.status(500).json({ error: 'record_failed' });
  }
});

module.exports = router;
