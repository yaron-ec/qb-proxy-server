'use strict';

/**
 * qbSyncStatus — the real, queryable evidence behind the CRM's "QuickBooks
 * sync status" display (Integrations page). Replaces the previous
 * presentation, whose "Last Sync" / synced counts were hardcoded empty
 * arrays with an explicit "no Railway API yet" comment (October 2026
 * reliability recovery pass) — this module reads the ACTUAL sync_cursors
 * rows the two QB crons now persist (see server.js's runQbEstimateSync and
 * the qb-inbound-cron tick, and lib/syncOutcome.js for the outcome
 * classification both write), plus real counts from the tables those crons
 * populate.
 *
 * Every section carries its own `available` flag — a query failure (e.g. an
 * older install mid-migration) is reported as unavailable, never silently
 * rendered as a verified zero. This directly answers the requirement: never
 * display a 0 as if it were verified when the underlying data could not be
 * read at all.
 */
const { query } = require('../db/client');

async function readCursor(integration) {
  try {
    const { rows } = await query(
      `SELECT last_successful_sync_at, last_attempted_at, last_sync_summary FROM sync_cursors WHERE integration = $1`,
      [integration]
    );
    if (!rows[0]) return { available: true, ever_run: false, last_successful_sync_at: null, last_attempted_at: null, summary: null };
    return {
      available: true,
      ever_run: true,
      last_successful_sync_at: rows[0].last_successful_sync_at,
      last_attempted_at: rows[0].last_attempted_at,
      summary: rows[0].last_sync_summary || null,
    };
  } catch (e) {
    return { available: false, error: 'cursor_unavailable' };
  }
}

async function countEstimatesSynced() {
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE match_status = 'matched')::int AS matched,
              COUNT(*) FILTER (WHERE match_status = 'unmatched')::int AS unmatched
       FROM handoff_estimates WHERE sync_source = 'QuickBooks'`
    );
    return { available: true, total: rows[0]?.total || 0, matched: rows[0]?.matched || 0, unmatched: rows[0]?.unmatched || 0 };
  } catch (e) {
    return { available: false, error: 'count_unavailable' };
  }
}

async function countInvoicesSynced() {
  try {
    const { rows } = await query(`SELECT COUNT(*)::int AS total FROM qb_invoices_cache`);
    return { available: true, total: rows[0]?.total || 0 };
  } catch (e) {
    return { available: false, error: 'count_unavailable' };
  }
}

async function countCustomersSynced() {
  try {
    const { rows } = await query(
      `SELECT COUNT(DISTINCT qb_customer_id)::int AS total FROM leads WHERE qb_customer_id IS NOT NULL AND qb_customer_id != ''`
    );
    return { available: true, total: rows[0]?.total || 0 };
  } catch (e) {
    return { available: false, error: 'count_unavailable' };
  }
}

/**
 * The full read model. Every piece is independently best-effort — one
 * failing query never blanks out the others.
 */
async function getQbSyncStatus() {
  const [estimatesCursor, inboundCursor, fullReconcileCursor, estimatesCount, invoicesCount, customersCount, circuitBreaker, apiUsage, apiUsageBreakdown] = await Promise.all([
    readCursor('quickbooks_estimates'),
    readCursor('quickbooks_inbound_reconcile'),
    // November 2026 QB API consumption follow-up: the once-daily, per-
    // customer full-reconciliation safety net now writes its OWN cursor,
    // separate from the frequent incremental cursor above, so the two
    // cadences can be told apart. Informational only here — not part of
    // checkQbSyncScheduler's alerting checks (see that function's own
    // comment for why a daily job's own staleness threshold is kept
    // separate from the frequent path's).
    readCursor('quickbooks_full_reconcile'),
    countEstimatesSynced(),
    countInvoicesSynced(),
    countCustomersSynced(),
    require('./qbRateLimitBreaker').getState().catch(() => null),
    require('./qbApiUsageTracker').getUsageSnapshot().catch(() => ({ available: false })),
    require('./qbApiUsageTracker').getUsageBreakdown().catch(() => ({ available: false })),
  ]);

  return {
    estimate_sync: estimatesCursor,
    inbound_reconcile: inboundCursor,
    full_reconcile: fullReconcileCursor,
    estimates_synced: estimatesCount,
    invoices_synced: invoicesCount,
    customers_synced: customersCount,
    circuit_breaker: circuitBreaker,
    api_usage: apiUsage,
    api_usage_breakdown: apiUsageBreakdown,
    generated_at: new Date().toISOString(),
  };
}

module.exports = { getQbSyncStatus, _readCursor: readCursor };
