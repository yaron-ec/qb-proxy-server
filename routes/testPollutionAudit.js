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
      '%e2e%', '%verification test%', '%test note%', '%notification test%',
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

module.exports = router;
