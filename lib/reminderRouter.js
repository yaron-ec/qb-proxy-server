/* eslint-disable no-undef */
/**
 * Express router for the Railway reminder system.
 * Mounted at /reminders in server.js. Guarded by X-Proxy-Secret (PROXY_SECRET).
 *
 * Routes:
 *   POST /reminders/process?dryRun=true   — run one reminder pass
 *   GET  /reminders/health                — health/heartbeat snapshot
 *   POST /reminders/clear-gmail-lock      — manually clear the credential lock
 *
 * In Phase 2, REMINDER_DRY_RUN=true forces every /process call to dry-run
 * regardless of the query param, so no production emails can be sent yet.
 */
'use strict';

const express = require('express');
const engine = require('./reminderEngine');
const health = require('./reminderHealth');

const router = express.Router();

const PROXY_SECRET = process.env.PROXY_SECRET;
function requireProxySecret(req, res, next) {
  const secret = req.headers['x-proxy-secret'];
  if (!PROXY_SECRET || secret !== PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing or invalid X-Proxy-Secret' });
  }
  next();
}

router.post('/process', requireProxySecret, async (req, res) => {
  const paramDryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
  // Phase 2 safety: dry-run is the DEFAULT. Only an explicit REMINDER_DRY_RUN=false
  // can allow a real send via HTTP. (Worker defaults the same way.)
  const envDryRun = process.env.REMINDER_DRY_RUN !== 'false';
  const dryRun = envDryRun || paramDryRun;
  try {
    const result = await engine.processReminders({ dryRun, triggeredBy: req.query.by || 'http' });
    res.json(result);
  } catch (e) {
    console.error('[reminders/process] error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/health', requireProxySecret, async (req, res) => {
  try {
    const h = await health.getHealth();
    res.json(h);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/clear-gmail-lock', requireProxySecret, async (req, res) => {
  try {
    await health.clearGmailCredentialsLock();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;