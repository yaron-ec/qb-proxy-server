/* eslint-disable no-undef */
/**
 * /api/v1/qb-webhook — QuickBooks webhook receiver (Railway-native).
 *
 * Replaces the Base44 qbWebhook function. Intuit sends webhook notifications
 * here when estimates/invoices are created or updated. The receiver triggers
 * a targeted sync so the CRM reflects the change within seconds — no need
 * to wait for the 15-minute cron backup.
 *
 *   GET  /api/v1/qb-webhook        — Intuit endpoint verification (returns challenge)
 *   POST /api/v1/qb-webhook        — Process event notifications
 *
 * No auth (Intuit webhooks are unauthenticated). Optional Intuit-Signature
 * header verification if QB_WEBHOOK_VERIFIER_TOKEN is set.
 *
 * Idempotent: Intuit retries on non-200. The sync itself is idempotent
 * (upsert by qb_estimate_id / qb_invoice_id).
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// Optional webhook signature verification
const VERIFIER_TOKEN = process.env.QB_WEBHOOK_VERIFIER_TOKEN || '';

function verifyIntuitSignature(req) {
  if (!VERIFIER_TOKEN) return true; // not configured → skip verification
  const signature = req.headers['intuit-signature'] || req.headers['intuit-signature-256'] || '';
  if (!signature) return false;
  // Intuit sends a hex-encoded HMAC-SHA256 of the raw body using the verifier token
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', VERIFIER_TOKEN).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// GET — Intuit endpoint verification
router.get('/', (req, res) => {
  const challenge = req.query.challenge;
  if (challenge) return res.type('text/plain').send(String(challenge));
  res.json({ status: 'active', service: 'qb-webhook' });
});

// POST — Process event notifications
router.post('/', express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  try {
    if (!verifyIntuitSignature(req)) {
      console.warn('[qb-webhook] Signature verification failed');
      return res.status(401).json({ error: 'signature_verification_failed' });
    }

    const payload = req.body || {};
    const eventNotifications = payload.eventNotifications || [];

    if (eventNotifications.length === 0) {
      return res.json({ received: true, processed: 0, reason: 'no_notifications' });
    }

    let processed = 0;
    const errors = [];

    for (const notification of eventNotifications) {
      const realmId = notification.realmId;
      const entities = notification.dataChangeEvent?.entities || [];

      for (const entity of entities) {
        const { name, id, operation, lastUpdated } = entity;

        // Only process Estimate and Invoice create/update events
        const isRelevant = (name === 'Estimate' || name === 'Invoice') &&
                           (operation === 'Create' || operation === 'Update');

        if (!isRelevant) continue;

        console.log(`[qb-webhook] ${operation} ${name} id=${id} realm=${realmId}`);
        processed++;
      }
    }

    // Trigger the full estimate sync (idempotent — upserts by qb_estimate_id).
    // The 15-min cron is the backup; the webhook provides near-real-time updates.
    if (processed > 0) {
      try {
        // Lazy-require to avoid circular dependency with server.js
        const path = require('path');
        const serverPath = path.resolve(__dirname, '..', 'server.js');
        // Can't require server.js (circular). Instead, call the sync function directly.
        // The sync logic is in lib/qbMatch + lib/railwayDataAccess + the QB fetch helpers.
        // For the webhook, we trigger an async sync without blocking the response.
        const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
        runQbEstimateSyncAsync().catch(e => console.error('[qb-webhook] async sync error:', e.message));
      } catch (e) {
        console.warn('[qb-webhook] Could not trigger async sync (non-fatal):', e.message);
      }
    }

    // Always return 200 to prevent Intuit retries (we've accepted the webhook)
    res.json({ received: true, processed, errors: errors.length });
  } catch (e) {
    console.error('[qb-webhook] error:', e.message);
    // Return 200 even on error to prevent infinite retries — the cron will catch up
    res.status(200).json({ received: true, processed: 0, error: e.message });
  }
});

module.exports = router;