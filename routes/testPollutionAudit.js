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

// POST /audit-test-pollution — READ-ONLY search for test artifacts system-wide
router.post('/audit-test-pollution', async (req, res) => {
  try {
    const { lead_id } = req.body || {};
    const patterns = [
      '%E2E%', '%e2e%', '%verification%', '%test note%', '%notification test%',
      '%e2e-verify%', '%live-acceptance%', '%runtime-probe%', '%TEST%',
      '%@test.com%', '%@example.com%'
    ];

    let testActivities = [];
    try {
      const r = await query('SELECT id, lead_id, type, content, author, source, created_at FROM activities WHERE content ILIKE ANY($1::text[]) OR author ILIKE ANY($1::text[]) ORDER BY created_at DESC LIMIT 500', [patterns]);
      testActivities = r.rows;
    } catch (e) { console.warn('[audit-test-pollution] activities:', e.message); }

    let testLeads = [];
    try {
      const r = await query('SELECT id, external_ref, first_name, last_name, email, phone, status, created_at FROM leads WHERE email ILIKE ANY($1::text[]) OR first_name ILIKE ANY($1::text[]) OR last_name ILIKE ANY($1::text[]) ORDER BY created_at DESC LIMIT 200', [patterns]);
      testLeads = r.rows;
    } catch (e) { console.warn('[audit-test-pollution] leads:', e.message); }

    let testDeals = [];
    try {
      const r = await query('SELECT id, lead_id, name, stage, created_at FROM deals WHERE name ILIKE ANY($1::text[]) ORDER BY created_at DESC LIMIT 200', [patterns]);
      testDeals = r.rows;
    } catch (e) { console.warn('[audit-test-pollution] deals:', e.message); }

    let testAppts = [];
    try {
      const r = await query('SELECT a.id, a.lead_id, a.start_at, a.status, a.calendar_sync_status, l.first_name, l.last_name, l.email FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id WHERE l.email ILIKE ANY($1::text[]) ORDER BY a.start_at DESC LIMIT 200', [patterns]);
      testAppts = r.rows;
    } catch (e) { console.warn('[audit-test-pollution] appts:', e.message); }

    let testUsers = [];
    try {
      const r = await query('SELECT id, email, full_name, role, status FROM users WHERE email ILIKE ANY($1::text[]) OR full_name ILIKE ANY($1::text[]) ORDER BY email', [patterns]);
      testUsers = r.rows;
    } catch (e) { console.warn('[audit-test-pollution] users:', e.message); }

    let leadActivities = null;
    if (lead_id) {
      try {
        const r = await query('SELECT id, lead_id, type, content, author, source, created_at FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100', [lead_id]);
        leadActivities = r.rows;
      } catch (e) { console.warn('[audit-test-pollution] lead_acts:', e.message); }
    }

    res.json({
      ok: true,
      test_activities: { count: testActivities.length, items: testActivities },
      test_leads: { count: testLeads.length, items: testLeads },
      test_deals: { count: testDeals.length, items: testDeals },
      test_appointments: { count: testAppts.length, items: testAppts },
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const testPatterns = [
      '%E2E%', '%e2e%', '%verification test%', '%test note%', '%notification test%',
      '%e2e-verify%', '%live-acceptance%', '%runtime-probe%'
    ];
    const emailPatterns = ['%@test.com%', '%@example.com%'];

    // 1. Delete test activities (content or author matches test patterns)
    const actRes = await client.query(
      'DELETE FROM activities WHERE content ILIKE ANY($1::text[]) OR author ILIKE ANY($1::text[]) OR author ILIKE ANY($2::text[]) RETURNING id, lead_id, content',
      [testPatterns, emailPatterns]
    );

    // 2. Delete activities by proven test users (e2e-verify@test.com, etc.)
    const testUserActRes = await client.query(
      'DELETE FROM activities WHERE author IN (SELECT email FROM users WHERE email ILIKE ANY($1::text%)) RETURNING id, lead_id, author',
      [emailPatterns]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      deleted_activities: actRes.rows.length,
      deleted_activity_ids: actRes.rows.map(r => r.id),
      deleted_test_user_activities: testUserActRes.rows.length,
      deleted_test_user_activity_ids: testUserActRes.rows.map(r => r.id),
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
