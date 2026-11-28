/* eslint-disable no-undef */
'use strict';

/**
 * qbAcceptanceReportScheduler — November 2026 final-acceptance follow-up,
 * item 1 (durable automatic acceptance reporting).
 *
 * Problem: scripts/qbPostRecoveryAcceptanceReport.js is a real, read-only
 * acceptance-checklist tool, but running it still required a human (or a
 * Claude session) to remember to do so at 24h/72h/7d after QuickBooks
 * genuinely recovers. This module closes that gap by hooking the SAME
 * verified-recovery event lib/qbRecoveryVerification.js already establishes
 * (breaker closed AND both sync cursors genuinely caught up — never merely
 * "the breaker closed") and scheduling the three reports automatically from
 * inside productionWatchdog.js's existing tick — which already runs every
 * ~15 minutes in artistic-determination, completely independent of any
 * Claude session, with zero new cron/service/infrastructure.
 *
 * Durable across restarts/deploys: state lives in a real Postgres table
 * (qb_acceptance_report_schedule — see db/migrations/2026-84-*.sql), never
 * in-process memory.
 *
 * Duplicate prevention: each of the three report windows (24h/72h/7d) has
 * its own `report_*_sent_at` column, checked-then-set exactly once; there
 * is at most one Railway cron-job process alive at a time for this
 * service (confirmed: artistic-determination is a one-shot cron, 0
 * persistent replicas — see CLAUDE.md), so no additional locking is
 * needed beyond "don't resend a window that already has a timestamp."
 *
 * No additional QuickBooks API calls: the report itself
 * (scripts/qbPostRecoveryAcceptanceReport.js#buildReport) only ever issues
 * SELECT statements against this CRM's own already-recorded data
 * (qb_api_usage_by_entity_daily, sync_cursors, qb_rate_limit_breaker's own
 * app_settings row, qb_invoices_cache/qb_payments_cache, qb_cdc_failed_records).
 */

const db = require('../db/client');

const OFFSETS_HOURS = { report_24h: 24, report_72h: 72, report_7d: 168 };

async function getActiveSchedule() {
  const { rows } = await db.query(
    `SELECT * FROM qb_acceptance_report_schedule WHERE superseded_at IS NULL ORDER BY recovery_verified_at DESC LIMIT 1`
  );
  return rows[0] || null;
}

/**
 * Called the moment lib/qbRecoveryVerification.js#maybeNotifyVerifiedRecovery
 * fires its one "verified recovery" email — establishes the SAME timestamp
 * as the schedule's anchor, never a second, independently-computed one.
 * Supersedes any still-active schedule first (defensive — there should
 * never be one, since a genuine failure already supersedes the prior
 * schedule via supersedeActiveSchedule below).
 */
async function startSchedule(recoveredAt) {
  await db.query(`UPDATE qb_acceptance_report_schedule SET superseded_at = NOW(), updated_at = NOW() WHERE superseded_at IS NULL`);
  const iso = (recoveredAt instanceof Date ? recoveredAt : new Date(recoveredAt || Date.now())).toISOString();
  const { rows } = await db.query(
    `INSERT INTO qb_acceptance_report_schedule (recovery_verified_at) VALUES ($1) RETURNING id`,
    [iso]
  );
  return rows[0].id;
}

/**
 * Called whenever `quickbooks-integration` is reported unhealthy again
 * (the SAME moment lib/qbRecoveryVerification.js#clearOnFailure fires) —
 * marks any still-active schedule superseded so no further report is sent
 * for a recovery that didn't actually hold, and a later, genuinely new
 * recovery starts a fresh schedule rather than being confused with it.
 * Best-effort; never throws.
 */
async function supersedeActiveSchedule() {
  try {
    await db.query(`UPDATE qb_acceptance_report_schedule SET superseded_at = NOW(), updated_at = NOW() WHERE superseded_at IS NULL`);
  } catch (e) {
    console.warn('[qb-acceptance-report-scheduler] supersedeActiveSchedule failed (non-fatal): ' + e.message);
  }
}

/**
 * Checks the active schedule (if any) for any report window whose due
 * time has arrived and hasn't been sent yet, builds the real acceptance
 * report (scripts/qbPostRecoveryAcceptanceReport.js#buildReport — zero
 * QuickBooks API calls), and invokes sendFn with the rendered content.
 * Marks that window sent ONLY after sendFn resolves without throwing — a
 * delivery failure is logged and left for the next tick to retry, never
 * silently marked sent.
 */
