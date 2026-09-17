/* eslint-disable no-undef */
/**
 * /api/v1/owners — Sales-rep / owner directory (R1A foundation), now a
 * properly Admin-managed directory.
 *
 *   GET   /api/v1/owners                    -> { items }  (active owners only — unchanged shape, existing consumers)
 *   GET   /api/v1/owners/all                -> { items }  (admin-only: EVERY owner, active + inactive/merged, with reference counts — read-only audit)
 *   GET   /api/v1/owners/:mergeId/merge-preview?keep_id=<id>  -> preview of what a merge would repoint (admin-only, no mutation)
 *   PATCH /api/v1/owners/:id                -> { owner }  (admin-only: edit email/display_name/is_active)
 *   POST  /api/v1/owners/merge              -> { success, stats, preserved }  (admin-only: transactional duplicate consolidation)
 *
 * Auth: Railway JWT (requireAuth). All authenticated users can list ACTIVE
 * owners (needed for the owner-filter dropdown on the Leads page — and,
 * post-merge, this is also how a merged/deactivated duplicate automatically
 * stops appearing in every picker with no other code change, since every
 * existing picker already filters is_active = true). Every mutating route
 * (PATCH, /all, /merge-preview, /merge) is admin-only.
 *
 * This `owners` table is NOT the authentication table (`users`, via
 * lib/authService.js/rbac.js) — nothing here can ever affect login, role,
 * or session identity. Merging two owner rows is a data-consolidation
 * operation on contact/Reply-To/assignment records, never an auth-user
 * operation; the two are managed entirely independently.
 *
 * MERGE SAFETY MODEL (POST /merge):
 *   - A duplicate owner is never physically deleted — see
 *     db/migrations/2026-41-owner-merge-tracking.sql. It is deactivated
 *     (is_active = false) and tagged (merged_into_owner_id, merged_at),
 *     which is exactly the flag every existing "active owners" query
 *     already filters on.
 *   - Every LIVE ownership reference is repointed to the canonical owner
 *     inside ONE transaction: leads.owner_id, appointments.owner_id (guarded
 *     against the appointments_no_active_overlap EXCLUDE constraint —
 *     fails closed with the exact conflicting appointments if repointing
 *     would violate it), deals.assigned_rep, tasks.assigned_to,
 *     deal_commissions.recipient_name (the latter three are TEXT columns
 *     matched by the duplicate's exact current display_name — the same
 *     pattern this codebase already used for the one-off
 *     scripts/mergeShlomiIntoSimon.js identity merge, generalized here into
 *     a permanent, reusable, parameterized endpoint).
 *   - Historical/audit-only text is deliberately NEVER repointed —
 *     rewriting it would falsify history: lead_submissions.assigned_rep_at_time,
 *     appointment_events.actor, and created_by/updated_by columns on
 *     invoices/deal_expenses/deal_expense_payments/deal_loan_payments.
 *     Their counts are still reported (as `preserved`) so an admin can see
 *     they exist without them being silently rewritten.
 *   - Any failure at any step rolls back the entire transaction — never a
 *     half-migrated ownership state.
 *   - Idempotent: merging an already-merged duplicate into the SAME
 *     canonical owner again is a safe no-op (200, already_merged: true);
 *     merging it toward a DIFFERENT target, or using an already-merged
 *     owner as the merge TARGET, is rejected (409) rather than chained.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query, pool } = require('../db/client');

const router = express.Router();
const requireAdmin = requireRole('admin');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, display_name, is_active
       FROM owners
       WHERE is_active = true
       ORDER BY display_name ASC NULLS LAST, email ASC`
    );
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        display_name: r.display_name || r.email,
        is_active: r.is_active,
      })),
    });
  } catch (e) {
    console.error('[owners] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Read-only horizontal audit: every owner (including inactive/merged/legacy),
// with live reference counts, so an admin can see duplicates, stale/legacy
// rows, and which owners are still genuinely referenced BEFORE deciding to
// merge or deactivate anything. Never mutates.
router.get('/all', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [ownersRes, leadsRes, apptsRes, dealsRes, tasksRes, commRes] = await Promise.all([
      query(`SELECT id, email, display_name, is_active, merged_into_owner_id, merged_at, created_at FROM owners ORDER BY is_active DESC, display_name ASC NULLS LAST`),
      query(`SELECT owner_id, COUNT(*)::int AS c FROM leads GROUP BY owner_id`),
      query(`SELECT owner_id, COUNT(*)::int AS c FROM appointments GROUP BY owner_id`),
      query(`SELECT lower(assigned_rep) AS name, COUNT(*)::int AS c FROM deals WHERE assigned_rep IS NOT NULL GROUP BY lower(assigned_rep)`),
      query(`SELECT lower(assigned_to) AS name, COUNT(*)::int AS c FROM tasks WHERE assigned_to IS NOT NULL GROUP BY lower(assigned_to)`),
      query(`SELECT lower(recipient_name) AS name, COUNT(*)::int AS c FROM deal_commissions WHERE recipient_name IS NOT NULL GROUP BY lower(recipient_name)`),
    ]);
    const leadsById = new Map(leadsRes.rows.map(r => [r.owner_id, r.c]));
    const apptsById = new Map(apptsRes.rows.map(r => [r.owner_id, r.c]));
    const dealsByName = new Map(dealsRes.rows.map(r => [r.name, r.c]));
    const tasksByName = new Map(tasksRes.rows.map(r => [r.name, r.c]));
    const commByName = new Map(commRes.rows.map(r => [r.name, r.c]));

    const items = ownersRes.rows.map(o => {
      const nameKey = (o.display_name || '').toLowerCase();
      const reference_counts = {
        leads: leadsById.get(o.id) || 0,
        appointments: apptsById.get(o.id) || 0,
        deals: nameKey ? (dealsByName.get(nameKey) || 0) : 0,
        tasks: nameKey ? (tasksByName.get(nameKey) || 0) : 0,
        deal_commissions: nameKey ? (commByName.get(nameKey) || 0) : 0,
      };
      reference_counts.total = reference_counts.leads + reference_counts.appointments + reference_counts.deals + reference_counts.tasks + reference_counts.deal_commissions;
      return { ...o, reference_counts };
    });
    res.json({ items });
  } catch (e) {
    console.error('[owners] all/audit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, display_name, is_active } = req.body || {};
    if (email === undefined && display_name === undefined && is_active === undefined) {
      return res.status(400).json({ error: 'email, display_name, or is_active required' });
    }
    if (email !== undefined && !EMAIL_RE.test(String(email))) {
      return res.status(400).json({ error: 'invalid email' });
    }

    const sets = [];
    const vals = [];
    let i = 1;
    if (email !== undefined) { sets.push(`email = $${i++}`); vals.push(String(email).trim().toLowerCase()); }
    if (display_name !== undefined) { sets.push(`display_name = $${i++}`); vals.push(display_name ? String(display_name).trim() : null); }
    if (is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(!!is_active); }
    vals.push(id);

    const { rows } = await query(
      `UPDATE owners SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, email, display_name, is_active, merged_into_owner_id, merged_at`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ owner: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email already in use by another owner' });
    console.error('[owners] update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Preview-only: exactly the counts POST /merge would act on, computed the
// same way, but nothing is mutated. Lets the Admin UI show "merging X into
// Y will move N leads, M appointments, ..." before the confirm step.
router.get('/:mergeId/merge-preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { mergeId } = req.params;
    const keepId = req.query.keep_id;
    if (!keepId) return res.status(400).json({ error: 'keep_id query param required' });
    if (keepId === mergeId) return res.status(400).json({ error: 'cannot merge an owner into itself' });

    const { rows: ownerRows } = await query(`SELECT id, email, display_name, is_active, merged_into_owner_id FROM owners WHERE id IN ($1, $2)`, [keepId, mergeId]);
    const keep = ownerRows.find(o => o.id === keepId);
    const merge = ownerRows.find(o => o.id === mergeId);
    if (!keep || !merge) return res.status(404).json({ error: 'one or both owners not found' });

    const mergeName = (merge.display_name || '').toLowerCase();
    const [leadsC, apptsC, dealsC, tasksC, commC, overlapRes, lsC, aeC] = await Promise.all([
      query(`SELECT COUNT(*)::int c FROM leads WHERE owner_id = $1`, [mergeId]),
      query(`SELECT COUNT(*)::int c FROM appointments WHERE owner_id = $1`, [mergeId]),
      mergeName ? query(`SELECT COUNT(*)::int c FROM deals WHERE lower(assigned_rep) = $1`, [mergeName]) : Promise.resolve({ rows: [{ c: 0 }] }),
      mergeName ? query(`SELECT COUNT(*)::int c FROM tasks WHERE lower(assigned_to) = $1`, [mergeName]) : Promise.resolve({ rows: [{ c: 0 }] }),
      mergeName ? query(`SELECT COUNT(*)::int c FROM deal_commissions WHERE lower(recipient_name) = $1`, [mergeName]) : Promise.resolve({ rows: [{ c: 0 }] }),
      query(`
        SELECT s.id AS merge_appt_id, s.start_at, s.end_at, m.id AS keep_appt_id
        FROM appointments s
        JOIN appointments m ON m.owner_id = $1 AND m.status IN ('scheduled','confirmed')
                          AND s.busy_range && m.busy_range
        WHERE s.owner_id = $2 AND s.status IN ('scheduled','confirmed')`,
        [keepId, mergeId]),
      mergeName ? query(`SELECT COUNT(*)::int c FROM lead_submissions WHERE lower(assigned_rep_at_time) = $1`, [mergeName]) : Promise.resolve({ rows: [{ c: 0 }] }),
      mergeName ? query(`SELECT COUNT(*)::int c FROM appointment_events WHERE lower(actor) = $1`, [mergeName]) : Promise.resolve({ rows: [{ c: 0 }] }),
    ]);

    res.json({
      keep_owner: keep,
      merge_owner: merge,
      will_repoint: {
        leads: leadsC.rows[0].c,
        appointments: apptsC.rows[0].c,
        deals: dealsC.rows[0].c,
        tasks: tasksC.rows[0].c,
        deal_commissions: commC.rows[0].c,
      },
      preserved_historical: {
        lead_submissions: lsC.rows[0].c,
        appointment_events: aeC.rows[0].c,
      },
      appointment_overlap_conflicts: overlapRes.rows,
      blocked: overlapRes.rows.length > 0,
      already_merged: !!merge.merged_into_owner_id,
    });
  } catch (e) {
    console.error('[owners] merge-preview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/merge', requireAuth, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { keep_id, merge_id } = req.body || {};
    if (!keep_id || !merge_id) return res.status(400).json({ error: 'keep_id and merge_id are required' });
    if (keep_id === merge_id) return res.status(400).json({ error: 'cannot merge an owner into itself' });

    await client.query('BEGIN');

    const { rows: ownerRows } = await client.query(`SELECT * FROM owners WHERE id IN ($1, $2) FOR UPDATE`, [keep_id, merge_id]);
    const keep = ownerRows.find(o => o.id === keep_id);
    const merge = ownerRows.find(o => o.id === merge_id);
    if (!keep || !merge) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'one or both owners not found' });
    }
    if (keep.merged_into_owner_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'keep_id is itself a merged/deactivated owner — resolve to its current canonical target first', keep_id_merged_into: keep.merged_into_owner_id });
    }
    if (merge.merged_into_owner_id) {
      await client.query('ROLLBACK');
      if (merge.merged_into_owner_id === keep_id) {
        // Idempotent: this exact merge already happened — safe no-op.
        return res.status(200).json({ success: true, already_merged: true, kept_owner_id: keep_id, merged_owner_id: merge_id });
      }
      return res.status(409).json({ error: 'merge_id was already merged into a different owner', merge_id_merged_into: merge.merged_into_owner_id });
    }

    // Appointment overlap guard — appointments_no_active_overlap EXCLUDE
    // constraint (owner_id WITH =, busy_range WITH &&) would reject the
    // repoint below if the duplicate's active appointments collide with the
    // canonical owner's. Fail closed with the exact conflicts rather than
    // let Postgres throw a raw constraint-violation error mid-transaction.
    const { rows: overlaps } = await client.query(`
      SELECT s.id AS merge_appt_id, s.start_at, s.end_at, m.id AS keep_appt_id
      FROM appointments s
      JOIN appointments m ON m.owner_id = $1 AND m.status IN ('scheduled','confirmed')
                        AND s.busy_range && m.busy_range
      WHERE s.owner_id = $2 AND s.status IN ('scheduled','confirmed')`,
      [keep_id, merge_id]
    );
    if (overlaps.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'appointment overlap collision — cannot repoint without violating the no-double-booking constraint', conflicts: overlaps });
    }

    const stats = { leads: 0, appointments: 0, deals: 0, tasks: 0, deal_commissions: 0 };

    const leadsR = await client.query(`UPDATE leads SET owner_id = $1, updated_at = NOW() WHERE owner_id = $2`, [keep_id, merge_id]);
    stats.leads = leadsR.rowCount || 0;

    const apptsR = await client.query(`UPDATE appointments SET owner_id = $1, updated_at = NOW() WHERE owner_id = $2`, [keep_id, merge_id]);
    stats.appointments = apptsR.rowCount || 0;

    const mergeName = merge.display_name;
    const keepName = keep.display_name;
    // Matched case-insensitively (consistent with the preview endpoint's
    // counts) — the exact stored casing may differ between two duplicate
    // rows even when they represent the same person.
    if (mergeName && keepName && mergeName.toLowerCase() !== keepName.toLowerCase()) {
      const dealsR = await client.query(`UPDATE deals SET assigned_rep = $1, updated_at = NOW() WHERE lower(assigned_rep) = lower($2)`, [keepName, mergeName]);
      stats.deals = dealsR.rowCount || 0;

      const tasksR = await client.query(`UPDATE tasks SET assigned_to = $1 WHERE lower(assigned_to) = lower($2)`, [keepName, mergeName]);
      stats.tasks = tasksR.rowCount || 0;

      const commR = await client.query(`UPDATE deal_commissions SET recipient_name = $1, updated_at = NOW() WHERE lower(recipient_name) = lower($2)`, [keepName, mergeName]);
      stats.deal_commissions = commR.rowCount || 0;
    }

    // Deactivate the duplicate — never physically deleted. This alone makes
    // it disappear from every existing "active owners" picker/query.
    await client.query(
      `UPDATE owners SET is_active = false, merged_into_owner_id = $1, merged_at = NOW() WHERE id = $2`,
      [keep_id, merge_id]
    );

    // Preserved (historical, never repointed) — reported only.
    const preserved = { lead_submissions: 0, appointment_events: 0 };
    if (mergeName) {
      const lsR = await client.query(`SELECT COUNT(*)::int c FROM lead_submissions WHERE lower(assigned_rep_at_time) = lower($1)`, [mergeName]);
      preserved.lead_submissions = lsR.rows[0].c;
      const aeR = await client.query(`SELECT COUNT(*)::int c FROM appointment_events WHERE lower(actor) = lower($1)`, [mergeName]);
      preserved.appointment_events = aeR.rows[0].c;
    }

    await client.query('COMMIT');

    console.log(`[owners] merged owner ${merge_id} (${merge.email}) into ${keep_id} (${keep.email}) by ${req.user.email}:`, JSON.stringify(stats));
    res.json({ success: true, kept_owner_id: keep_id, merged_owner_id: merge_id, stats, preserved });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[owners] merge error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;