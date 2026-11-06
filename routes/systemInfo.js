/* eslint-disable no-undef */
/**
 * GET /api/v1/system/info — read-only installation/system health for
 * Admin/System Health (PRODUCTIZATION FOUNDATION — Phase J/H; integration
 * health rewritten in the System Health UI-consistency + real-audit pass).
 *
 * Surfaces: product version, schema/migration status, this installation's
 * identity (never another installation's — see lib/installationIdentity.js),
 * and per-integration health evidence via lib/systemHealthChecks.js. Default
 * GET only reports credential/config presence — fast, local, side-effect-free,
 * exactly like GET /qb/health. Passing ?verify=1 additionally runs a genuine
 * read-only connectivity check per integration (same convention as
 * GET /qb/health?verify=1) — every such check is a plain read (CompanyInfo,
 * profile, event listing, People "me", user-info, estimates?limit=1, Account
 * fetch) and NEVER creates/sends/modifies anything. No secret VALUE is ever
 * included — only whether a credential/env is present, and generic status
 * metadata already treated as non-secret elsewhere.
 *
 * Auth: admin only (this can reveal which integrations are/aren't wired,
 * which is operationally sensitive even without secret values). The
 * ?verify=1 path is additionally rate-limited since it makes live outbound
 * calls to third-party services.
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { identify } = require('../lib/installationIdentity');
const { rateLimit } = require('../lib/rateLimit');
const { getIntegrationHealth } = require('../lib/systemHealthChecks');
const { buildCommit, productVersion } = require('../lib/buildInfo');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// Live connectivity checks make real outbound calls to third-party services
// (QuickBooks, Gmail, Google, SignNow, Handoff, Twilio) — rate-limit that
// path specifically so repeated admin page-refreshes can't hammer them.
const verifyRateLimit = rateLimit({ windowMs: 60 * 1000, max: 10 });

router.get('/info', async (req, res, next) => {
  // Only the live-verify path is rate-limited — a plain refresh stays fast
  // and unlimited, matching GET /qb/health vs ?verify=1.
  if (req.query.verify === '1') return verifyRateLimit(req, res, next);
  next();
}, async (req, res) => {
  try {
    const installation = await identify();
    const { rows: migRows } = await query(`SELECT count(*)::int AS n, max(applied_at) AS last_applied_at FROM schema_migrations`);

    const integrations = await getIntegrationHealth({ verify: req.query.verify === '1' });

    res.json({
      product_version: productVersion(),
      build_commit: buildCommit(),
      installation: { company_name: installation.companyName, installation_id: installation.installationId, configured: installation.configured },
      schema: { migrations_applied: migRows[0].n, last_migration_applied_at: migRows[0].last_applied_at },
      integrations,
      verified: req.query.verify === '1',
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[system-info] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
