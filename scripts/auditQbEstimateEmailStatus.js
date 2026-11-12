#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditQbEstimateEmailStatus — PURE READ-ONLY report of the actual, observed
 * distribution of QuickBooks' own Estimate.EmailStatus field across every
 * synced handoff_estimates row, once db/migrations/2026-71-estimate-followup-
 * automation.sql's qb_email_status/qb_email_delivery_time columns have been
 * live in production for at least one full sync cycle (server.js's QB
 * Estimate Sync cron runs every 15 minutes, unconditional unless
 * QB_SYNC_CRON_ENABLED=false — see CLAUDE.md's "QB Estimate Sync Cron"
 * entries).
 *
 * This is the concrete next step named in lib/estimateSentDetection.js's own
 * header comment to resolve, empirically rather than by guessing, the one
 * deciding fact that code alone cannot answer from this environment: whether
 * Handoff's own push of an estimate into QuickBooks ever triggers
 * QuickBooks' own email-send mechanism (the only thing that sets EmailStatus
 * to 'EmailSent'). Handoff most plausibly emails the customer through ITS
 * OWN system, entirely outside QuickBooks — in which case EmailStatus would
 * read 'NotSet'/'NeedToSend' for every Handoff-origin estimate, and the
 * automatic-enrollment path (lib/estimateFollowupEngine.js#runAutoEnrollmentScan)
 * — while real, correctly implemented, and requiring zero new QuickBooks API
 * calls or scope — would simply never fire for this installation's actual
 * estimate source. This script reports which of those two worlds production
 * is actually in, rather than leaving it a guess.
 *
 * No --apply flag exists in this script at all — it issues nothing but
 * SELECT statements and calls no external API. Safe to run against
 * production at any time.
 *
 * Usage:
 *   node scripts/auditQbEstimateEmailStatus.js [--json] [--sample-limit=20]
 */
'use strict';

const { pool } = require('../db/client');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

async function buildReport(opts = {}) {
  const sampleLimit = opts.sampleLimit || 20;

  const { rows: totalRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM handoff_estimates`);
  const total = totalRows[0].n;

  const { rows: byEmailStatus } = await pool.query(
    `SELECT COALESCE(qb_email_status, '(null — never synced since this column was added, or genuinely absent on the QB payload)') AS qb_email_status,
            COUNT(*)::int AS count
       FROM handoff_estimates
      GROUP BY qb_email_status
      ORDER BY count DESC`
  );

  const { rows: byEmailStatusAndEstimateStatus } = await pool.query(
    `SELECT COALESCE(qb_email_status, '(null)') AS qb_email_status,
            COALESCE(estimate_status, '(null)') AS estimate_status,
            COUNT(*)::int AS count
       FROM handoff_estimates
      GROUP BY qb_email_status, estimate_status
      ORDER BY count DESC`
  );

  const { rows: bySyncSource } = await pool.query(
    `SELECT COALESCE(sync_source, '(null)') AS sync_source,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE qb_email_status = 'EmailSent')::int AS email_sent_count
       FROM handoff_estimates
      GROUP BY sync_source
      ORDER BY total DESC`
  );

  const { rows: emailSentRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM handoff_estimates WHERE qb_email_status = 'EmailSent'`
  );
  const emailSentTotal = emailSentRows[0].n;

  const { rows: emailSentWithDeliveryTime } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM handoff_estimates WHERE qb_email_status = 'EmailSent' AND qb_email_delivery_time IS NOT NULL`
  );

  const { rows: sample } = await pool.query(
    `SELECT id, lead_id, qb_estimate_id, qb_estimate_number, estimate_status, sync_source,
            qb_email_status, qb_email_delivery_time, last_synced_at
       FROM handoff_estimates
      WHERE qb_email_status = 'EmailSent'
      ORDER BY last_synced_at DESC
      LIMIT $1`,
    [sampleLimit]
  );

  // The deciding verdict this script exists to compute: does EmailStatus
  // ever read EmailSent at all, for ANY estimate, regardless of source?
  // 0 means every synced estimate has EmailStatus NotSet/NeedToSend/null —
  // i.e. QuickBooks' own send feature appears to never be used for this
  // installation's estimates, and the automatic-enrollment path has no
  // evidence to act on. >0 means real, usable evidence exists.
  const verdict = emailSentTotal > 0
    ? `CONFIRMED: ${emailSentTotal} estimate(s) carry QuickBooks EmailStatus='EmailSent' — the automatic-enrollment path has real evidence to act on.`
    : `NO EVIDENCE YET: zero estimates carry EmailStatus='EmailSent'. Either QuickBooks' own Send feature has never been used for any synced estimate (Handoff likely emails customers through its own system, outside QuickBooks — matching this codebase's own documented hypothesis), or the sync hasn't run since qb_email_status started being persisted (migration 2026-71). Re-run this script after at least one full QB Estimate Sync cron cycle (15 min) to confirm which.`;

  return {
    generated_at: new Date().toISOString(),
    total_handoff_estimates: total,
    by_email_status: byEmailStatus,
    by_email_status_and_estimate_status: byEmailStatusAndEstimateStatus,
    by_sync_source: bySyncSource,
    email_sent_total: emailSentTotal,
    email_sent_with_delivery_time: emailSentWithDeliveryTime[0].n,
    sample_email_sent_rows: sample,
    verdict,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const sampleLimitVal = flagVal('sample-limit');
  const sampleLimit = sampleLimitVal ? parseInt(sampleLimitVal, 10) : undefined;
  const report = await buildReport({ sampleLimit });

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[qb-email-status] total handoff_estimates rows: ${report.total_handoff_estimates}`);
    console.log('[qb-email-status] by qb_email_status:');
    for (const r of report.by_email_status) console.log(`  ${r.qb_email_status}: ${r.count}`);
    console.log('[qb-email-status] by qb_email_status x estimate_status:');
    for (const r of report.by_email_status_and_estimate_status) {
      console.log(`  qb_email_status=${r.qb_email_status} estimate_status=${r.estimate_status}: ${r.count}`);
    }
    console.log('[qb-email-status] by sync_source:');
    for (const r of report.by_sync_source) {
      console.log(`  ${r.sync_source}: total=${r.total} email_sent=${r.email_sent_count}`);
    }
    console.log(`[qb-email-status] EmailSent total: ${report.email_sent_total} (with a usable delivery timestamp: ${report.email_sent_with_delivery_time})`);
    if (report.sample_email_sent_rows.length) {
      console.log(`[qb-email-status] sample EmailSent rows (up to ${report.sample_email_sent_rows.length}):`);
      for (const r of report.sample_email_sent_rows) {
        console.log(`  estimate ${r.qb_estimate_number || r.qb_estimate_id} lead=${r.lead_id} status=${r.estimate_status} delivery_time=${r.qb_email_delivery_time} last_synced_at=${r.last_synced_at}`);
      }
    }
    console.log(`[qb-email-status] VERDICT: ${report.verdict}`);
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildReport };
