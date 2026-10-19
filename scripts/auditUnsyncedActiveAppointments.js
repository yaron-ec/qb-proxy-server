#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditUnsyncedActiveAppointments — PURE READ-ONLY breakdown of what
 * scripts/auditCalendarIncidentHistory.js's `coverage.total_active_unsynced`
 * actually contains (production run: total_active=879, total_active_synced=574,
 * total_active_unsynced=305). That number alone cannot tell you whether it is
 * expected, historical debt, or an active ongoing failure — this script
 * answers that by classifying EVERY currently-active, google_event_id-less
 * appointment into one of a small number of known, mutually exclusive buckets:
 *
 *   - legacy_phone_call   — lib/booking/appointmentKind.js#isPhoneCallAppointment
 *                           is true. By design (lib/booking/calendarOutbox.js's
 *                           enqueueCreate/enqueueUpdate both return BEFORE ever
 *                           inserting a calendar_outbox row for these), a legacy
 *                           unbuffered Phone Call appointment row NEVER gets a
 *                           main event or a google_event_id — this is expected,
 *                           permanent, working-as-intended behavior, not a sync
 *                           gap of any kind. See CLAUDE.md "A Phone Call is
 *                           never an appointment."
 *   - meeting / never_enqueued   — a real Meeting/Site-Visit appointment with
 *                           ZERO calendar_outbox rows ever (no create_main or
 *                           update_main attempt on record at all). Its own
 *                           appointments.calendar_sync_status is virtually
 *                           always still the INSERT-time default 'pending' in
 *                           this case — but 'pending' alone is ambiguous (see
 *                           below), so this script checks calendar_outbox
 *                           directly rather than trusting that column alone.
 *                           Most likely explanations: created while the
 *                           google_calendar module was disabled for this
 *                           installation (enqueueCreate's own early-return
 *                           gate), or a row old enough to predate the outbox
 *                           system. Worth checking created_at age.
 *   - meeting / queued_not_yet_processed — HAS a calendar_outbox create_main/
 *                           update_main row whose own `status` is still
 *                           'pending' or 'processing' — the worker has not
 *                           finished with it yet. Expected to be near-zero
 *                           except for a very recent appointment (the worker
 *                           polls continuously) — a non-trivial count here on
 *                           anything older than a few minutes suggests the
 *                           worker itself is stalled, not an attendee problem.
 *   - meeting / retrying  — appointments.calendar_sync_status = 'retrying':
 *                           a genuine, currently-failing sync attempt that has
 *                           not yet exhausted calendar_outbox.max_attempts.
 *                           ACTIONABLE — this appointment's Google event may
 *                           not exist or be out of date for anyone, Michelle
 *                           included.
 *   - meeting / failed    — appointments.calendar_sync_status = 'failed': the
 *                           outbox row is dead-lettered (attempts exhausted).
 *                           ACTIONABLE — will never self-heal without manual
 *                           intervention.
 *   - meeting / synced_anomaly — calendar_sync_status = 'synced' but
 *                           google_event_id is somehow still NULL. Should be
 *                           impossible (writeGoogleEventId sets both together)
 *                           — flagged distinctly so it is never silently
 *                           folded into "normal" counts.
 *
 * Also reports, independent of the above per-appointment classification:
 *   - age_buckets: created_at age distribution of the unsynced set, to show
 *     whether this is old accumulated debt or recent/ongoing.
 *   - outbox_status_counts_global: a straight count of EVERY calendar_outbox
 *     row by status (pending/processing/failed/dead/synced), covering ALL
 *     appointments (not just the unsynced-active set) — the worker-processing
 *     visibility that scripts/auditCalendarIncidentHistory.js does not surface
 *     at all.
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 * Zero write paths. No --apply flag exists. Issues only SELECT statements.
 * Never calls the Google Calendar API. Safe to run against production at any
 * time, any number of times, with no side effects whatsoever.
 *
 *   node scripts/auditUnsyncedActiveAppointments.js [--limit=2000] [--json]
 */
'use strict';

const { pool } = require('../db/client');
const { isPhoneCallAppointment } = require('../lib/booking/appointmentKind');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

function ageBucket(createdAt, now) {
  const days = (now.getTime() - new Date(createdAt).getTime()) / 86400000;
  if (days < 7) return 'under_7d';
  if (days < 30) return 'd7_30';
  if (days < 90) return 'd30_90';
  return 'over_90d';
}