async function processDueReports(sendFn) {
  const schedule = await getActiveSchedule();
  if (!schedule) return { processed: false, reason: 'no_active_schedule' };

  const now = Date.now();
  const recoveredAtMs = new Date(schedule.recovery_verified_at).getTime();
  const sent = [];
  const skipped = [];

  for (const [windowKey, hours] of Object.entries(OFFSETS_HOURS)) {
    const sentAtCol = `${windowKey}_sent_at`;
    if (schedule[sentAtCol]) { skipped.push({ windowKey, reason: 'already_sent' }); continue; }
    const dueAtMs = recoveredAtMs + hours * 60 * 60 * 1000;
    if (now < dueAtMs) { skipped.push({ windowKey, reason: 'not_due_yet' }); continue; }

    let report;
    try {
      report = await require('../scripts/qbPostRecoveryAcceptanceReport').buildReport();
    } catch (e) {
      console.warn(`[qb-acceptance-report-scheduler] buildReport failed for ${windowKey} (non-fatal, retried next tick): ${e.message}`);
      skipped.push({ windowKey, reason: 'build_failed', error: e.message });
      continue;
    }

    try {
      await sendFn({ windowKey, hoursSinceRecovery: hours, scheduleId: schedule.id, recoveryVerifiedAt: schedule.recovery_verified_at, report });
      await db.query(
        `UPDATE qb_acceptance_report_schedule SET ${sentAtCol} = NOW(), updated_at = NOW() WHERE id = $1`,
        [schedule.id]
      );
      sent.push(windowKey);
    } catch (e) {
      console.warn(`[qb-acceptance-report-scheduler] send failed for ${windowKey} (non-fatal, retried next tick): ${e.message}`);
      skipped.push({ windowKey, reason: 'send_failed', error: e.message });
    }
  }

  return { processed: true, scheduleId: schedule.id, sent, skipped };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const WINDOW_LABELS = { report_24h: '24 hours', report_72h: '72 hours', report_7d: '7 days' };

/**
 * Pure (no DB, no I/O) — renders the acceptance report as plain HTML for
 * emailService.send()'s required htmlBody. Explicitly repeats the
 * report's own "not verified consumption" caveats in the email itself, so
 * the wording can never be lost by only being in the underlying JSON.
 */
function renderReportEmailHtml({ windowKey, hoursSinceRecovery, recoveryVerifiedAt, report }) {
  const windowLabel = WINDOW_LABELS[windowKey] || `${hoursSinceRecovery}h`;
  const v = report.verdict || {};
  const verdictRows = Object.entries(v)
    .map(([k, val]) => `<tr><td style="padding:2px 8px;font-weight:bold;">${escapeHtml(k)}</td><td style="padding:2px 8px;color:${val === false ? '#b00020' : '#1a7f37'};">${escapeHtml(String(val))}</td></tr>`)
    .join('\n');
  const usage = report.locally_measured_usage || {};
  return `
    <h2>QuickBooks Acceptance Report — ${escapeHtml(windowLabel)} since verified recovery</h2>
    <p>Recovery verified at: <b>${escapeHtml(recoveryVerifiedAt)}</b></p>
    <h3>Verdict</h3>
    <table>${verdictRows}</table>
    <h3>Locally measured API usage (approximate, day-granularity)</h3>
    <p>Last 24h: ${escapeHtml(usage.last_24h_approx?.total ?? 'n/a')} calls &middot;
       Last 72h: ${escapeHtml(usage.last_72h_approx?.total ?? 'n/a')} calls &middot;
       Last 7d: ${escapeHtml(usage.last_7d_approx?.total ?? 'n/a')} calls</p>
    <p style="color:#555;font-size:0.9em;">
      This is this CRM's own locally measured call volume — it has NOT been
      confirmed against Intuit's own Developer Portal usage chart (no API
      exposes that figure to this codebase). The ~7,000/month figure some
      internal documentation cites is a pre-recovery projection, never a
      verified consumption measurement — only the numbers above, measured
      after a genuine recovery, are real evidence.
    </p>
    <h3>Duplicate QuickBooks document numbers (company-wide)</h3>
    <p>Invoices: ${report.duplicate_detection?.duplicate_invoice_doc_numbers?.length ?? 0} &middot;
       Payments: ${report.duplicate_detection?.duplicate_payment_doc_numbers?.length ?? 0}</p>
    <h3>Unresolved CDC item-level failures</h3>
    <p>Total unresolved: ${report.cdc_item_failures?.unresolved_total ?? 0} &middot;
       Stale (&gt;48h): ${report.cdc_item_failures?.unresolved_stale_over_48h?.length ?? 0}</p>
    <p style="color:#555;font-size:0.9em;">Full report JSON is available on request via
      <code>node scripts/qbPostRecoveryAcceptanceReport.js --json</code>.</p>
  `;
}

module.exports = {
  getActiveSchedule,
  startSchedule,
  supersedeActiveSchedule,
  processDueReports,
  renderReportEmailHtml,
  OFFSETS_HOURS,
};
