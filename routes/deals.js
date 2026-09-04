/* eslint-disable no-undef */
'use strict';
/**
 * /api/v1/deals — Railway CRM Sales (Deal) CRUD API (Stage 2, corrected).
 *
 *   GET    /api/v1/deals            list (owner-scoped, filtered)
 *   GET    /api/v1/deals/:id        single deal (owner-scoped)
 *   POST   /api/v1/deals            create  (lead_id = Railway UUID, required)
 *   PUT    /api/v1/deals/:id        update (partial; lead_id + legacy_* immutable)
 *   DELETE /api/v1/deals/:id        delete  (ADMIN ONLY)
 *
 * Canonical IDs are Railway UUIDs (deal.id, deal.lead_id). Legacy Base44 IDs
 * (legacy_base44_id, legacy_base44_lead_id) may be supplied on CREATE as
 * migration metadata and are returned in responses, but they are NEVER
 * required for normal CRUD and CANNOT be changed after create.
 *
 * Auth: Railway JWT (requireAuth). RBAC (target business rules):
 *   read:   admin all, manager all, sales_rep own, office denied
 *   create: admin, manager, sales_rep
 *   update: admin, manager (all), sales_rep (own)
 *   delete: ADMIN ONLY
 *
 * Mounted BEFORE routes/dealFinancials.js (which owns GET /:id/financials).
 * The CRUD GET /:id matches one segment only, so /:id/financials still
 * reaches dealFinancials.
 */
const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');
const {
  serializeDeal, resolveDealScope, repMatchCandidates,
  canAccessDeal, canWriteDeal, validateDealPayload, computePaymentStatus,
  UUID_RE,
} = require('../lib/dealModel');
const { notifyCrmActivity } = require('../lib/crmActivityNotifier');

// ── Deal notification helper (best-effort, non-blocking) ─────────────────────
async function sendDealNotification(action, deal, actorEmail, changes) {
  if (!deal) return;
  try {
    const leadRes = await query(
      `SELECT l.id, l.first_name, l.last_name, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`,
      [deal.lead_id]
    );
    const lead = leadRes.rows[0];
    const leadName = lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : (deal.name || 'Unknown');
    const repName = lead ? (lead.owner_display_name || lead.owner_email || 'Unassigned') : (deal.assigned_rep || 'Unassigned');
    Promise.resolve().then(() => notifyCrmActivity({
      action,
      leadId: lead ? lead.id : null,
      leadName,
      repName,
      actorEmail,
      changes: changes || [],
    })).catch(e => console.error('[deals] notification failed:', action, e.message));
  } catch (e) {
    console.error('[deals] lead fetch for notification failed:', e.message);
  }
}

// ── Deal diff helper ─────────────────────────────────────────────────────────
const DEAL_DIFF_FIELDS = [
  { col: 'stage', label: 'Stage' },
  { col: 'amount', label: 'Amount' },
  { col: 'contract_amount', label: 'Contract Amount' },
  { col: 'close_date', label: 'Close Date' },
  { col: 'work_start_date', label: 'Work Start' },
  { col: 'work_end_date', label: 'Work End' },
  { col: 'assigned_rep', label: 'Assigned Rep' },
  { col: 'notes', label: 'Notes' },
];

function computeDealDiff(oldDeal, newDeal) {
  const changes = [];
  for (const { col, label } of DEAL_DIFF_FIELDS) {
    const oldVal = oldDeal ? String(oldDeal[col] == null ? '' : oldDeal[col]) : '';
    const newVal = newDeal ? String(newDeal[col] == null ? '' : newDeal[col]) : '';
    if (oldVal !== newVal) {
      changes.push({ label, prev: oldVal || '\u2014', next: newVal || '\u2014' });
    }
  }
  return changes;
}

const router = express.Router();
router.use(requireAuth);

