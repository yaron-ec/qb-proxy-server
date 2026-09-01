/* eslint-disable no-undef */
/**
 * /api/v1/sync-cursors — Railway CRM Sync Cursors API.
 *
 *   GET    /               list all cursors (admin only)
 *   GET    /:integration   get cursor by integration name
 *   PUT    /:integration   upsert cursor (admin only)
 *   DELETE /:integration   delete cursor (admin only)
 *
 * Auth: Railway JWT (requireAuth). Admin only for all operations.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('admin'));

function serializeCursor(row) {
  if (!row) return null;
  return {
    id: row.id,
    integration: row.integration,
    last_successful_sync_at: row.last_successful_sync_at,
    last_cursor: row.last_cursor,
    last_record_id: row.last_record_id,
    last_updated_timestamp: row.last_updated_timestamp,
    total_synced: row.total_synced || 0,
    last_sync_summary: row.last_sync_summary || {},
    is_full_sync_in_progress: row.is_full_sync_in_progress || false,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM sync_cursors ORDER BY integration ASC');
    res.json({ items: rows.map(serializeCursor), total: rows.length });
  } catch (e) {
    console.error('[sync-cursors] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:integration', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM sync_cursors WHERE integration = $1', [req.params.integration]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ cursor: serializeCursor(rows[0]) });
  } catch (e) {
    console.error('[sync-cursors] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/:integration', async (req, res) => {
  try {
    const { integration } = req.params;
    const body = req.body || {};
    const FIELDS = ['last_successful_sync_at', 'last_cursor', 'last_record_id', 'last_updated_timestamp', 'total_synced', 'last_sync_summary', 'is_full_sync_in_progress'];

    const cols = ['integration'];
    const vals = [integration];
    for (const f of FIELDS) {
      if (body[f] !== undefined) {
        cols.push(f);
        vals.push(f === 'last_sync_summary' ? JSON.stringify(body[f]) : body[f]);
      }
    }
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const setParts = cols.slice(1).map((c, i) => `${c} = $${i + 2}`);
    setParts.push('updated_at = NOW()');

    const sql = `INSERT INTO sync_cursors (${cols.join(', ')}) VALUES (${placeholders})
      ON CONFLICT (integration) DO UPDATE SET ${setParts.join(', ')} RETURNING *`;
    const { rows } = await query(sql, vals);
    res.json({ cursor: serializeCursor(rows[0]) });
  } catch (e) {
    console.error('[sync-cursors] put error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:integration', async (req, res) => {
  try {
    await query('DELETE FROM sync_cursors WHERE integration = $1', [req.params.integration]);
    res.json({ success: true, integration: req.params.integration });
  } catch (e) {
    console.error('[sync-cursors] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;