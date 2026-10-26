#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * reconcileSmsMessageStatus — find (and, only with --apply, correct) outbound
 * sms_messages rows stuck at a non-terminal status because Twilio's
 * delivery-status callback for them was never received.
 *
 * READ-ONLY BY DEFAULT.
 *
 *   node scripts/reconcileSmsMessageStatus.js [--minutes=10] [--limit=500] [--json]
 *   node scripts/reconcileSmsMessageStatus.js --apply --confirm-host=<db host> [--minutes=10] [--limit=500] [--json]
 *
 * ── Why a stuck row can exist (traced in code, not guessed) ──────────────────
 * Every outbound send supplies Twilio a StatusCallback URL
 * (routes/sms.js -> lib/smsClient.js#webhookBaseUrl()), and
 * lib/smsService.js#handleStatusCallback is the ONLY write path that advances
 * a row past its initial INSERT status. Before the October 2026 fix (see
 * lib/smsClient.js#webhookBaseUrl's own header), that URL was built from
 * CRM_PUBLIC_URL -- the FRONTEND's domain, not this backend's -- so every
 * status-callback request Twilio made failed signature verification and was
 * rejected with 401. Twilio does NOT retry a status callback indefinitely:
 * once a message reaches a terminal state on Twilio's side, if that one
 * callback attempt was rejected, no further callback is ever sent for it --
 * the row stays at whatever status our own INSERT last wrote (queued/
 * accepted/sending) forever, even though the fix now makes all FUTURE
 * callbacks work correctly. This script is the one-time (and re-runnable)
 * catch-up: it pulls the REAL current status directly from Twilio's Message
 * resource (lib/smsClient.js#getMessageStatus, a read-only GET -- never
 * creates/updates/cancels anything on Twilio's side) for every outbound row
 * still non-terminal after a bounded grace window, and only with --apply
 * writes the corrected status/error fields -- through the EXACT SAME
 * normalization (lib/smsService.js#normalizeSmsStatus) the live webhook path
 * uses, so a status Twilio reports that this installation hasn't seen before
 * is handled identically (never a raw, unvalidated write).
 *
 * Scope: outbound rows only (direction='outbound') -- an inbound row's
 * status is always 'received', a fixed terminal state with no Twilio-side
 * lifecycle to reconcile. A `created_at` grace window (default 10 minutes)
 * excludes anything that might still be genuinely in flight, so this never
 * races a real-time callback that simply hasn't arrived yet.
 */
'use strict';

const { pool } = require('../db/client');
const smsClient = require('../lib/smsClient');
const smsService = require('../lib/smsService');

const args = process.argv.slice(2);
const flag = (n) => args.some((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const flagVal = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

/**
 * Pure core logic — never calls process.exit, always either returns
 * { summary, results } or throws an Error (optionally carrying a `.code`),
 * so it can be driven directly from a test in-process (with lib/smsClient
 * faked via require.cache injection, the same convention already used by
 * test/integration/sms.int.test.js) without spawning a subprocess or
 * risking the test runner's own process being killed by a stray exit.
 */
async function main(opts = {}) {
  const apply = opts.apply ?? flag('apply');
  const json = opts.json ?? flag('json');
  const minutes = opts.minutes ?? Number(flagVal('minutes') || 10);
  const limit = opts.limit ?? Number(flagVal('limit') || 500);
  const confirmHost = opts.confirmHost !== undefined ? opts.confirmHost : flagVal('confirm-host');

  if (!process.env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL not set'), { code: 'no_database_url' });
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return '?'; } })();
  if (apply && confirmHost !== host) {
    throw Object.assign(new Error(`--apply requires --confirm-host=${host} (the DATABASE_URL host). Nothing changed.`), { code: 'confirm_host_required', host });
  }

  const missing = smsClient.missingConfig();
  if (missing.length) {
    throw Object.assign(new Error(`Twilio not configured -- missing: ${missing.join(', ')}. Cannot reconcile.`), { code: 'twilio_not_configured' });
  }

  // Only truly Twilio-terminal statuses are excluded — 'sent' is NOT
  // terminal (a message can still transition sent -> delivered/undelivered),
  // so a message stuck at 'sent' is just as reconcilable as one stuck at
  // 'queued'/'accepted'/'sending'. Matches lib/smsService.js's own
  // OUTBOUND_STATUS_RANK terminal set.
  const { rows } = await pool.query(
    `SELECT id, twilio_sid, status, created_at, error_code, error_message
       FROM sms_messages
      WHERE direction = 'outbound'
        AND status NOT IN ('delivered','undelivered','failed','canceled')
        AND twilio_sid IS NOT NULL
        AND created_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY created_at ASC
      LIMIT $2`,
    [String(minutes), limit]
  );

  const results = [];
  for (const row of rows) {
    const live = await smsClient.getMessageStatus(row.twilio_sid);
    if (!live.ok) {
      results.push({ id: row.id, twilio_sid: row.twilio_sid, db_status: row.status, outcome: 'check_failed', reason: live.reason });
      continue;
    }
    const normalized = smsService.normalizeSmsStatus(live.status, row.status);
    if (normalized === row.status && live.errorCode === row.error_code && live.errorMessage === row.error_message) {
      results.push({ id: row.id, twilio_sid: row.twilio_sid, db_status: row.status, twilio_status: live.status, outcome: 'unchanged' });
      continue;
    }
    results.push({
      id: row.id, twilio_sid: row.twilio_sid, db_status: row.status, twilio_status: live.status,
      normalized_status: normalized, error_code: live.errorCode, error_message: live.errorMessage,
      outcome: apply ? 'will_update' : 'needs_update',
    });
    if (apply) {
      await pool.query(
        `UPDATE sms_messages SET status = $1, error_code = $2, error_message = $3, updated_at = NOW() WHERE id = $4`,
        [normalized, live.errorCode, live.errorMessage, row.id]
      );
      results[results.length - 1].outcome = 'updated';
    }
  }

  const summary = {
    checked: rows.length,
    unchanged: results.filter((r) => r.outcome === 'unchanged').length,
    updated: results.filter((r) => r.outcome === 'updated').length,
    needs_update: results.filter((r) => r.outcome === 'needs_update').length,
    check_failed: results.filter((r) => r.outcome === 'check_failed').length,
    applied: apply,
  };

  return { summary, results, host, minutes, apply, json };
}

function printReport({ summary, results, host, minutes, apply, json }) {
  if (json) {
    console.log(JSON.stringify({ summary, results }, null, 2));
    return;
  }
  console.log(`Checked ${summary.checked} stuck outbound message(s) (non-terminal for >${minutes}m).`);
  console.log(`  unchanged:     ${summary.unchanged}`);
  console.log(`  ${apply ? 'updated' : 'needs_update'}:  ${apply ? summary.updated : summary.needs_update}`);
  console.log(`  check_failed:  ${summary.check_failed}`);
  for (const r of results) {
    if (r.outcome === 'unchanged') continue;
    console.log(`  - ${r.twilio_sid}: db=${r.db_status} twilio=${r.twilio_status || '?'} -> ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`);
  }
  if (!apply && summary.needs_update > 0) {
    console.log(`\nRe-run with --apply --confirm-host=${host} to write these corrections.`);
  }
}

if (require.main === module) {
  main()
    .then(async (report) => { printReport(report); await pool.end(); })
    .catch(async (e) => {
      console.error(e.message || e);
      try { await pool.end(); } catch (_) { /* ignore */ }
      process.exit(e.code === 'confirm_host_required' ? 2 : 1);
    });
}

module.exports = { main, printReport };
