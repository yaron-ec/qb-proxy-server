/* eslint-disable no-undef */
/**
 * /api/v1/properties — Railway CRM Properties API.
 *
 *   GET    /               list (filtered by lead_id)
 *   GET    /:id            single
 *   POST   /               create
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

const router = express.Router();
router.use(requireAuth);

function serializeProperty(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    lead_id: row.lead_id,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    property_type: row.property_type,
    square_footage: row.square_footage,
    lot_size: row.lot_size,
    year_built: row.year_built,
    bedrooms: row.bedrooms,
    bathrooms: Number(row.bathrooms) || 0,
    notes: row.notes,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

const FIELDS = ['lead_id', 'address', 'city', 'state', 'zip', 'property_type', 'square_footage', 'lot_size', 'year_built', 'bedrooms', 'bathrooms', 'notes'];

router.get('/', async (req, res) => {
  try {
    const { lead_id, limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr || '500', 10), 2000);
    const where = [];
    const params = [];
    let p = 1;
    if (lead_id) {
      if (!UUID_RE.test(String(lead_id))) return res.json({ items: [], total: 0 });
      where.push(`lead_id = $${p}`); params.push(lead_id); p++;
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM properties ${whereClause} ORDER BY created_at DESC LIMIT $${p}`, [...params, limit]);
    res.json({ items: rows.map(serializeProperty), total: rows.length });
  } catch (e) {
    console.error('[properties] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const cols = [];
    const vals = [];
    for (const f of FIELDS) {
      if (req.body[f] !== undefined) { cols.push(f); vals.push(req.body[f]); }
    }
    if (cols.length === 0) return res.status(400).json({ error: 'no fields provided' });
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await query(`INSERT INTO properties (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`, vals);
    res.status(201).json({ property: serializeProperty(rows[0]) });
  } catch (e) {
    console.error('[properties] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM properties WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ property: serializeProperty(rows[0]) });
  } catch (e) {
    console.error('[properties] get error:', e.message);
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
    const { rows } = await query(`UPDATE properties SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ property: serializeProperty(rows[0]) });
  } catch (e) {
    console.error('[properties] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM properties WHERE id = $1', [req.params.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[properties] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;