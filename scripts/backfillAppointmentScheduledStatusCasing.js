#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * backfillAppointmentScheduledStatusCasing — one-time (re-runnable) catch-up
 * for leads already stored with the WRONG-cased status literal
 * 'Appointment Scheduled' (capital S), fixing them to the canonical
 * 'Appointment scheduled' (lowercase s) every reader in this codebase
 * actually compares against.
 *
 * ROOT CAUSE this backfills for: lib/booking/bookingService.js#createBooking
 * previously wrote `status = 'Appointment Scheduled'` (capital S) for every
 * brand-new lead born WITH its first appointment — the dominant lead-
 * creation path (public capture, Meta webhook, admin New Lead with an
 * appointment all funnel through this one function). Every READER in this
 * codebase compares against the lowercase spelling instead:
 * crm-frontend/src/lib/design-system.js (STATUS_STYLES — the one canonical
 * source for status values), Dashboard.jsx, Reports.jsx, KanbanBoard.jsx,
 * Settings.jsx, LeadDetailModern.jsx's STATUSES dropdown, and
 * routes/cronJobs.js's mark-invalid-contacts route
 * (`status NOT IN ('Sold', 'Appointment scheduled')`). A lead born with the
 * capitalized literal was therefore silently invisible to every one of
 * those — wrong Kanban column (falls through to an "Unknown"/uncategorized
 * bucket rather than its real stage), absent from status-filtered reports,
 * and NOT excluded by the mark-invalid-contacts cron (a false-positive risk
 * for a lead that is, in fact, a real appointment-scheduled lead, not an
 * invalid contact). bookingService.js now writes the correct lowercase
 * literal for every NEW booking — this script is the one-time catch-up for
 * leads created before that fix shipped.
 *
 * READ-ONLY BY DEFAULT.
 *
 *   node scripts/backfillAppointmentScheduledStatusCasing.js [--json]
 *   node scripts/backfillAppointmentScheduledStatusCasing.js --apply --confirm-host=<db host> [--json]
 *
 * ── What counts as "affected" (deterministic — an exact string match, no
 * judgment call) ────────────────────────────────────────────────────────
 * Every lead whose CURRENT `status` column is the exact literal
 * 'Appointment Scheduled' (capital S). Nothing else about the row is
 * inspected or required to match — this is a pure casing correction.
 *
 * ── What --apply does, per affected lead ─────────────────────────────────
 * A single, scoped `UPDATE leads SET status = 'Appointment scheduled' WHERE
 * id = $1 AND status = 'Appointment Scheduled'` (re-checks the exact old
 * value in the WHERE clause, not just the id, so a lead a human already
 * hand-corrected or moved on between the report query and the apply step is
 * never clobbered) — no other column is touched. This script NEVER reads,
 * writes, or otherwise touches the `appointments` table, `follow_up_*`,
 * `meeting_stage`, or any other lead field: the bug is purely a wrong
 * string value on `leads.status`, so the fix is purely that one column.
 * A lead whose status is ANY other value (including every other casing
 * variant someone might type by hand, e.g. 'appointment scheduled' or
 * 'APPOINTMENT SCHEDULED') is left completely untouched — this backfills
 * the one exact literal this codebase's own buggy write path actually
 * produced, never a fuzzy/case-insensitive correction that could silently
 * reclassify an unrelated, intentionally-different status.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 * Re-running after a successful --apply finds nothing (no lead still has
 * the old capitalized value), so a second run is a safe no-op. A lead
 * updated by a human (or any other process) to a different status between
 * the report query and the apply step no longer matches the WHERE clause's
 * own re-check, so that row is silently skipped rather than overwritten.
 *
 * --apply requires --confirm-host=<DATABASE_URL host> (CLAUDE.md: confirm
 * before any destructive script against production). This script can only
 * be RUN by an operator with real DATABASE_URL access — it was written and
 * unit/integration-tested in a sandboxed environment with no production
 * database or network access, and has NOT itself been executed against the
 * real production database.
 */
'use strict';

const { pool } = require('../db/client');

const OLD_STATUS = 'Appointment Scheduled';
const NEW_STATUS = 'Appointment scheduled';
const ACTOR_PREFIX = 'remediation:status-casing-backfill:';

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

// Finds every lead currently carrying the exact wrong-cased literal — the
// objective, deterministic definition of "affected by the bug".
async function findAffectedLeads() {
  const { rows } = await pool.query(
    `SELECT id, external_ref, first_name, last_name, status, created_at
       FROM leads
      WHERE status = $1
      ORDER BY created_at DESC`,
    [OLD_STATUS]
  );
  return rows;
}

// Re-checks the exact old value in the WHERE clause (not just id) so a
// lead already moved on by a human/another process between the report
// query and this call is never clobbered.
async function fixOne(leadId) {
  const { rowCount } = await pool.query(
    `UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2 AND status = $3`,
    [NEW_STATUS, leadId, OLD_STATUS]
  );
  return rowCount === 1;
}

async function logFix(leadId, actor) {
  await pool.query(
    `INSERT INTO activities (lead_id, type, content, author, source) VALUES ($1, 'note', $2, $3, 'manual')`,
    [leadId, `Status casing corrected: '${OLD_STATUS}' -> '${NEW_STATUS}' (lib/booking/bookingService.js casing fix backfill — no appointment, follow-up, or other field touched).`, actor]
  );
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return '?'; } })();
  const apply = !!flag('apply');
  if (apply && flagVal('confirm-host') !== host) {
    console.error(`--apply requires --confirm-host=${host} (the DATABASE_URL host). Nothing changed.`);
    process.exit(2);
  }

  const runId = apply ? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) : null;
  const actor = runId ? ACTOR_PREFIX + runId : null;

  const leads = await findAffectedLeads();
  const report = {
    database_host: host, generated_at: new Date().toISOString(),
    mode: apply ? 'apply' : 'report-only', run_id: runId,
    old_status: OLD_STATUS, new_status: NEW_STATUS,
    affected_leads: leads.length, records: [],
  };

  for (const lead of leads) {
    const record = {
      lead_id: lead.id, external_ref: lead.external_ref,
      name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      lead_created_at: lead.created_at,
    };
    if (apply) {
      const fixed = await fixOne(lead.id);
      if (fixed) await logFix(lead.id, actor);
      record.apply_result = { fixed };
    }
    report.records.push(record);
  }

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[backfill] db host=${host} mode=${report.mode} run=${runId || '-'}`);
    console.log(`[backfill] leads with status='${OLD_STATUS}': ${report.affected_leads}`);
    if (apply) {
      const totalFixed = report.records.filter(r => r.apply_result && r.apply_result.fixed).length;
      const totalSkipped = report.affected_leads - totalFixed;
      console.log(`[backfill] fixed: ${totalFixed}, skipped (status changed concurrently since the report query): ${totalSkipped}`);
    } else {
      console.log('[backfill] report only — nothing changed. Re-run with --apply --confirm-host=' + host + ' to fix.');
    }
  }
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { findAffectedLeads, fixOne, OLD_STATUS, NEW_STATUS };
