/* eslint-disable no-undef */
/**
 * routes/systemHealth.js — ADMIN-ONLY System Health (mounted at /api/v1/system).
 *
 *   GET /phone-calls            aggregate Phone Call integrity (counts and
 *                               booleans only — lib/booking/phoneCallIntegrity)
 *   GET /phone-calls/ambiguous  read-only provenance of the legacy Phone Call
 *                               rows the conversion left 'ambiguous'
 *                               (lib/booking/legacyPhoneCallInvestigation)
 *
 * Auth: a CRM admin JWT, or the production verification workflow's GitHub
 * OIDC identity (lib/systemHealthAuth). No PII, no secrets. Never writes.
 * Rate-limited and cached for 60s so it can't be used to load Google.
 */
'use strict';

const express = require('express');
const { rateLimit } = require('../lib/rateLimit');
const { requireAdminOrVerificationWorkflow } = require('../lib/systemHealthAuth');

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, max: 10 }));
router.use(requireAdminOrVerificationWorkflow());
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const CACHE_MS = 60 * 1000;
function cached(fn) {
  let entry = null;
  let inFlight = null;
  return async () => {
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      inFlight = inFlight || fn().finally(() => { inFlight = null; });
      entry = { at: Date.now(), value: await inFlight };
    }
    return entry.value;
  };
}
const integrity = cached(() => require('../lib/booking/phoneCallIntegrity').phoneCallIntegrity());
const ambiguous = cached(() => require('../lib/booking/legacyPhoneCallInvestigation').investigateAmbiguousLegacyPhoneCalls());

router.get('/phone-calls', async (req, res) => {
  try { res.json(await integrity()); } catch (e) {
    console.error('[system-health] phone-calls failed:', e.message);
    res.status(500).json({ error: 'integrity_check_failed' });
  }
});

router.get('/phone-calls/ambiguous', async (req, res) => {
  try { res.json(await ambiguous()); } catch (e) {
    console.error('[system-health] ambiguous investigation failed:', e.message);
    res.status(500).json({ error: 'investigation_failed' });
  }
});

module.exports = router;
