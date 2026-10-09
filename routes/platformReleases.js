/* eslint-disable no-undef */
/**
 * /api/v1/platform/releases — centrally managed release / staged rollout /
 * rollback (PRODUCTIZATION — Company Provisioning System, automated
 * infrastructure + release pipeline). See lib/platformRelease.js for the
 * actual mechanism (per-company deploy/<slug> branch, moved explicitly by
 * an admin action here — never automatically on a push to main).
 *
 * Same auth as /api/v1/platform/companies: lib/rbac.js#requirePlatformAdmin.
 *
 *   POST /                    -> record a new release (defaults to this server's own currently-running commit)
 *   GET  /                    -> list releases
 *   POST /:id/rollout         -> staged rollout to every invited/activated company, in batches, halting + auto-rolling-back on the first unhealthy company
 *   POST /company/:id/rollback -> roll ONE company back to its own previous release
 */
'use strict';

const express = require('express');
const { requireAuth, requirePlatformAdmin } = require('../lib/rbac');
const { query } = require('../db/client');

const router = express.Router();
router.use(requireAuth, requirePlatformAdmin);

router.post('/', async (req, res) => {
  try {
    const { git_sha, git_ref, batch_size, notes } = req.body || {};
    const { createRelease } = require('../lib/platformRelease');
    const release = await createRelease({ gitSha: git_sha, gitRef: git_ref, createdBy: req.user.sub, batchSize: batch_size, notes });
    res.status(201).json({ release });
  } catch (e) {
    console.error('[platform-releases] create error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { listReleases } = require('../lib/platformRelease');
    res.json({ items: await listReleases() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/deployments', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT d.*, c.company_name FROM platform_company_deployments d
       JOIN platform_companies c ON c.id = d.company_id
       WHERE d.release_id = $1 ORDER BY d.created_at ASC`,
      [req.params.id]
    );
    res.json({ items: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Explicit, admin-triggered only — NEVER fired automatically by a push to
// main. A push just updates `main`; nobody's deploy branch moves until an
// admin calls this.
router.post('/:id/rollout', async (req, res) => {
  try {
    const { batch_size } = req.body || {};
    const { rolloutRelease } = require('../lib/platformRelease');
    const result = await rolloutRelease(req.params.id, { batchSize: batch_size });
    res.json(result);
  } catch (e) {
    console.error('[platform-releases] rollout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/company/:companyId/rollback', async (req, res) => {
  try {
    const { rollbackCompany } = require('../lib/platformRelease');
    const result = await rollbackCompany(req.params.companyId);
    res.json(result);
  } catch (e) {
    console.error('[platform-releases] rollback error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
