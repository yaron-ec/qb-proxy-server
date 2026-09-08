'use strict';

const express = require('express');
const { query } = require('../db/client');

const router = express.Router();

function requireWorkerSecret(req, res, next) {
  const secret = req.headers['x-worker-secret'];
  if (!process.env.WORKER_SECRET || secret !== process.env.WORKER_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireWorkerSecret);

// POST /audit-test-pollution
router.post('/audit-test-pollution', async (req, res) => {
  try {
    const { lead_id } = req.body || {};
    const patterns = [
      '%e2e-verify%', '%e2e verification%', '%e2e notification%', '%verification test%', '%test note%', '%notification test%',
      '%e2e-verify%', '%live-acceptance%', '%runtime-probe%',
      '%test phone call reminder%', '%test_catchup%',
      '%second test: confirming%', '%test client%', '%test customer%',
      '%this is a test note%', '%@test.com%', '%@example.com%'
    ];

    let testActivities = [];
    try {
      const r = await query('SELECT id, lead_id, type, content, author, created_at FROM activities WHERE content ILIKE ANY($1::text[]) OR author ILIKE ANY($1::text[]) ORDER BY created_at DESC LIMIT 500', [patterns]);
      testActivities = r.rows;
    } catch (e) { console.warn('[audit] activities:', e.message); }

    let testLeads = [];
    try {
      const r = await query('SELECT id, external_ref, first_name, last_name, email, phone, status FROM leads WHERE email ILIKE ANY($1::text[]) OR first_name ILIKE ANY($1::text[]) OR last_name ILIKE ANY($1::text[]) ORDER BY created_at DESC LIMIT 200', [patterns]);
      testLeads = r.rows;
    } catch (e) { console.warn('[audit] leads:', e.message); }

    let testDeals = [];
    try {
      const r = await query('SELECT id, lead_id, name, stage FROM deals WHERE name ILIKE ANY($1::text[]) ORDER BY created_at DESC LIMIT 200', [patterns]);
      testDeals = r.rows;
    } catch (e) { console.warn('[audit] deals:', e.message); }

    let testUsers = [];
    try {
      const r = await query('SELECT id, email, full_name, role, status FROM users WHERE email ILIKE ANY($1::text[]) OR full_name ILIKE ANY($1::text[]) ORDER BY email', [patterns]);
      testUsers = r.rows;
    } catch (e) { console.warn('[audit] users:', e.message); }

    let leadActivities = null;
    if (lead_id) {
      try {
        const r = await query('SELECT id, lead_id, type, content, author, created_at FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100', [lead_id]);
        leadActivities = r.rows;
      } catch (e) { console.warn('[audit] lead_acts:', e.message); }
    }

    res.json({
      ok: true,
      test_activities: { count: testActivities.length, items: testActivities },
      test_leads: { count: testLeads.length, items: testLeads },
      test_deals: { count: testDeals.length, items: testDeals },
      test_users: { count: testUsers.length, items: testUsers },
      lead_activities: leadActivities,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /clean-test-pollution — DELETE proven test artifacts (guarded, idempotent)
router.post('/clean-test-pollution', async (req, res) => {
  const { pool } = require('../db/client');
  const { dry_run } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const testPatterns = [
      '%e2e%', '%verification test%', '%test note%', '%notification test%',
      '%e2e-verify%', '%live-acceptance%', '%runtime-probe%',
      '%test phone call reminder%', '%test_catchup%',
      '%second test: confirming%', '%test client%', '%test customer%',
      '%this is a test note%'
    ];
    const emailPatterns = ['%@test.com%', '%@example.com%'];

    // Delete activities matching test content patterns, email patterns, or System (test) author
    const actRes = await client.query(
      'DELETE FROM activities WHERE content ILIKE ANY($1::text[]) OR author ILIKE ANY($1::text[]) OR author ILIKE ANY($2::text[]) OR author = $3 RETURNING id, lead_id, content, author',
      [testPatterns, emailPatterns, 'System (test)']
    );

    if (dry_run) {
      await client.query('ROLLBACK');
      res.json({
        ok: true,
        dry_run: true,
        would_delete_activities: actRes.rows.length,
        activity_ids: actRes.rows.map(r => r.id),
        activities: actRes.rows.map(r => ({ id: r.id, lead_id: r.lead_id, author: r.author, content: r.content?.substring(0, 120) })),
      });
    } else {
      await client.query('COMMIT');
      res.json({
        ok: true,
        dry_run: false,
        deleted_activities: actRes.rows.length,
        deleted_activity_ids: actRes.rows.map(r => r.id),
        activities: actRes.rows.map(r => ({ id: r.id, lead_id: r.lead_id, author: r.author, content: r.content?.substring(0, 120) })),
      });
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});


// POST /diagnose-appointment-sync — check calendar sync status for a lead
router.post('/diagnose-appointment-sync', async (req, res) => {
  try {
    const { lead_id } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id required' });

    let appts = [];
    try {
      const r = await query('SELECT id, lead_id, start_at, end_at, status, calendar_sync_status, google_event_id, google_travel_event_id, calendar_synced_at FROM appointments WHERE lead_id = $1 ORDER BY start_at DESC LIMIT 10', [lead_id]);
      appts = r.rows;
    } catch (e) { console.warn('[diag-appt-sync] appts:', e.message); }

    let outbox = [];
    if (appts.length > 0) {
      try {
        const apptIds = appts.map(a => a.id);
        const r = await query('SELECT id, appointment_id, action, status, google_event_id, attempts, last_error, created_at, updated_at FROM calendar_outbox WHERE appointment_id = ANY($1::uuid[]) ORDER BY created_at DESC LIMIT 20', [apptIds]);
        outbox = r.rows;
      } catch (e) { console.warn('[diag-appt-sync] outbox:', e.message); }
    }

    let statusCounts = {};
    try {
      const r = await query('SELECT status, count(*) as cnt FROM calendar_outbox GROUP BY status');
      for (const row of r.rows) statusCounts[row.status] = parseInt(row.cnt, 10);
    } catch (e) { console.warn('[diag-appt-sync] counts:', e.message); }

    res.json({
      ok: true,
      lead_id,
      appointments: appts,
      outbox_entries: outbox,
      outbox_status_counts: statusCounts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /fix-appointment-sync — fix stale lead + appointment calendar sync status
router.post('/fix-appointment-sync', async (req, res) => {
  const { pool } = require('../db/client');
  const { lead_id, dry_run } = req.body || {};
  if (!lead_id) return res.status(400).json({ error: 'lead_id required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find synced appointments for this lead
    const syncedRes = await client.query(
      'SELECT id, start_at, google_event_id, google_travel_event_id, calendar_synced_at FROM appointments WHERE lead_id = $1 AND calendar_sync_status = $2 AND google_event_id IS NOT NULL',
      [lead_id, 'synced']
    );

    // 2. Get the lead's current calendar sync status
    const leadRes = await client.query(
      'SELECT id, google_calendar_sync_status, google_event_id, google_travel_event_id, last_google_sync FROM leads WHERE id = $1',
      [lead_id]
    );
    const lead = leadRes.rows[0];

    // 3. If lead status is not 'synced' but a synced appointment exists, update the lead
    let leadFixed = false;
    let leadFixDetails = null;
    if (lead && syncedRes.rows.length > 0 && lead.google_calendar_sync_status !== 'synced') {
      const appt = syncedRes.rows[0];
      leadFixed = true;
      leadFixDetails = {
        old_status: lead.google_calendar_sync_status,
        new_status: 'synced',
        google_event_id: appt.google_event_id,
        google_travel_event_id: appt.google_travel_event_id,
      };
      if (!dry_run) {
        await client.query(
          'UPDATE leads SET google_calendar_sync_status = $1, google_event_id = COALESCE($2, google_event_id), google_travel_event_id = COALESCE($3, google_travel_event_id), last_google_sync = COALESCE($4, last_google_sync), updated_at = NOW() WHERE id = $5',
          ['synced', appt.google_event_id, appt.google_travel_event_id, appt.calendar_synced_at, lead_id]
        );
      }
    }

    // 4. Also fix stale appointment sync status
    const fixRes = await client.query(
      'UPDATE appointments SET calendar_sync_status = $1, calendar_synced_at = COALESCE(calendar_synced_at, NOW()) WHERE lead_id = $2 AND google_event_id IS NOT NULL AND calendar_sync_status != $1 RETURNING id',
      ['synced', lead_id]
    );

    if (dry_run) {
      await client.query('ROLLBACK');
      res.json({
        ok: true, dry_run: true, lead_id,
        lead_current: lead,
        synced_appointments: syncedRes.rows,
        would_fix_lead: leadFixed,
        lead_fix_details: leadFixDetails,
        would_fix_appointments: fixRes.rows.length,
      });
    } else {
      await client.query('COMMIT');
      res.json({
        ok: true, dry_run: false, lead_id,
        lead_fixed: leadFixed,
        lead_fix_details: leadFixDetails,
        appointments_fixed: fixRes.rows.length,
        fixed_appointment_ids: fixRes.rows.map(r => r.id),
      });
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;