'use strict';

/**
 * qbWebhookDebounce — bounded coalescing for the QuickBooks webhook
 * receiver's full-rescan triggers (routes/qbWebhook.js).
 *
 * October 2026 "sustained 429, escalate to Intuit" investigation: every
 * relevant Intuit webhook delivery unconditionally fired a FULL estimate
 * rescan (lib/qbSyncTrigger.js#runQbEstimateSyncAsync) and a FULL
 * ~100-customer reconciliation pass (lib/qbInboundSync.js#syncAllMappedCustomers)
 * — not a targeted sync of the one changed entity. Handoff's documented
 * pattern (pushing estimates directly into this QuickBooks company) can
 * generate several such deliveries in quick succession (e.g. a batch of
 * estimates created back-to-back), each one independently kicking off
 * another full pass as soon as the prior one finishes, with no pacing
 * BETWEEN separate webhook-triggered runs (lib/advisoryLock.js's
 * tryWithAdvisoryLock only prevents two runs from overlapping — it does
 * nothing to stop back-to-back runs once the previous one completes). Each
 * extra run is also an extra, uncoordinated consumer of the shared
 * circuit breaker's one precious half-open recovery trial — a webhook
 * arriving moments after a cooldown elapses can "steal" and fail that
 * trial just as easily as a scheduled cron tick, re-opening the breaker
 * and silently resetting the recovery clock a scheduled tick would
 * otherwise have been given.
 *
 * This module provides a single, cross-process-safe (DB-backed, like
 * lib/qbRateLimitBreaker.js) atomic claim: at most one webhook-triggered
 * full rescan may start per DEBOUNCE_WINDOW_MS, regardless of how many
 * Railway replicas are running or how many webhook deliveries arrive in
 * that window. This NEVER loses a legitimate change — the skipped
 * delivery's change is still picked up by whichever run is already in
 * flight (a full reconciliation reflects QuickBooks' CURRENT state at
 * query time, which by definition already includes the webhook's own
 * change, since the change necessarily landed in QuickBooks before Intuit
 * notified us of it) or, failing that, by the next scheduled 15-minute
 * cron tick (lib/syncOutcome.js's cursors already make that cron the
 * documented, always-running recovery path — see CLAUDE.md).
 *
 * Fails OPEN on its own error (a transient app_settings read/write hiccup
 * must never silently suppress a real sync trigger) — same philosophy as
 * lib/qbRateLimitBreaker.js's own fail-open-on-error behavior.
 */
const db = require('../db/client');

const KEY = 'qb_webhook_debounce';
// Generous enough to coalesce a burst of near-simultaneous webhook
// deliveries (e.g. Handoff batch-creating several estimates within
// seconds of each other) without meaningfully delaying the near-real-time
// sync this webhook exists to provide — the 15-minute cron remains the
// authoritative backstop regardless.
const DEBOUNCE_WINDOW_MS = 60 * 1000;

/**
 * Atomically claims the right to trigger a webhook-driven full rescan.
 * Returns true if this caller may proceed (and the claim was recorded, so
 * any other caller — same process, another replica, another webhook
 * delivery — within DEBOUNCE_WINDOW_MS gets false instead). Returns false
 * when a claim already happened within the window. Never throws — a
 * failure to read/write the debounce state fails OPEN (returns true), so
 * a bug in this mechanism can only ever cause an extra sync, never a
 * silently dropped one.
 */
async function shouldTriggerWebhookSync() {
  try {
    const r = await db.query(
      `INSERT INTO app_settings (key, value, type)
       VALUES ($1, to_jsonb(NOW()::text), 'json')
       ON CONFLICT (key) DO UPDATE
         SET value = to_jsonb(NOW()::text), updated_at = NOW()
         WHERE (app_settings.value #>> '{}')::timestamptz <= NOW() - ($2 || ' milliseconds')::interval
       RETURNING value`,
      [KEY, DEBOUNCE_WINDOW_MS]
    );
    return r.rows.length > 0;
  } catch (e) {
    console.warn('[qb-webhook] debounce check failed — failing open (triggering sync anyway): ' + e.message);
    return true;
  }
}

module.exports = { shouldTriggerWebhookSync, DEBOUNCE_WINDOW_MS, KEY };
