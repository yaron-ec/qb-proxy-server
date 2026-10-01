/* eslint-disable no-undef */
/**
 * routes/systemHealth.js — ADMIN-ONLY System Health (mounted at /api/v1/system).
 *
 *   GET /phone-calls            aggregate Phone Call integrity (counts and
 *                               booleans only — lib/booking/phoneCallIntegrity)
 *   GET /phone-calls/ambiguous  read-only provenance of the legacy Phone Call
 *                               rows the conversion left 'ambiguous'
 *                               (lib/booking/legacyPhoneCallInvestigation)
 *   GET /attribution-integrity  aggregate attribution / funnel-history /
 *                               status-vocabulary / SignNow-Sold integrity
 *                               (lib/marketing/attributionIntegrity — counts
 *                               and labels only, no PII)
 *   GET /lead-diagnostic/:id    single-lead Follow-Up/Appointment diagnostic
 *                               bundle (lib/leadDiagnostic) — the safe way to
 *                               inspect one specific production lead's
 *                               canonical follow-up, full appointment
 *                               history, activities, reminder state and
 *                               calendar/outbox linkage without DB
 *                               credentials and without any mutation path.
 *
 * Auth: a CRM admin JWT, or the production verification workflow's GitHub
 * OIDC identity (lib/systemHealthAuth). No secrets. Never writes — every
 * handler in this router is a read-only GET; there is no corresponding
 * POST/PUT/DELETE anywhere in this file. /phone-calls* return aggregates
 * only (no PII); /lead-diagnostic/:id is a deliberate, narrower exception —
 * it returns one named lead's own data to an admin who could already read
 * the same lead in full via the normal CRM UI (GET /api/v1/leads/:id), so
 * it grants no access an admin doesn't already have — its value is
 * cross-referencing appointment history/events/reminders/outbox state in
 * one response instead of five separate lookups.
 * Rate-limited; /phone-calls* are cached for 60s so they can't be used to
 * load Google, /lead-diagnostic/:id is never cached (a different lead, or
 * fresh state for the same lead, is expected on every call).
 */
'use strict';

const express = require('express');
const { rateLimit } = require('../lib/rateLimit');
const { requireAdminOrVerificationWorkflow } = require('../lib/systemHealthAuth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const attribution = cached(() => require('../lib/marketing/attributionIntegrity').attributionIntegrity(require('../db/client').pool));

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

// Growth Engine foundation + Phase 0 defects: aggregates only (no PII, no
// click identifiers) — lib/marketing/attributionIntegrity.
router.get('/attribution-integrity', async (req, res) => {
  try { res.json(await attribution()); } catch (e) {
    console.error('[system-health] attribution-integrity failed:', e.message);
    res.status(500).json({ error: 'attribution_integrity_failed' });
  }
});

router.get('/lead-diagnostic/:id', async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(String(id))) return res.status(400).json({ error: 'invalid_lead_id', message: 'id must be a Railway lead UUID.' });
  try {
    const { pool } = require('../db/client');
    const { getLeadDiagnostic } = require('../lib/leadDiagnostic');
    const result = await getLeadDiagnostic(pool, id);
    if (!result) return res.status(404).json({ error: 'not_found' });
    res.json(result);
  } catch (e) {
    console.error('[system-health] lead-diagnostic failed:', e.message);
    res.status(500).json({ error: 'diagnostic_failed' });
  }
});

module.exports = router;
