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
  const [estimatesCursor, inboundCursor, estimatesCount, invoicesCount, customersCount, circuitBreaker] = await Promise.all([
    readCursor('quickbooks_estimates'),
    readCursor('quickbooks_inbound_reconcile'),
    countEstimatesSynced(),
    countInvoicesSynced(),
    countCustomersSynced(),
    require('./qbRateLimitBreaker').getState().catch(() => null),
  ]);

  return {
    estimate_sync: estimatesCursor,
    inbound_reconcile: inboundCursor,
    estimates_synced: estimatesCount,
    invoices_synced: invoicesCount,
    customers_synced: customersCount,
    circuit_breaker: circuitBreaker,
    generated_at: new Date().toISOString(),
  };
}

module.exports = { getQbSyncStatus, _readCursor: readCursor };
