/* eslint-disable no-undef */
/**
 * /api/v1/deals/:id/timeline — Deal Activity project-history timeline.
 *
 *   GET /api/v1/deals/:id/timeline   -> { events: [...] }
 *
 * Read-only: every event is derived from canonical rows (deals,
 * signnow_documents, lead_attachments, activities) — see lib/dealTimeline.js
 * for exactly which fields feed which event and why. Nothing is written or
 * cached here, so there is no duplicate-event risk from repeated requests,
 * retries, or reopening the Deal.
 *
 * Auth: Railway JWT (requireAuth) + checkDealScope — the same canonical
 * deal-ownership layer routes/dealFinancials.js already uses. A sales_rep
 * cannot read another rep's project timeline merely by knowing the deal id.
 *
 * Mounted at /api/v1/deals (same prefix as routes/deals.js and
 * routes/dealFinancials.js).
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const { checkDealScope } = require('../lib/recordAccess');
const { buildDealTimeline } = require('../lib/dealTimeline');

const router = express.Router();
router.use(requireAuth);

router.get('/:id/timeline', async (req, res) => {
  try {
    const dealId = req.params.id;

    const access = await checkDealScope(req.user, dealId);
    if (!access.allowed) {
      const status = access.reason === 'deal_not_found' ? 404 : 403;
      return res.status(status).json({ error: status === 404 ? 'not_found' : 'forbidden' });
    }

    const { rows: dealRows } = await query('SELECT * FROM deals WHERE id = $1', [dealId]);
    const deal = dealRows[0];
    if (!deal) return res.status(404).json({ error: 'not_found' });

    const [signnowRes, attachmentsRes, activitiesRes] = await Promise.all([
      query('SELECT * FROM signnow_documents WHERE lead_id = $1 ORDER BY created_at ASC', [deal.lead_id]),
      query(
        `SELECT * FROM lead_attachments WHERE lead_id = $1 AND deal_id = $2 AND attachment_kind = 'completion_form' ORDER BY created_at ASC`,
        [deal.lead_id, dealId]
      ),
      query(
        `SELECT * FROM activities WHERE lead_id = $1 AND metadata->>'deal_id' = $2 AND metadata->>'category' = 'financial' ORDER BY created_at ASC`,
        [deal.lead_id, dealId]
      ),
    ]);

    const events = buildDealTimeline(deal, signnowRes.rows, attachmentsRes.rows, activitiesRes.rows);
    res.json({ events });
  } catch (e) {
    console.error('[deal-timeline] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/completion-form — record a manually uploaded completion form ──
// File bytes are already in R2 (uploaded via the existing /api/files/upload
// proxy — see crm-frontend/src/lib/fileUpload.js) before this call; this
// just creates the lead_attachments row (deal_id + attachment_kind set). The
// row's own created_at/uploaded_by/deal_id/lead_id already satisfy the
// auditability requirement (a permanent historical fact, never rewritten by
// a later re-upload — lib/dealTimeline.js emits one event per attachment
// row), so no separate activities note is created here — that would create
// a second, duplicate "Completion Form Uploaded" timeline event alongside
// the one already derived directly from this row.
router.post('/:id/completion-form', async (req, res) => {
  try {
    const dealId = req.params.id;
    const access = await checkDealScope(req.user, dealId);
    if (!access.allowed) {
      const status = access.reason === 'deal_not_found' ? 404 : 403;
      return res.status(status).json({ error: status === 404 ? 'not_found' : 'forbidden' });
    }

    const { rows: dealRows } = await query('SELECT * FROM deals WHERE id = $1', [dealId]);
    const deal = dealRows[0];
    if (!deal) return res.status(404).json({ error: 'not_found' });

    const { file_url, file_name, file_type, file_size, storage_key } = req.body || {};
    if (!file_url) return res.status(400).json({ error: 'file_url required' });

    const uploadedBy = req.user.email || req.user.id || null;
    const { rows } = await query(
      `INSERT INTO lead_attachments
         (lead_id, deal_id, attachment_kind, file_name, file_url, file_type, file_size, storage_key, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'completion_form', $3, $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
      [deal.lead_id, dealId, file_name || null, file_url, file_type || null, file_size || null, storage_key || null, uploadedBy]
    );
    const attachment = rows[0];
    res.status(201).json({ attachment });
  } catch (e) {
    console.error('[deal-timeline] completion-form create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