// Classifies ONE unsynced-active appointment given its own row and whether it
// has any create_main/update_main calendar_outbox history at all. Pure
// function (no I/O) for unit testing.
function classifyUnsyncedAppointment(appt, hasMainOutboxHistory) {
  if (isPhoneCallAppointment(appt)) {
    return { kind: 'legacy_phone_call', reason: 'never_queued_by_design' };
  }
  if (!hasMainOutboxHistory) {
    return { kind: 'meeting', reason: 'never_enqueued' };
  }
  const status = appt.calendar_sync_status;
  if (status === 'pending' || status === 'processing') {
    return { kind: 'meeting', reason: 'queued_not_yet_processed' };
  }
  if (status === 'retrying') return { kind: 'meeting', reason: 'retrying' };
  if (status === 'failed') return { kind: 'meeting', reason: 'failed' };
  if (status === 'synced') return { kind: 'meeting', reason: 'synced_anomaly' };
  return { kind: 'meeting', reason: `unknown_status:${status}` };
}

async function buildReport(opts = {}) {
  const limit = opts.limit || 2000;
  const now = opts.now ? new Date(opts.now) : new Date();

  const { rows: appts } = await pool.query(
    `SELECT a.id AS appointment_id, a.lead_id, a.status, a.busy_range, a.start_at, a.created_at,
            a.calendar_sync_status, a.calendar_last_error, a.google_event_id,
            l.first_name, l.last_name
       FROM appointments a
       LEFT JOIN leads l ON l.id = a.lead_id
      WHERE a.status IN ('scheduled', 'confirmed') AND a.google_event_id IS NULL
      ORDER BY a.created_at ASC
      LIMIT $1`,
    [limit]
  );

  const byKind = { legacy_phone_call: 0, meeting: 0 };
  const meetingBreakdown = { never_enqueued: 0, queued_not_yet_processed: 0, retrying: 0, failed: 0, synced_anomaly: 0, other: 0 };
  const ageBuckets = { under_7d: 0, d7_30: 0, d30_90: 0, over_90d: 0 };
  const needsReview = [];

  for (const appt of appts) {
    const historyRow = await pool.query(
      `SELECT 1 FROM calendar_outbox WHERE appointment_id = $1 AND action IN ('create_main', 'update_main') LIMIT 1`,
      [appt.appointment_id]
    );
    const hasMainOutboxHistory = historyRow.rows.length > 0;
    const { kind, reason } = classifyUnsyncedAppointment(appt, hasMainOutboxHistory);
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (kind === 'meeting') {
      meetingBreakdown[reason] = (meetingBreakdown[reason] || 0) + 1;
      ageBuckets[ageBucket(appt.created_at, now)] += 1;
      if (['retrying', 'failed', 'synced_anomaly'].includes(reason) || (reason === 'never_enqueued' && ageBucket(appt.created_at, now) === 'under_7d')) {
        needsReview.push({
          appointment_id: appt.appointment_id,
          lead_id: appt.lead_id,
          name: `${appt.first_name || ''} ${appt.last_name || ''}`.trim(),
          reason,
          calendar_sync_status: appt.calendar_sync_status,
          calendar_last_error: appt.calendar_last_error,
          created_at: appt.created_at,
          start_at: appt.start_at,
        });
      }
    }
  }

  const { rows: globalStatusRows } = await pool.query(
    `SELECT status, count(*)::int AS count FROM calendar_outbox GROUP BY status`
  );
  const outboxStatusCountsGlobal = globalStatusRows.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {});

  return {
    generated_at: now.toISOString(),
    total_unsynced_active_examined: appts.length,
    by_kind: byKind,
    meeting_breakdown: meetingBreakdown,
    age_buckets: ageBuckets,
    outbox_status_counts_global: outboxStatusCountsGlobal,
    needs_review: needsReview,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const limitVal = flagVal('limit');
  const limit = limitVal ? parseInt(limitVal, 10) : undefined;
  const report = await buildReport({ limit });

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[unsynced] examined ${report.total_unsynced_active_examined} active appointments with no google_event_id`);
    console.log('[unsynced] by kind:', JSON.stringify(report.by_kind));
    console.log('[unsynced] meeting breakdown:', JSON.stringify(report.meeting_breakdown));
    console.log('[unsynced] age buckets:', JSON.stringify(report.age_buckets));
    console.log('[unsynced] global calendar_outbox status counts (ALL rows):', JSON.stringify(report.outbox_status_counts_global));
    console.log(`[unsynced] records flagged for human review: ${report.needs_review.length}`);
    for (const r of report.needs_review) {
      console.log(`  ${r.appointment_id} (${r.name}): reason=${r.reason} sync_status=${r.calendar_sync_status} created_at=${r.created_at}`);
    }
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildReport, classifyUnsyncedAppointment, ageBucket };
