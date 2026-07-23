/* eslint-disable no-undef */
/**
 * Express router for CRM → Railway Postgres lead ingestion.
 * Mounted at /api/reminders in server.js.
 *
 * Route:
 *   POST /api/reminders/leads/upsert   — create or update one lead in reminder_leads
 *
 * Protected by a DEDICATED secret (REMINDER_INGEST_SECRET), sent in the
 * X-Ingest-Secret header — distinct from the proxy's X-Proxy-Secret so lead
 * ingestion can be granted independently of QB proxy access.
 *
 * Contract:
 *   - idempotent by external lead id (INSERT ... ON CONFLICT (id) DO UPDATE)
 *   - validates + normalizes all required fields
 *   - does NOT call Base44
 *   - does NOT call Gmail
 *   - does NOT create reminder claims
 *   - does NOT send emails
 *   - logs NO customer PII (only the lead id + action)
 */
'use strict';

const express = require('express');
const db = require('../db/client');
const { validateAndNormalizeLead, upsertLead } = require('./leadIngest');

const router = express.Router();

const INGEST_SECRET = process.env.REMINDER_INGEST_SECRET;

function requireIngestSecret(req, res, next) {
  const secret = req.headers['x-ingest-secret'];
  if (!INGEST_SECRET || secret !== INGEST_SECRET) {
    return res.status(401).json({ error: 'Unauthorized — missing or invalid X-Ingest-Secret' });
  }
  next();
}

router.post('/leads/upsert', requireIngestSecret, async (req, res) => {
  const v = validateAndNormalizeLead(req.body);
  if (!v.ok) {
    return res.status(400).json({ error: 'validation_failed', details: v.errors });
  }
  try {
    await db.ensureSchema();
    const result = await upsertLead(db, v.lead);
    // No PII logged — only the lead id and the action taken.
    console.log(`[ingest] ${result.action} lead ${result.id}`);
    res.json({ success: true, action: result.action, id: result.id });
  } catch (e) {
    console.error('[ingest] upsert error:', e.message);
    res.status(500).json({ error: 'upsert_failed', message: e.message });
  }
});

module.exports = router;