#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * remediateTerminalLostLeadAppointments — backfill the Closed-Lost/Terminal-
 * Lost appointment-cancellation rule onto historical leads it never applied
 * to (production bug report, lead "Rita Wilcher": her appointment never took
 * place — it was cancelled before the scheduled meeting — but the lead
 * stayed "Lost" in the CRM while the calendar still showed the meeting and
 * its Driving/Travel Time blocks, and the appointment card still offered
 * Done/Reschedule).
 *
 * ROOT CAUSE this backfills for: routes/leads.js's Closed-Lost transition
 * handler (lib/leadStatus.js) originally matched only the literal string
 * 'Closed Lost', which is unreachable through any live UI status control.
 * The real, reachable "lead is dead" status is 'Lost'. lib/leadStatus.js
 * has been generalized to TERMINAL_LOST_STATUSES = ['Lost', 'Closed Lost',
 * 'DNQ', 'Cancelled'], so every NEW transition into any of these is handled
 * correctly going forward. This script is the one-time (re-runnable) catch-
 * up for leads that were ALREADY in one of these statuses before that fix
 * (in either its original or generalized form) shipped, and therefore still
 * carry a stale active appointment and/or a stale follow-up.
 *
 * READ-ONLY BY DEFAULT.
 *
 *   node scripts/remediateTerminalLostLeadAppointments.js [--json] [--since=YYYY-MM-DD]
 *   node scripts/remediateTerminalLostLeadAppointments.js --apply --confirm-host=<db host> [--json]
 *
 * ── What counts as "affected" (deterministic — no judgment call, unlike
 * scripts/auditAppointmentFollowUp.js's MIRROR/DIV_OTHER classes) ───────────
 * A lead whose CURRENT status is in TERMINAL_LOST_STATUSES and that still
 * has (a) an appointment row with status IN ('scheduled','confirmed'), or
 * (b) a non-null follow_up_date/follow_up_type. Per CLAUDE.md's own
 * permanent rule, a terminal-lost lead must have NEITHER — so any match
 * here is unconditionally a bug to fix, not an ambiguous case needing human
 * review. (Contrast with auditAppointmentFollowUp.js's DIV_OTHER, which
 * genuinely can't be resolved from data alone and always needs a human.)
 *
 * ── What --apply does, per affected lead (mirrors routes/leads.js's own
 * terminal-lost transition handler exactly — never a second, divergent
 * mechanism) ────────────────────────────────────────────────────────────────
 *   1. One transaction: force-clear the whole follow-up (date/time/type/
 *      notes/status, via lib/followUp.js#normalizeFollowUp({})) if any
 *      follow-up field is set, then re-project reminder_leads
 *      (lib/reminderProjection.js#syncLeadToReminders) in the SAME tx.
 *   2. Post-commit (bookingService.cancelAppointment manages its own
 *      transaction, same as the live route): cancel every appointment still
 *      'scheduled'/'confirmed' for that lead through the ONE canonical
 *      cancellation path — never a raw status UPDATE. This writes the
 *      appointment_events audit row, enqueues the durable calendar-outbox
 *      cancellation (Google Calendar event + Driving/Travel Time removal),
 *      and re-projects reminder_leads again afterward.
 *   3. One activities audit note summarizing what changed.
 * A genuinely 'completed'/'no_show'/'cancelled'/'rescheduled' appointment is
 * NEVER selected or touched — no version bump, no calendar call, preserved
 * exactly as history (CLAUDE.md: never infer completion from a past start
 * time, only the row's own status decides).
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 * Re-running after a successful --apply finds nothing (the lead no longer
 * has an active appointment or a set follow-up), so a second run is a safe
 * no-op. A race with a concurrent cancellation (e.g. a human cancels the
 * same appointment between the report query and the apply step) surfaces as
 * bookingService's own 'not_cancellable' error, treated as benign here —
 * same as the live route's cancelActiveAppointmentsForClosedLost.
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
const bookingService = require('../lib/booking/bookingService');
const { normalizeFollowUp, FOLLOW_UP_FIELDS } = require('../lib/followUp');
const { syncLeadToReminders } = require('../lib/reminderProjection');
const { TERMINAL_LOST_STATUSES } = require('../lib/leadStatus');

const ACTOR_PREFIX = 'remediation:terminal-lost-appointments:';

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

const LEAD_WITH_OWNER_SQL = `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
   FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
   WHERE l.id = $1`;

async function projectReminders(client, leadId) {
  const lr = await client.query(LEAD_WITH_OWNER_SQL, [leadId]);
  if (lr.rows[0]) await syncLeadToReminders(client, lr.rows[0]);
}

// Finds every lead currently in a terminal-lost status that still has an
// active appointment and/or a set follow-up — the objective, deterministic
// definition of "affected by the bug" (see header comment).
async function findAffectedLeads(since) {
  const { rows } = await pool.query(
    `SELECT l.id, l.external_ref, l.first_name, l.last_name, l.status,
            l.follow_up_date, l.follow_up_time, l.follow_up_type, l.follow_up_notes, l.follow_up_status,
            l.created_at
       FROM leads l
      WHERE l.status = ANY($1::text[])
        AND ($2::date IS NULL OR l.created_at >= $2::date)
        AND (
          l.follow_up_date IS NOT NULL OR l.follow_up_type IS NOT NULL
          OR EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.status IN ('scheduled', 'confirmed'))
        )
      ORDER BY l.created_at DESC`,
    [TERMINAL_LOST_STATUSES, since || null]
  );
  return rows;
}

async function activeAppointmentsFor(leadId) {
  const { rows } = await pool.query(
    `SELECT id, start_at, status FROM appointments WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed') ORDER BY created_at`,
    [leadId]
  );
  return rows;
}

// Step 1: clear the follow-up (if set) + re-project reminders, one transaction.
async function clearFollowUp(leadId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fu = normalizeFollowUp({}).value;
    const sets = FOLLOW_UP_FIELDS.map((col, i) => `${col} = $${i + 2}`);
    await client.query(
      `UPDATE leads SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
      [leadId, ...FOLLOW_UP_FIELDS.map(col => fu[col])]
    );
    await projectReminders(client, leadId);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Step 2: cancel every still-active appointment through the one canonical path.
async function cancelActiveAppointments(leadId, actor) {
  const rows = await activeAppointmentsFor(leadId);
  const cancelled = [];
  const failures = [];
  for (const row of rows) {
    try {
      await bookingService.cancelAppointment(row.id, actor, { onWrite: (client) => projectReminders(client, leadId) });
      cancelled.push(row.id);
    } catch (e) {
      if (e && e.code === 'not_cancellable') continue; // already resolved concurrently — benign
      failures.push({ id: row.id, error: (e && e.message) || String(e) });
    }
  }
  return { cancelled, failures };
}

async function logRemediation(leadId, actor, clearedFollowUp, apptResult) {
  const parts = [];
  if (clearedFollowUp) parts.push('stale follow-up cleared');
  if (apptResult.cancelled.length) parts.push(`${apptResult.cancelled.length} active appointment(s) cancelled (Google Calendar event + travel block removal queued)`);
  if (apptResult.failures.length) parts.push(`${apptResult.failures.length} appointment(s) FAILED to cancel — needs manual review`);
  if (!parts.length) return;
  await pool.query(
    `INSERT INTO activities (lead_id, type, content, author, source) VALUES ($1, 'note', $2, $3, 'manual')`,
    [leadId, `Terminal-lost remediation: ${parts.join('; ')}.`, actor]
  );
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return '?'; } })();
  const apply = !!flag('apply');
  const since = flagVal('since');
  if (apply && flagVal('confirm-host') !== host) {
    console.error(`--apply requires --confirm-host=${host} (the DATABASE_URL host). Nothing changed.`);
    process.exit(2);
  }

  const runId = apply ? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) : null;
  const actor = runId ? ACTOR_PREFIX + runId : null;

  const leads = await findAffectedLeads(since);
  const report = {
    database_host: host, generated_at: new Date().toISOString(), since: since || null,
    mode: apply ? 'apply' : 'report-only', run_id: runId,
    affected_leads: leads.length, records: [],
  };

  for (const lead of leads) {
    const activeAppts = await activeAppointmentsFor(lead.id);
    const hasFollowUp = !!(lead.follow_up_date || lead.follow_up_type);
    const record = {
      lead_id: lead.id, external_ref: lead.external_ref,
      name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      status: lead.status, lead_created_at: lead.created_at,
      follow_up: hasFollowUp ? {
        date: lead.follow_up_date, time: lead.follow_up_time, type: lead.follow_up_type,
        notes: lead.follow_up_notes, status: lead.follow_up_status,
      } : null,
      active_appointments: activeAppts.map(a => ({ id: a.id, start_at: a.start_at, status: a.status })),
    };
    if (apply) {
      let clearedFollowUp = false;
      if (hasFollowUp) { await clearFollowUp(lead.id); clearedFollowUp = true; }
      const apptResult = await cancelActiveAppointments(lead.id, actor);
      await logRemediation(lead.id, actor, clearedFollowUp, apptResult);
      record.apply_result = { cleared_follow_up: clearedFollowUp, cancelled: apptResult.cancelled, failures: apptResult.failures };
    }
    report.records.push(record);
  }

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[remediate] db host=${host} mode=${report.mode} run=${runId || '-'} since=${since || 'all'}`);
    console.log(`[remediate] affected leads: ${report.affected_leads}`);
    if (apply) {
      const totalCancelled = report.records.reduce((n, r) => n + ((r.apply_result && r.apply_result.cancelled.length) || 0), 0);
      const totalFailed = report.records.reduce((n, r) => n + ((r.apply_result && r.apply_result.failures.length) || 0), 0);
      const totalFollowUpsCleared = report.records.filter(r => r.apply_result && r.apply_result.cleared_follow_up).length;
      console.log(`[remediate] appointments cancelled: ${totalCancelled}, follow-ups cleared: ${totalFollowUpsCleared}, cancel failures: ${totalFailed}`);
    } else {
      console.log('[remediate] report only — nothing changed. Re-run with --apply --confirm-host=' + host + ' to fix.');
    }
  }
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { findAffectedLeads, activeAppointmentsFor };
