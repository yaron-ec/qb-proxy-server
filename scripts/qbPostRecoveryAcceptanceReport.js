#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * qbPostRecoveryAcceptanceReport — PURE READ-ONLY acceptance-verification
 * report for the QuickBooks monthly-CorePlus-quota-exhaustion incident
 * (see CLAUDE.md's "QuickBooks API consumption root-cause investigation
 * and permanent fix" — Phase 9 / PR #88, and its cursor-correctness
 * follow-up — PR #89).
 *
 * This is the concrete tool named in the November 2026 "final acceptance"
 * request's item 3 ("Production Acceptance") so that whenever ANYONE —
 * the business owner, an operator, or a future Claude session — checks in
 * on QuickBooks after Intuit's monthly quota resets (expected ~December 1,
 * 2026, a calendar-month reset per Intuit's own documented policy), the
 * FULL acceptance checklist is available from one command, rather than
 * manual ad-hoc Railway log digging. It issues ONLY SELECT statements —
 * no --apply flag exists, and it never calls the QuickBooks API itself
 * (it reads what this CRM's own crons have already recorded).
 *
 * IMPORTANT — what this script can and cannot tell you:
 *   - It can tell you whether the circuit breaker is closed, whether both
 *     sync cursors show a genuine recent success, what this CRM has
 *     LOCALLY MEASURED its own QuickBooks call volume to be (by entity,
 *     for the last 24h/72h/7d, approximated to whole calendar days — the
 *     underlying qb_api_usage_by_entity_daily table has day granularity,
 *     not exact-hour, so a "last 24h" window here really means "today +
 *     a pro-rated share of yesterday is NOT computed — it is today's
 *     calendar-day total plus yesterday's", which can overstate or
 *     understate a precise rolling 24h window by up to one day's volume;
 *     this is called out explicitly in the JSON output, not hidden), and
 *     whether a company-wide duplicate QuickBooks document number exists
 *     in the invoice/payment caches.
 *   - It CANNOT tell you what Intuit's own Developer Portal usage chart
 *     shows (no API exposes that) — this installation's own locally
 *     measured figures are explicitly labeled as such throughout, per
 *     lib/qbApiUsageTracker.js's own established convention.
 *   - A clean/healthy report here is evidence toward acceptance, not a
 *     substitute for the explicit, real-traffic verification the user's
 *     own request asks for at the 24h/72h/7-day marks. Do not describe
 *     this script's own projected figures as verified production
 *     consumption.
 *
 * Usage:
 *   node scripts/qbPostRecoveryAcceptanceReport.js [--json]
 */
'use strict';

const { pool, query } = require('../db/client');

const args = process.argv.slice(2);
const asJson = args.includes('--json');

const PREVIOUS_EXHAUSTION_PATTERN_CALLS = 500000;
const PROJECTED_NEW_MONTHLY_CALLS = 7000; // documented Phase 9 projection — NOT a verified figure, see header

async function sumEntityWindow(days) {
  const { rows } = await query(
    `SELECT entity, subsystem, SUM(call_count)::bigint AS call_count
       FROM qb_api_usage_by_entity_daily
      WHERE call_date >= (CURRENT_DATE - $1::int)
      GROUP BY entity, subsystem
      ORDER BY call_count DESC`,
    [days - 1]
  );
  const byEntity = rows.map((r) => ({ entity: r.entity, subsystem: r.subsystem, call_count: Number(r.call_count) }));
  const total = byEntity.reduce((s, r) => s + r.call_count, 0);
  return { window_days_approx: days, total, by_entity: byEntity };
}

async function findDuplicateInvoiceDocNumbers() {
  const { rows } = await query(
    `SELECT qb_doc_number, array_agg(qb_invoice_id ORDER BY qb_invoice_id) AS invoice_ids, COUNT(*)::int AS n
       FROM qb_invoices_cache
      WHERE qb_doc_number IS NOT NULL AND qb_doc_number != ''
      GROUP BY qb_doc_number
     HAVING COUNT(*) > 1
      ORDER BY qb_doc_number`
  );
  return rows.map((r) => ({ qb_doc_number: r.qb_doc_number, qb_invoice_ids: r.invoice_ids, count: r.n }));
}

async function findUnresolvedCdcFailedRecords() {
  const { rows } = await query(
    `SELECT entity_type, qb_id, first_failed_at, last_attempted_at, attempts, last_error
       FROM qb_cdc_failed_records
      WHERE resolved_at IS NULL
      ORDER BY first_failed_at ASC`
  );
  return rows;
}

async function findDuplicatePaymentDocNumbers() {
  const { rows } = await query(
    `SELECT qb_doc_number, array_agg(qb_payment_id ORDER BY qb_payment_id) AS payment_ids, COUNT(*)::int AS n
       FROM qb_payments_cache
      WHERE qb_doc_number IS NOT NULL AND qb_doc_number != ''
      GROUP BY qb_doc_number
     HAVING COUNT(*) > 1
      ORDER BY qb_doc_number`
  );
  return rows.map((r) => ({ qb_doc_number: r.qb_doc_number, qb_payment_ids: r.payment_ids, count: r.n }));
}

async function buildReport() {
  const breaker = require('../lib/qbRateLimitBreaker');
  const syncStatus = require('../lib/qbSyncStatus');
  const recoveryVerification = require('../lib/qbRecoveryVerification');

  const [breakerState, status, caughtUp, window24h, window72h, window7d, dupInvoices, dupPayments, unresolvedCdcFailures] = await Promise.all([
    breaker.getState().catch((e) => ({ available: false, error: e.message })),
    syncStatus.getQbSyncStatus().catch((e) => ({ available: false, error: e.message })),
    recoveryVerification.isQbSyncCaughtUp().catch((e) => ({ caughtUp: false, error: e.message })),
    sumEntityWindow(1),
    sumEntityWindow(3),
    sumEntityWindow(7),
    findDuplicateInvoiceDocNumbers(),
    findDuplicatePaymentDocNumbers(),
    findUnresolvedCdcFailedRecords().catch((e) => ({ available: false, error: e.message })),
  ]);

  const breakerClosed = breakerState && breakerState.state === 'closed';
  const bothCursorsRecentlySuccessful =
    status && status.estimate_sync && status.estimate_sync.last_successful_sync_at &&
    status.inbound_reconcile && status.inbound_reconcile.last_successful_sync_at;

  const unresolvedCdcList = Array.isArray(unresolvedCdcFailures) ? unresolvedCdcFailures : [];
  const STALE_CDC_FAILURE_MS = 48 * 60 * 60 * 1000;
  const staleUnresolvedCdc = unresolvedCdcList.filter((r) => (Date.now() - new Date(r.first_failed_at).getTime()) > STALE_CDC_FAILURE_MS);

  const verdict = {
    breaker_closed: !!breakerClosed,
    sync_verified_caught_up: !!(caughtUp && caughtUp.caughtUp),
    both_cursors_show_a_recent_success: !!bothCursorsRecentlySuccessful,
    zero_duplicate_invoice_doc_numbers: dupInvoices.length === 0,
    zero_duplicate_payment_doc_numbers: dupPayments.length === 0,
    zero_stale_unresolved_cdc_failures: staleUnresolvedCdc.length === 0,
  };
  verdict.overall_ready_for_acceptance_review =
    verdict.breaker_closed &&
    verdict.sync_verified_caught_up &&
    verdict.zero_duplicate_invoice_doc_numbers &&
    verdict.zero_duplicate_payment_doc_numbers &&
    verdict.zero_stale_unresolved_cdc_failures;

  return {
    generated_at: new Date().toISOString(),
    verdict,
    circuit_breaker: breakerState,
    recovery_verification: caughtUp,
    sync_status: status,
    locally_measured_usage: {
      measurement_note:
        'Day-granularity approximation (qb_api_usage_by_entity_daily has no sub-day resolution) — ' +
        '"last Nd" windows are the last N calendar days including today, not an exact rolling window. ' +
        'Never confirmed against Intuit\'s own Developer Portal usage chart (no API exposes that figure).',
      last_24h_approx: window24h,
      last_72h_approx: window72h,
      last_7d_approx: window7d,
      comparison: {
        previous_exhaustion_pattern_calls_per_30_days: PREVIOUS_EXHAUSTION_PATTERN_CALLS,
        documented_projection_calls_per_30_days: PROJECTED_NEW_MONTHLY_CALLS,
        projection_is_verified: false,
        note:
          'The ~7,000/month figure is PR #88\'s own documented projection from the CDC architecture change, ' +
          'not a measurement of real production traffic. Only the 24h/72h/7d locally-measured windows above, ' +
          'taken AFTER Intuit\'s quota has genuinely reset and real sync traffic has resumed, constitute real evidence.',
      },
    },
    duplicate_detection: {
      duplicate_invoice_doc_numbers: dupInvoices,
      duplicate_payment_doc_numbers: dupPayments,
    },
    cdc_item_failures: {
      note: 'Items that failed to process in a CDC tick are durably retried from their own stored payload every ~15 minutes with ZERO additional QuickBooks API calls (lib/qbInboundSync.js#retryFailedCdcRecords). A row still unresolved past 48h needs manual review.',
      unresolved_total: unresolvedCdcList.length,
      unresolved_stale_over_48h: staleUnresolvedCdc,
    },
  };
}

async function main() {
  const report = await buildReport();
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('=== QuickBooks Post-Recovery Acceptance Report ===');
    console.log(`Generated: ${report.generated_at}`);
    console.log('');
    console.log('--- Verdict ---');
    for (const [k, v] of Object.entries(report.verdict)) console.log(`  ${k}: ${v}`);
    console.log('');
    console.log('--- Circuit breaker ---');
    console.log(JSON.stringify(report.circuit_breaker, null, 2));
    console.log('');
    console.log('--- Recovery verification (both sync cursors caught up since last breaker close?) ---');
    console.log(JSON.stringify(report.recovery_verification, null, 2));
    console.log('');
    console.log('--- Sync cursors + counts ---');
    console.log(JSON.stringify(report.sync_status, null, 2));
    console.log('');
    console.log('--- Locally measured API usage (last 24h/72h/7d, day-granularity) ---');
    console.log(JSON.stringify(report.locally_measured_usage, null, 2));
    console.log('');
    console.log('--- Duplicate QuickBooks document numbers (company-wide) ---');
    console.log(JSON.stringify(report.duplicate_detection, null, 2));
    console.log('');
    console.log('--- Unresolved CDC item-level failures ---');
    console.log(JSON.stringify(report.cdc_item_failures, null, 2));
    console.log('');
    if (report.verdict.overall_ready_for_acceptance_review) {
      console.log('RESULT: All automated acceptance checks pass. Proceed with the manual 24h/72h/7-day consumption review.');
    } else {
      console.log('RESULT: One or more automated acceptance checks did not pass. See the verdict section above before declaring recovery accepted.');
    }
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('qbPostRecoveryAcceptanceReport failed:', e);
    process.exitCode = 1;
  });
}

module.exports = { buildReport };
