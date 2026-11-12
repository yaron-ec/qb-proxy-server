/* eslint-disable no-undef */
/**
 * /api/v1/qb-webhook — QuickBooks webhook receiver (Railway-native).
 *
 * Replaces the Base44 qbWebhook function. Intuit sends webhook notifications
 * here when estimates/invoices are created or updated. The receiver triggers
 * a targeted sync so the CRM reflects the change within seconds — no need
 * to wait for the 15-minute cron backup, which remains the authoritative,
 * always-running recovery path regardless of this webhook's own behavior
 * (see lib/syncOutcome.js / lib/qbSyncStatus.js).
 *
 *   GET  /api/v1/qb-webhook        — Intuit endpoint verification (returns challenge)
 *   POST /api/v1/qb-webhook        — Process event notifications
 *
 * Auth: Intuit-Signature HMAC verification against QB_WEBHOOK_VERIFIER_TOKEN.
 *
 * October 2026 "sustained 429, escalate to Intuit" investigation found this
 * receiver was a previously-unaudited amplifier and an insecure default:
 *   1. Signature verification previously FAILED OPEN when
 *      QB_WEBHOOK_VERIFIER_TOKEN was unset (silently accepting ANY
 *      unauthenticated POST as a real Intuit event). Fixed: in PRODUCTION
 *      (lib/qbEnvironment.js's resolved environment), a missing token now
 *      fails CLOSED (503 not_configured) — same convention as
 *      routes/metaWebhook.js's own fail-closed fix. Outside production
 *      (sandbox/dev), the lenient accept-without-verification behavior is
 *      preserved, logged explicitly, so local/sandbox testing is unaffected.
 *   2. Every relevant notification unconditionally triggered a FULL
 *      estimate rescan + FULL ~100-customer reconciliation pass, with no
 *      awareness of the shared circuit breaker and no coalescing of a
 *      burst of deliveries — an uncoordinated extra consumer of the
 *      breaker's one shared recovery trial, on top of the two scheduled
 *      crons. Fixed: peeks (never consumes) the breaker's cooling-down
 *      state via lib/qbRateLimitBreaker.js#isCoolingDown before triggering,
 *      and bounded-debounces repeated triggers via
 *      lib/qbWebhookDebounce.js. Neither change can ever lose a legitimate
 *      change — a skipped trigger's change is still reflected by whichever
 *      run is already in flight or by the next scheduled cron tick.
 *
 * Idempotent: Intuit retries on non-200. The sync itself is idempotent
 * (upsert by qb_estimate_id / qb_invoice_id) — unchanged by this pass.
 *
 * November 2026 — "100% signature verification failure" production
 * incident, root-caused: this receiver's signature check computed only a
 * HEX digest and compared it to the `intuit-signature` header. Intuit's own
 * webhook-validation documentation and its public AsyncAPI spec both
 * describe that header as a BASE64-encoded HMAC-SHA256 digest, not hex —
 * confirmed against production logs showing this check fail on every real
 * Intuit delivery (13+ occurrences, Nov 5-11 2026) regardless of whether
 * QB_WEBHOOK_VERIFIER_TOKEN was correct, which a pure token mismatch would
 * not explain so consistently. The hex assumption most likely carried over
 * from routes/metaWebhook.js's own (correct, for Meta) hex convention —
 * Meta really does use hex for X-Hub-Signature-256; Intuit does not. Fixed:
 * verifyIntuitSignature now checks BASE64 first (the documented Intuit
 * format) and still accepts HEX as a defensive fallback — accepting either
 * encoding of a digest computed from the correct secret is never a security
 * regression, since both still require knowing QB_WEBHOOK_VERIFIER_TOKEN.
 * The verifier token is also now `.trim()`-ed defensively (a pasted secret
 * with incidental leading/trailing whitespace is a common, separate failure
 * mode this costs nothing to guard against). getSignatureDiagnostics() below
 * gives the next real failure (if any) enough detail to root-cause without
 * guessing again — it never logs the signature, the computed digest, or the
 * token itself, only presence/length/content-type facts.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const qbEnvironment = require('../lib/qbEnvironment');
const { isCoolingDown, getState } = require('../lib/qbRateLimitBreaker');
const { shouldTriggerWebhookSync, DEBOUNCE_WINDOW_MS } = require('../lib/qbWebhookDebounce');
const { rateLimit } = require('../lib/rateLimit');
const router = express.Router();

// November 2026 hardening: this unauthenticated endpoint had no volumetric
// cap at all — a flood still costs a signature check (and, on failure, a
// console.warn) per request with no bound. A generous per-IP window keeps
// legitimate traffic (Intuit's own retries on a non-200, plus the debounced
// webhook-triggered sync this file already guards) completely unaffected —
// Intuit's real delivery volume for a single-company installation is far
// below this — while still bounding an unauthenticated flood's cost.
router.use(rateLimit({ windowMs: 60 * 1000, max: 300 }));

// Optional webhook signature verification
const VERIFIER_TOKEN = (process.env.QB_WEBHOOK_VERIFIER_TOKEN || '').trim();

function verifyIntuitSignature(req) {
  if (!VERIFIER_TOKEN) return false; // caller decides whether "no token configured" is fail-open or fail-closed — see POST handler
  const signature = req.headers['intuit-signature'] || req.headers['intuit-signature-256'] || '';
  if (!signature) return false;
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const expectedBase64 = crypto.createHmac('sha256', VERIFIER_TOKEN).update(rawBody).digest('base64');
  const expectedHex = crypto.createHmac('sha256', VERIFIER_TOKEN).update(rawBody).digest('hex');
  const matches = (expected) => {
    try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
    catch (_) { return false; } // length mismatch or non-matching encoding — never a thrown 500
  };
  return matches(expectedBase64) || matches(expectedHex);
}

/** Diagnostic facts about a signature-verification failure — never the signature, digest, or token. */
function getSignatureDiagnostics(req) {
  const signature = req.headers['intuit-signature'] || req.headers['intuit-signature-256'] || '';
  return {
    has_signature_header: !!signature,
    signature_length: signature.length,
    raw_body_captured: Buffer.isBuffer(req.rawBody),
    content_type: req.headers['content-type'] || null,
  };
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
    const { environment } = qbEnvironment.resolveQbEnvironment();

    if (!VERIFIER_TOKEN) {
      if (environment === 'production') {
        // PRODUCTION SECURITY FIX: this previously fell through and
        // accepted ANY unsigned payload as a genuine Intuit event whenever
        // QB_WEBHOOK_VERIFIER_TOKEN was unset. Same fail-closed convention
        // as routes/metaWebhook.js's own October 2026 fix — distinct 503
        // from a 401 signature mismatch, so an operator can tell "not
        // configured" from "a real but invalid signature" from the status
        // code alone. Does NOT change any Railway variable itself — an
        // operator must set QB_WEBHOOK_VERIFIER_TOKEN for this endpoint to
        // accept production traffic again after this deploys.
        console.warn('[qb-webhook] QB_WEBHOOK_VERIFIER_TOKEN not configured in production — rejecting (fail-closed)');
        return res.status(503).json({ error: 'not_configured', message: 'QuickBooks webhook is not configured for production verification.' });
      }
      // Outside production (sandbox/dev): preserve the historical lenient
      // behavior, but never silently — this is logged so it is visible in
      // Railway logs for any non-production environment that reaches here.
      console.warn('[qb-webhook] QB_WEBHOOK_VERIFIER_TOKEN not configured (environment=' + environment + ') — accepting without signature verification');
    } else if (!verifyIntuitSignature(req)) {
      console.warn('[qb-webhook] Signature verification failed', getSignatureDiagnostics(req));
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
        const { name, id, operation } = entity;

        // Only process Estimate and Invoice create/update events
        const isRelevant = (name === 'Estimate' || name === 'Invoice' || name === 'Payment') &&
                       (operation === 'Create' || operation === 'Update' || operation === 'Delete');

        if (!isRelevant) continue;

        console.log(`[qb-webhook] ${operation} ${name} id=${id} realm=${realmId}`);
        processed++;
      }
    }

    // Trigger a full sync — but only when the shared circuit breaker isn't
    // already cooling down, and only once per debounce window, so a burst
    // of webhook deliveries can never out-compete a scheduled cron tick for
    // the breaker's one shared recovery trial, and can never pile up a
    // series of full reconciliation passes back to back. Neither guard can
    // lose a legitimate change — see this file's header.
    if (processed > 0) {
      try {
        const breakerState = await getState().catch(() => null);
        if (isCoolingDown(breakerState)) {
          console.warn(`[qb-webhook] circuit breaker cooling down (retry at ${breakerState.cooldown_until}) — skipping webhook-triggered rescan; the scheduled reconciliation cron remains the recovery path`);
        } else {
          const shouldTrigger = await shouldTriggerWebhookSync();
          if (!shouldTrigger) {
            console.log(`[qb-webhook] debounced — a webhook-triggered sync started within the last ${DEBOUNCE_WINDOW_MS}ms; relying on that run or the next scheduled reconciliation`);
          } else {
            // Lazy-require to avoid circular dependency with server.js
            const { runQbEstimateSyncAsync } = require('../lib/qbSyncTrigger');
            const { syncAllMappedCustomers } = require('../lib/qbInboundSync');
            runQbEstimateSyncAsync().catch(e => console.error('[qb-webhook] estimate sync error:', e.message));
            syncAllMappedCustomers().catch(e => console.error('[qb-webhook] inbound sync error:', e.message));
          }
        }
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
// Exported for direct unit testing (mirrors routes/metaWebhook.js's own
// verifyMetaSignature export convention) without needing a live HTTP server.
module.exports.verifyIntuitSignature = verifyIntuitSignature;
module.exports.getSignatureDiagnostics = getSignatureDiagnostics;
