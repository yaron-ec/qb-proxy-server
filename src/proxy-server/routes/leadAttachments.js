/* eslint-disable no-undef */
/**
 * /api/v1/lead-attachments — Railway CRM Lead Attachments API.
 *
 *   GET    /               list (filtered by lead_id)
 *   GET    /:id            single
 *   POST   /               create (lead_id + file_url required)
 *   PUT    /:id            update
 *   DELETE /:id            delete
 *
 * Auth: Railway JWT (requireAuth).
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');
const { notifyCrmActivity } = require('../lib/crmActivityNotifier');

const router = express.Router();
router.use(requireAuth);

function serializeAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    lead_id: row.lead_id,
    file_name: row.file_name,
    file_url: row.file_url,
    file_type: row.file_type,
    file_size: row.file_size,
    storage_key: row.storage_key,
    uploaded_by: row.uploaded_by,
    uploaded_at: row.uploaded_at,
    qb_invoice_id: row.qb_invoice_id,
    qb_invoice_number: row.qb_invoice_number,
    invoice_amount: Number(row.invoice_amount) || 0,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
    balance_due: Number(row.balance_due) || 0,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

const FIELDS = ['lead_id', 'file_name', 'file_url', 'file_type', 'file_size', 'storage_key', 'uploaded_by', 'qb_invoice_id', 'qb_invoice_number', 'invoice_amount', 'invoice_date', 'due_date', 'balance_due'];

router.get('/', async (req, res) => {
  try {
    const { lead_id, limit: limitStr } = req.query;
    // P0 DATA ISOLATION: lead_id is REQUIRED. Never return all attachments across leads.
    if (!lead_id) return res.json({ items: [], total: 0 });
    if (!UUID_RE.test(String(lead_id))) return res.json({ items: [], total: 0 });
    const limit = Math.min(parseInt(limitStr || '500', 10), 2000);
    const where = [`lead_id = $1`];
    const params = [lead_id];
    let p = 2;
    const whereClause = `WHERE ${where.join(' AND ')}`;
    const { rows } = await query(`SELECT * FROM lead_attachments ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeAttachment), total: rows.length });
  } catch (e) {
    console.error('[lead-attachments] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.lead_id) return res.status(400).json({ error: 'lead_id required' });
    if (!body.file_url) return res.status(400).json({ error: 'file_url required' });

    const cols = ['uploaded_by', 'uploaded_at'];
    const vals = [req.user.email || null, new Date().toISOString()];
    for (const f of FIELDS) {
      if (body[f] !== undefined) { cols.push(f); vals.push(body[f]); }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO lead_attachments (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);

    // ── Notify admins of the new attachment (best-effort, non-blocking) ─
    try {
      const leadRes = await query(
        `SELECT l.id, l.first_name, l.last_name, o.display_name AS owner_display_name, o.email AS owner_email
         FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`,
        [body.lead_id]
      );
      const lead = leadRes.rows[0];
      if (lead) {
        const leadName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Unknown';
        Promise.resolve().then(() => notifyCrmActivity({
          action: 'attachment_added',
          leadId: lead.id,
          leadName,
          repName: lead.owner_display_name || lead.owner_email || 'Unassigned',
          actorEmail: req.user?.email,
          content: `File attached: ${rows[0].file_name || rows[0].file_url || '(unnamed)'}`,
        })).catch(e => console.error('[lead-attachments] notification failed:', e.message));
      }
    } catch (e) {
      console.error('[lead-attachments] lead fetch for notification failed:', e.message);
    }

    res.status(201).json({ attachment: serializeAttachment(rows[0]) });
  } catch (e) {
    console.error('[lead-attachments] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM lead_attachments WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ attachment: serializeAttachment(rows[0]) });
  } catch (e) {
    console.error('[lead-attachments] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updates = [];
    const params = [];
    let p = 1;
    for (const f of FIELDS) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${p}`); p++; }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no fields to update' });
    updates.push('updated_at = NOW()');
    params.push(req.params.id);
    const { rows } = await query(`UPDATE lead_attachments SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ attachment: serializeAttachment(rows[0]) });
  } catch (e) {
    console.error('[lead-attachments] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM lead_attachments WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[lead-attachments] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;