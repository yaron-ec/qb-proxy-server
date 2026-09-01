/* eslint-disable no-undef */
/**
 * /api/v1/owners — Sales-rep / owner directory (R1A foundation).
 *
 *   GET /api/v1/owners  -> { items }  (active owners: id, email, display_name)
 *
 * Auth: Railway JWT (requireAuth). All authenticated users can list owners
 * (needed for the owner-filter dropdown on the Leads page).
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();

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

module.exports = router;