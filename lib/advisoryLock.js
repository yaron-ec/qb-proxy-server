/* eslint-disable no-undef */
'use strict';

/**
 * advisoryLock — generic Postgres session-level advisory lock helper
 * (QuickBooks reliability audit, October 2026), extracted so a call site
 * doesn't have to reimplement its own lock/unlock boilerplate. Mirrors the
 * pattern already used independently by lib/qbTokenManager.js's refresh
 * lock (a single global int key), lib/qbEstimateInvoice.js#withDealLock
 * (namespace + per-deal key), and db/migrate.js (a single global int key)
 * — this is the first place that pattern is shared rather than re-copied.
 *
 * Held across the caller's async work (never a DB transaction — no row
 * locks are held while e.g. a QuickBooks network call is in flight, per
 * CLAUDE.md's "do not hold a transaction open across an external API
 * call" rule), and always released in a finally block, even if fn() throws.
 *
 * Advisory-lock namespaces already in use elsewhere in this codebase —
 * pick a new one when adding a call site, never reuse one of these:
 *   1001 lib/booking/appointmentWriter.js (per-owner booking conflict check)
 *   1002 lib/booking/leadResolution.js (lead-intake identity lock)
 *   1003 lib/qbEstimateInvoice.js (per-deal QB estimate/invoice creation)
 *   1004 server.js (legacy QB proxy write routes — see QB_LEGACY_WRITE_LOCK_NAMESPACE)
 */
async function withAdvisoryLock(pool, namespace, key, fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, hashtext($2::text))', [namespace, String(key)]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, hashtext($2::text))', [namespace, String(key)]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

module.exports = { withAdvisoryLock };
