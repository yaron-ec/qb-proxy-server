/* eslint-disable no-undef */
/**
 * /api/v1/leads/merge — Railway-native duplicate lead merge.
 *
 * Replaces the Base44 function mergeDuplicateLeads. Merges two leads into
 * one canonical surviving lead, reassigning ALL FK-dependent records in a
 * single atomic transaction with rollback on failure.
 *
 *   POST /api/v1/leads/merge
 *   Body: { lead_id_keep: UUID, lead_id_merge: UUID }
 *
 * Merge logic:
 *   - The oldest lead (by crm_created_date) is the surviving lead.
 *   - If lead_id_keep is the oldest, it survives; otherwise lead_id_merge survives.
 *   - Contact fields: survivor keeps its value, falls back to merged lead's value.
 *   - Notes: merged lead's notes appended to survivor with a merge marker.
 *   - Status: most recently updated lead's status wins.
 *
 * Reassigned records (all within one transaction):
 *   - activities (lead_id FK CASCADE → update before delete)
 *   - tasks (lead_id FK CASCADE → update before delete)
 *   - deals (lead_id FK SET NULL → update to survivor)
 *   - invoices (lead_id FK CASCADE → update to survivor)
 *   - estimates (lead_id FK SET NULL → update to survivor)
 *   - properties (lead_id FK SET NULL → update to survivor)
 *   - lead_attachments (lead_id FK CASCADE → update to survivor)
 *   - lead_submissions (lead_id FK SET NULL → update to survivor)
 *   - appointments (lead_id FK SET NULL → update to survivor, no duplicates)
 *   - signnow_documents (lead_id FK SET NULL → update to survivor)
 *   - handoff_estimates (lead_id FK SET NULL → update to survivor)
 *   - reminder_leads (text id → update to survivor's external_ref/id)
 *   - reminder_claims (text lead_id → update to survivor)
 *   - qb_invoice_sale_map (text crm_lead_id → update to survivor)
 *   - google_contact fields on the lead (preserve survivor's, fall back)
 *
 * The merged lead is then SOFT-DELETED (status='DNQ', notes appended) — NOT
 * physically deleted — to preserve the audit trail. A merge audit activity
 * is written to the survivor.
 *
 * Auth: Railway JWT (requireAuth). Admin only.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { pool } = require('../db/client');
const { UUID_RE } = require('../lib/leadResolver');

const router = express.Router();
router.use(requireAuth);
const requireAdmin = requireRole('admin');

router.post('/merge', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { lead_id_keep, lead_id_merge } = req.body || {};

    if (!lead_id_keep || !lead_id_merge) {
      return res.status(400).json({ error: 'lead_id_keep and lead_id_merge are required' });
    }
    if (!UUID_RE.test(String(lead_id_keep)) || !UUID_RE.test(String(lead_id_merge))) {
      return res.status(400).json({ error: 'Both IDs must be valid Railway UUIDs' });
    }
    if (lead_id_keep === lead_id_merge) {
      return res.status(400).json({ error: 'Cannot merge a lead with itself' });
    }

    await client.query('BEGIN');

    // 1. Fetch both leads (FOR UPDATE to prevent concurrent modification)
    const { rows: keepRows } = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [lead_id_keep]);
    const { rows: mergeRows } = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [lead_id_merge]);
    const leadKeep = keepRows[0];
    const leadMerge = mergeRows[0];

    if (!leadKeep || !leadMerge) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or both leads not found' });
    }

    // 2. Determine survivor (oldest by crm_created_date, fall back to created_at)
    const keepDate = new Date(leadKeep.crm_created_date || leadKeep.created_at);
    const mergeDate = new Date(leadMerge.crm_created_date || leadMerge.created_at);
    const survivorIsKeep = keepDate <= mergeDate;
    const survivor = survivorIsKeep ? leadKeep : leadMerge;
    const merged = survivorIsKeep ? leadMerge : leadKeep;
    const survivorId = survivor.id;
    const mergedId = merged.id;

    // 3. Merge contact fields (survivor keeps its value, falls back to merged)
    const mergedNotes = [
      (survivor.notes || '').trim(),
      merged.notes ? `[Merged from ${merged.first_name} ${merged.last_name}]:\n${merged.notes}`.trim() : '',
    ].filter(Boolean).join('\n\n');

    const updatedData = {
      first_name: survivor.first_name || merged.first_name,
      last_name: survivor.last_name || merged.last_name,
      email: survivor.email || merged.email,
      phone: survivor.phone || merged.phone,
      property_address: survivor.property_address || merged.property_address,
      city: survivor.city || merged.city,
      notes: mergedNotes,
      // Most recently updated status wins
      status: new Date(survivor.updated_at) >= new Date(merged.updated_at) ? survivor.status : merged.status,
      // Most recently updated follow-up wins
      follow_up_date: new Date(survivor.updated_at) >= new Date(merged.updated_at) ? survivor.follow_up_date : merged.follow_up_date,
      follow_up_time: new Date(survivor.updated_at) >= new Date(merged.updated_at) ? survivor.follow_up_time : merged.follow_up_time,
      follow_up_type: new Date(survivor.updated_at) >= new Date(merged.updated_at) ? survivor.follow_up_type : merged.follow_up_type,
    };

    await client.query(`
      UPDATE leads SET
        first_name = $1, last_name = $2, email = $3, phone = $4,
        property_address = $5, city = $6, notes = $7, status = $8,
        follow_up_date = $9, follow_up_time = $10, follow_up_type = $11,
        updated_at = NOW()
      WHERE id = $12
    `, [
      updatedData.first_name, updatedData.last_name, updatedData.email, updatedData.phone,
      updatedData.property_address, updatedData.city, updatedData.notes, updatedData.status,
      updatedData.follow_up_date, updatedData.follow_up_time, updatedData.follow_up_type,
      survivorId,
    ]);

    // 4. Reassign all FK-dependent records from merged → survivor
    const stats = { activities: 0, tasks: 0, deals: 0, invoices: 0, estimates: 0,
                    properties: 0, attachments: 0, submissions: 0, appointments: 0,
                    signnow: 0, handoff: 0, reminder_claims: 0, qb_map: 0 };

    // activities (UUID FK)
    const ar = await client.query('UPDATE activities SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.activities = ar.rowCount || 0;

    // tasks (UUID FK)
    const tr = await client.query('UPDATE tasks SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.tasks = tr.rowCount || 0;

    // deals (UUID FK) — update lead_id to survivor
    const dr = await client.query('UPDATE deals SET lead_id = $1, updated_at = NOW() WHERE lead_id = $2', [survivorId, mergedId]);
    stats.deals = dr.rowCount || 0;

    // invoices (UUID FK)
    const ir = await client.query('UPDATE invoices SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.invoices = ir.rowCount || 0;

    // estimates (UUID FK, nullable)
    const er = await client.query('UPDATE estimates SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.estimates = er.rowCount || 0;

    // properties (UUID FK, nullable)
    const pr = await client.query('UPDATE properties SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.properties = pr.rowCount || 0;

    // lead_attachments (UUID FK)
    const atr = await client.query('UPDATE lead_attachments SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.attachments = atr.rowCount || 0;

    // lead_submissions (UUID FK, nullable)
    const sr = await client.query('UPDATE lead_submissions SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.submissions = sr.rowCount || 0;

    // appointments (UUID FK, SET NULL) — update to survivor (no duplicate: each appt has one lead_id)
    const apr = await client.query('UPDATE appointments SET lead_id = $1, updated_at = NOW() WHERE lead_id = $2', [survivorId, mergedId]);
    stats.appointments = apr.rowCount || 0;

    // signnow_documents (UUID FK, nullable)
    const snr = await client.query('UPDATE signnow_documents SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.signnow = snr.rowCount || 0;

    // handoff_estimates (UUID FK, nullable)
    const hr = await client.query('UPDATE handoff_estimates SET lead_id = $1 WHERE lead_id = $2', [survivorId, mergedId]);
    stats.handoff = hr.rowCount || 0;

    // reminder_claims (TEXT lead_id) — update to survivor's id
    const rcr = await client.query('UPDATE reminder_claims SET lead_id = $1 WHERE lead_id = $2', [String(survivorId), String(mergedId)]);
    stats.reminder_claims = rcr.rowCount || 0;

    // qb_invoice_sale_map (TEXT crm_lead_id) — update to survivor's id
    const qmr = await client.query('UPDATE qb_invoice_sale_map SET crm_lead_id = $1 WHERE crm_lead_id = $2', [String(survivorId), String(mergedId)]);
    stats.qb_map = qmr.rowCount || 0;

    // 5. Write merge audit activity to survivor
    await client.query(`
      INSERT INTO activities (lead_id, type, content, author, source, created_at, updated_at)
      VALUES ($1, 'note', $2, 'system', 'manual', NOW(), NOW())
    `, [
      survivorId,
      `🔀 Merged lead ${merged.first_name} ${merged.last_name} (${merged.id}) into this lead. ` +
      `Moved: ${stats.activities} activities, ${stats.tasks} tasks, ${stats.deals} deals, ` +
      `${stats.invoices} invoices, ${stats.appointments} appointments, ${stats.estimates} estimates.`,
    ]);

    // 6. Soft-delete the merged lead (status='DNQ', notes appended) — preserve audit trail
    await client.query(`
      UPDATE leads SET
        status = 'DNQ',
        notes = COALESCE(notes, '') || E'\n\n[Merged into lead ID: ' || $1 || ']',
        duplicate_merged = true,
        last_merge_date = NOW(),
        merge_count = COALESCE(merge_count, 0) + 1,
        updated_at = NOW()
      WHERE id = $2
    `, [String(survivorId), mergedId]);

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Merged ${merged.first_name} ${merged.last_name} into ${survivor.first_name} ${survivor.last_name}`,
      kept_lead_id: survivorId,
      merged_lead_id: mergedId,
      survivor_is_keep: survivorIsKeep,
      stats,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[merge] error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;