// ── Safe identifier resolution ────────────────────────────────────────────────
// PostgreSQL throws "invalid input syntax for type uuid" if a non-UUID string
// is compared against a uuid column. This helper builds a WHERE clause that
// only compares against `id` when the identifier is a valid UUID, and always
// compares against legacy_base44_id (TEXT). Returns { whereSql, params }.
function dealIdWhere(identifier) {
  if (UUID_RE.test(String(identifier))) {
    // Use separate params: $1::uuid for id, $2 (text) for legacy_base44_id.
    // Sharing $1 causes PostgreSQL to infer uuid type for BOTH comparisons,
    // making legacy_base44_id = $1 fail with "operator does not exist: text = uuid".
    return { whereSql: 'id = $1::uuid OR legacy_base44_id = $2', params: [identifier, identifier] };
  }
  return { whereSql: 'legacy_base44_id = $1', params: [identifier] };
}

// ── GET / — list (owner-scoped, filtered) ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const scope = resolveDealScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });

    const { stage, lead_id, assigned_rep, search, sort = '-created_date', limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr || '2000', 10), 5000);

    const where = [];
    const params = [];
    let p = 1;

    if (scope.scoped) {
      const cands = repMatchCandidates(req.user);
      if (cands.length === 0) return res.json({ items: [], total: 0 });
      where.push(`(lower(d.assigned_rep) = ANY($${p}::text[]) OR d.created_by = $${p + 1})`);
      params.push(cands, req.user.email || req.user.id || '');
      p += 2;
    }
    if (stage && stage !== 'all') { where.push(`d.stage = $${p}`); params.push(stage); p++; }
    if (lead_id) {
      if (!UUID_RE.test(String(lead_id))) return res.json({ items: [], total: 0 });
      where.push(`d.lead_id = $${p}`); params.push(lead_id); p++;
    }
    if (assigned_rep && assigned_rep !== 'all' && (req.user.role === 'admin' || req.user.role === 'manager')) {
      where.push(`lower(d.assigned_rep) = lower($${p})`); params.push(assigned_rep); p++;
    }
    if (search) {
      where.push(`(d.name ILIKE $${p} OR d.project_type ILIKE $${p} OR d.property_address ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    let orderCol = 'd.created_at';
    let orderDir = 'DESC';
    if (sort === '-created_date') { orderCol = 'd.created_at'; orderDir = 'DESC'; }
    else if (sort === 'created_date') { orderCol = 'd.created_at'; orderDir = 'ASC'; }
    else if (sort === '-updated_date') { orderCol = 'd.updated_at'; orderDir = 'DESC'; }
    else if (sort === '-sold_date') { orderCol = 'd.sold_date'; orderDir = 'DESC NULLS LAST'; }
    else if (sort === 'sold_date') { orderCol = 'd.sold_date'; orderDir = 'ASC NULLS LAST'; }
    else if (sort === '-amount') { orderCol = 'd.amount'; orderDir = 'DESC NULLS LAST'; }
    else if (sort === 'amount') { orderCol = 'd.amount'; orderDir = 'ASC NULLS LAST'; }

    const sql = `SELECT d.* FROM deals d ${whereClause} ORDER BY ${orderCol} ${orderDir} LIMIT $${p}`;
    params.push(limit);

    const { rows } = await query(sql, params);
    res.json({ items: rows.map(serializeDeal), total: rows.length });
  } catch (e) {
    console.error('[deals] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — single deal (owner-scoped) ───────────────────────────────────
// Resolves by Railway UUID (id) OR legacy_base44_id (migrated Base44 deal ID).
// Uses safe identifier resolution to avoid PostgreSQL uuid cast errors on
// non-UUID legacy identifiers.
router.get('/:id', async (req, res) => {
  try {
    const { whereSql, params } = dealIdWhere(req.params.id);
    const { rows } = await query(
      `SELECT * FROM deals WHERE ${whereSql} LIMIT 1`,
      params
    );
    const deal = rows[0];
    if (!deal) return res.status(404).json({ error: 'not_found' });
    if (!canAccessDeal(req.user, deal)) return res.status(403).json({ error: 'forbidden' });
    res.json({ deal: serializeDeal(deal) });
  } catch (e) {
    console.error('[deals] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST / — create ──────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    if (!canWriteDeal(req.user, null, 'create')) return res.status(403).json({ error: 'forbidden' });
    const { ok, errors, cleaned } = validateDealPayload(req.body, { partial: false });
    if (!ok) return res.status(400).json({ error: 'validation_failed', details: errors });

    cleaned.created_by = req.user.email || req.user.id || null;
    if (!cleaned.payment_status && cleaned.contract_amount != null) {
      cleaned.payment_status = computePaymentStatus(cleaned.total_paid || 0, cleaned.contract_amount);
    }

    const cols = Object.keys(cleaned);
    const vals = cols.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO deals (${cols.join(',')}) VALUES (${vals.join(',')}) RETURNING *`;
    const { rows } = await query(sql, cols.map((c) => cleaned[c]));

    // ── Notify admins of the new deal (best-effort) ──────────────────────
    sendDealNotification('deal_created', rows[0], req.user?.email);

    res.status(201).json({ deal: serializeDeal(rows[0]) });
  } catch (e) {
    // FK violation (23503): lead_id does not reference an existing Railway Lead.
    if (e.code === '23503') return res.status(400).json({ error: 'lead_not_found', details: 'lead_id must reference an existing Railway leads.id' });
    // Unique violation (23505): duplicate legacy_base44_id.
    if (e.code === '23505') return res.status(409).json({ error: 'duplicate_legacy_base44_id', details: 'legacy_base44_id already mapped to another deal' });
    console.error('[deals] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id — update (partial) ─────────────────────────────────────────────
// Resolves by Railway UUID (id) OR legacy_base44_id (safe identifier resolution).
router.put('/:id', async (req, res) => {
  try {
    const { whereSql, params } = dealIdWhere(req.params.id);
    const { rows } = await query(
      `SELECT * FROM deals WHERE ${whereSql} LIMIT 1`,
      params
    );
    const deal = rows[0];
    if (!deal) return res.status(404).json({ error: 'not_found' });
    if (!canWriteDeal(req.user, deal, 'update')) return res.status(403).json({ error: 'forbidden' });

    const { ok, errors, cleaned } = validateDealPayload(req.body, { partial: true });
    if (!ok) return res.status(400).json({ error: 'validation_failed', details: errors });

    // Immutable after create: ownership key + legacy metadata.
    delete cleaned.lead_id;
    delete cleaned.legacy_base44_id;
    delete cleaned.legacy_base44_lead_id;
    if (Object.keys(cleaned).length === 0) return res.json({ deal: serializeDeal(deal) });

    cleaned.updated_by = req.user.email || req.user.id || null;

    // recompute payment_status when financial fields change
    if (cleaned.total_paid !== undefined || cleaned.contract_amount !== undefined) {
      if (cleaned.payment_status === undefined) {
        const tp = cleaned.total_paid !== undefined ? cleaned.total_paid : Number(deal.total_paid) || 0;
        const ca = cleaned.contract_amount !== undefined ? cleaned.contract_amount : (deal.contract_amount != null ? Number(deal.contract_amount) : 0);
        cleaned.payment_status = computePaymentStatus(tp, ca);
      }
    }

    const cols = Object.keys(cleaned);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const sql = `UPDATE deals SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`;
    const { rows: updated } = await query(sql, [...cols.map((c) => cleaned[c]), deal.id]);

    // ── Notify admins of the deal update (best-effort) ───────────────────
    const changes = computeDealDiff(deal, updated[0]);
    if (changes.length > 0) {
      const isStageOnly = changes.length === 1 && changes[0].label === 'Stage';
      sendDealNotification(isStageOnly ? 'deal_stage_changed' : 'deal_updated', updated[0], req.user?.email, changes);
    }

    res.json({ deal: serializeDeal(updated[0]) });
  } catch (e) {
    console.error('[deals] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id — ADMIN ONLY ────────────────────────────────────────────────
// Resolves by Railway UUID (id) OR legacy_base44_id (safe identifier resolution).
router.delete('/:id', async (req, res) => {
  try {
    const { whereSql, params } = dealIdWhere(req.params.id);
    const { rows } = await query(
      `SELECT * FROM deals WHERE ${whereSql} LIMIT 1`,
      params
    );
    const deal = rows[0];
    if (!deal) return res.status(404).json({ error: 'not_found' });
    if (!canWriteDeal(req.user, deal, 'delete')) return res.status(403).json({ error: 'forbidden' });
    await query('DELETE FROM deals WHERE id = $1', [deal.id]);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    console.error('[deals] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;