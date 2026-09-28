/* eslint-disable no-undef */
/**
 * GET /api/public/phone-call-integrity — READ-ONLY aggregate proof that Phone
 * Calls are follow-up reminders and never appointments (see
 * lib/booking/phoneCallIntegrity.js). Counts, booleans and short opaque refs
 * only — no names, contact details, notes, titles, dates or times. Never writes.
 * Public so it can be checked from CI without credentials; rate-limited and
 * cached for 60s so it can't be used to load Google Calendar.
 */
'use strict';

const express = require('express');
const { rateLimit } = require('../lib/rateLimit');
const { phoneCallIntegrity } = require('../lib/booking/phoneCallIntegrity');

const router = express.Router();
const CACHE_MS = 60 * 1000;
let cached = null;
let inFlight = null;

router.get('/', rateLimit({ windowMs: 60 * 1000, max: 6 }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      inFlight = inFlight || phoneCallIntegrity().finally(() => { inFlight = null; });
      cached = { at: Date.now(), report: await inFlight };
    }
    res.json(cached.report);
  } catch (e) {
    console.error('[phone-call-integrity] failed:', e.message);
    res.status(500).json({ error: 'integrity_check_failed' });
  }
});

module.exports = router;
