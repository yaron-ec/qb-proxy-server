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
 *   1005 QB scheduled-sync cron re-entrancy (lib/qbInboundSync.js,
 *        server.js's runQbEstimateSync) — see tryWithAdvisoryLock below.
 */
async function withAdvisoryLock(pool, namespace, key, fn) {
  const client = await pool.connect();
  let unlockFailed = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, hashtext($2::text))', [namespace, String(key)]);
    try {
      return await fn();
    } finally {
      // If UNLOCK itself fails, the session-level lock stays held on THIS
      // connection (Postgres only releases it on an explicit successful
      // unlock or the session ending) — returning that connection to the
      // pool as healthy would let a future caller silently inherit an
      // already-held lock on a totally unrelated request. Tracked below so
      // the finally block can discard the connection instead of recycling
      // a tainted one.
      await client.query('SELECT pg_advisory_unlock($1, hashtext($2::text))', [namespace, String(key)])
        .catch((e) => { unlockFailed = true; console.warn('[advisory-lock] unlock failed — discarding the connection: ' + e.message); });
    }
  } finally {
    client.release(unlockFailed);
  }
}

/**
 * Non-blocking variant for cron re-entrancy (October 2026 QuickBooks
 * reliability audit, round 2): if the lock is already held — by this
 * process or, critically, by ANOTHER Railway replica/process sharing the
 * same database — this returns { skipped: true } immediately instead of
 * waiting. This replaces a plain in-process JS boolean (`_syncing`,
 * `_estimateSyncRunning`), which only ever prevented overlap within a
 * single Node process; a Postgres session-level advisory lock is held per
 * CONNECTION, so two different connections racing for the same key behave
 * identically whether they come from the same process or two separate
 * ones — exactly the cross-replica safety this was missing.
 */
async function tryWithAdvisoryLock(pool, namespace, key, fn) {
  const client = await pool.connect();
  let unlockFailed = false;
  try {
    const r = await client.query('SELECT pg_try_advisory_lock($1, hashtext($2::text)) AS locked', [namespace, String(key)]);
    if (!r.rows[0].locked) return { skipped: true };
    try {
      const result = await fn();
      return { skipped: false, result };
    } finally {
      // Same rationale as withAdvisoryLock above: an unlock failure must
      // discard this connection rather than let the pool hand out a
      // connection that still silently holds this key's lock.
      await client.query('SELECT pg_advisory_unlock($1, hashtext($2::text))', [namespace, String(key)])
        .catch((e) => { unlockFailed = true; console.warn('[advisory-lock] unlock failed — discarding the connection: ' + e.message); });
    }
  } finally {
    client.release(unlockFailed);
  }
}

module.exports = { withAdvisoryLock, tryWithAdvisoryLock };
