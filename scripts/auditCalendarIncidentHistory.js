#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditCalendarIncidentHistory — PURE READ-ONLY historical forensics for the
 * Michelle missing-Google-Calendar-appointments incident (see
 * lib/booking/calendarOutbox.js's header "PERMANENT RULE" for the root cause
 * and PR #30/#31 for the fix). Unlike scripts/auditCalendarAttendeeOmissions.js
 * (which only looks at CURRENTLY ACTIVE appointments — by design, since only
 * an active appointment is something a corrective --apply could still fix),
 * this script has NO write capability of any kind: no --apply flag exists at
 * all. It exists purely to answer "what actually happened" across EVERY
 * appointment touched during the incident window, regardless of its current
 * status — including appointments that are now completed, cancelled,
 * rescheduled/superseded, or that were never synced to Google at all.
 *
 *   node scripts/auditCalendarIncidentHistory.js [--since=2026-10-16] [--until=2026-10-20] [--limit=500] [--json]
 *
 * ── What it reports ──────────────────────────────────────────────────────
 * 1. coverage: the TRUE total count of currently-active appointments (with
 *    and without a google_event_id) — so you can tell whether
 *    auditCalendarAttendeeOmissions.js --verify-live's own --limit (default
 *    200) actually covered everything, or needs re-running with a higher
 *    --limit to reach full coverage.
 * 2. window_appointments: every appointment CREATED or UPDATED in
 *    [since, until) — i.e. everything touched during the incident window —
 *    each classified into exactly one outcome:
 *      - 'active'                       — still scheduled/confirmed today
 *      - 'completed' / 'no_show'        — resolved normally, untouched by
 *                                          this incident
 *      - 'rescheduled_superseded'       — superseded by a later booking
 *                                          (the OLD row of a reschedule)
 *      - 'cancelled_terminal_lost'      — cancelled, AND its lead's status
 *                                          is in TERMINAL_LOST_STATUSES, AND
 *                                          a matching "Lead marked <status>"
 *                                          activity note exists at roughly
 *                                          the same time — i.e. a LEGITIMATE
 *                                          cancellation by the Closed-Lost/
 *                                          terminal-lost automation
 *                                          (lib/leadStatus.js), not a bug.
 *      - 'cancelled_needs_review'       — cancelled, but WITHOUT that
 *                                          terminal-lost signature. Could be
 *                                          a perfectly normal manual
 *                                          cancellation (e.g. the Appointment
 *                                          editor's own Cancel action) or
 *                                          something else — this script does
 *                                          not and cannot guess which; it
 *                                          only reports that the terminal-
 *                                          lost explanation does not apply,
 *                                          so a human should look at the
 *                                          attached appointment_events trail.
 *    Each record carries its full appointment_events audit trail (actor,
 *    action, timestamps) for transparency.
 * 3. attendee_history (THE KEY FORENSIC CHECK): for every window appointment
 *    that ever had a google_event_id, replays its FULL calendar_outbox
 *    create_main/update_main payload history in order and checks, for every
 *    currently-configured staff recipient, whether they were EVER present in
 *    an earlier payload and then ABSENT from a LATER one (before any
 *    cancellation) — concrete, timestamped proof of an unintended attendee
 *    removal, as distinct from a legitimate full-event cancellation (which
 *    is its own, separate classification above, not an "attendee removal").
 * 4. without_google_event_id: appointments (in the window, and currently
 *    active) that never got a google_event_id at all — a different gap
 *    class entirely (never synced, not "synced then had an attendee
 *    silently removed").
 *
 * ── Safety ───────────────────────────────────────────────────────────────
 * This script has ZERO write paths. It never calls the Google Calendar API
 * (so it cannot send an invitation, cancel, or update any live event), and
 * never issues an SQL statement other than SELECT. There is no --apply flag
 * to accidentally pass. It is safe to run against production at any time,
 * any number of times, with no side effects whatsoever.
 */
'use strict';

const { pool } = require('../db/client');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

// Replays ordered create_main/update_main outbox rows for ONE appointment and
// determines, per staff email, whether they were ever present then later
// absent from a payload BEFORE any cancellation — i.e. a genuine mid-flight
// attendee removal, never conflated with a full event cancellation (which
// has its own, separate classification).
function analyzeAttendeeHistory(outboxRowsAsc, staffEmails) {
  const mains = outboxRowsAsc.filter((r) => r.action === 'create_main' || r.action === 'update_main');
  const result = {};
  for (const email of staffEmails) {
    const lower = String(email).toLowerCase();
    let everPresent = false;
    let removedAt = null;
    let removedAtAction = null;
    for (const row of mains) {
      const attendees = (row.payload && Array.isArray(row.payload.attendees) ? row.payload.attendees : [])
        .map((a) => String(a.email).toLowerCase());
      const present = attendees.includes(lower);
      if (present) {
        everPresent = true;
      } else if (everPresent && !removedAt) {
        removedAt = row.created_at;
        removedAtAction = row.action;
      }
    }
    const last = mains[mains.length - 1];
    const currentlyPresent = last
      ? (last.payload && Array.isArray(last.payload.attendees) ? last.payload.attendees : [])
          .map((a) => String(a.email).toLowerCase()).includes(lower)
      : null;
    result[email] = { ever_present: everPresent, currently_present: currentlyPresent, unintended_removal: !!removedAt, removed_at: removedAt, removed_at_action: removedAtAction };
  }
  return result;
}

// Classifies one window appointment given its own row, its lead's CURRENT
// status, and whether a matching "Lead marked <status>" activity exists near
// its cancellation time — the one reliable signal that distinguishes the
// terminal-lost automation's OWN cancellation from any other cancellation
// path (bookingService.cancelAppointment's `actor` is always a human email
// either way, including for the terminal-lost auto-cancel — see
// routes/leads.js's cancelActiveAppointmentsForTerminalLost call sites — so
// actor alone can never distinguish them; the activity note can).
function classifyAppointment(appt, hasMatchingTerminalLostNote) {
  if (['scheduled', 'confirmed'].includes(appt.status)) return 'active';
  if (['completed', 'no_show'].includes(appt.status)) return appt.status;
  if (appt.status === 'rescheduled') return 'rescheduled_superseded';
  if (appt.status === 'cancelled') return hasMatchingTerminalLostNote ? 'cancelled_terminal_lost' : 'cancelled_needs_review';
  return appt.status;
}

async function buildReport(opts = {}) {
  const since = opts.since || '2026-10-16';
  const until = opts.until || '2026-10-20';
  const limit = opts.limit || 500;
  const staff = await require('../lib/notificationRecipients').getAllStaffRecipients();

  // 1. Coverage — the TRUE total so a --verify-live run's own --limit can be
  // judged against it rather than assumed sufficient.
  const coverageRow = (await pool.query(
    `SELECT
       count(*) FILTER (WHERE status IN ('scheduled','confirmed')) AS total_active,
       count(*) FILTER (WHERE status IN ('scheduled','confirmed') AND google_event_id IS NOT NULL) AS total_active_synced,
       count(*) FILTER (WHERE status IN ('scheduled','confirmed') AND google_event_id IS NULL) AS total_active_unsynced
     FROM appointments`
  )).rows[0];
  const coverage = {
    total_active: Number(coverageRow.total_active),
    total_active_synced: Number(coverageRow.total_active_synced),
    total_active_unsynced: Number(coverageRow.total_active_unsynced),
  };

  // 2. Every appointment touched (created or updated) during the window.
  const { rows: windowAppts } = await pool.query(
    `SELECT a.id AS appointment_id, a.lead_id, a.status, a.start_at, a.created_at, a.updated_at,
            a.google_event_id, a.google_travel_event_id, a.version,
            l.first_name, l.last_name, l.status AS lead_status
       FROM appointments a
       LEFT JOIN leads l ON l.id = a.lead_id
      WHERE (a.created_at >= $1::timestamptz AND a.created_at < $2::timestamptz)
         OR (a.updated_at >= $1::timestamptz AND a.updated_at < $2::timestamptz)
      ORDER BY a.updated_at DESC
      LIMIT $3`,
    [since, until, limit]
  );

  const { TERMINAL_LOST_STATUSES } = require('../lib/leadStatus');
  const records = [];
  const withoutGoogleEventId = [];

  for (const appt of windowAppts) {
    const events = (await pool.query(
      `SELECT actor, action, previous_values, new_values, created_at
         FROM appointment_events WHERE appointment_id = $1 ORDER BY created_at ASC`,
      [appt.appointment_id]
    )).rows;

    let hasMatchingTerminalLostNote = false;
    if (appt.status === 'cancelled' && appt.lead_id && TERMINAL_LOST_STATUSES.includes(appt.lead_status)) {
      const note = await pool.query(
        `SELECT 1 FROM activities
          WHERE lead_id = $1 AND content LIKE 'Lead marked%' AND content LIKE '%cancelled%'
            AND created_at BETWEEN $2::timestamptz - interval '10 minutes' AND $2::timestamptz + interval '10 minutes'
          LIMIT 1`,
        [appt.lead_id, appt.updated_at]
      );
      hasMatchingTerminalLostNote = note.rows.length > 0;
    }
    const classification = classifyAppointment(appt, hasMatchingTerminalLostNote);

    let attendeeHistory = null;
    if (appt.google_event_id || appt.status === 'rescheduled') {
      const outboxRows = (await pool.query(
        `SELECT action, payload, created_at FROM calendar_outbox WHERE appointment_id = $1 ORDER BY created_at ASC`,
        [appt.appointment_id]
      )).rows;
      attendeeHistory = analyzeAttendeeHistory(outboxRows, staff);
    } else {
      withoutGoogleEventId.push({
        appointment_id: appt.appointment_id, lead_id: appt.lead_id,
        name: `${appt.first_name || ''} ${appt.last_name || ''}`.trim(),
        status: appt.status, created_at: appt.created_at,
      });
    }

    records.push({
      appointment_id: appt.appointment_id,
      lead_id: appt.lead_id,
      name: `${appt.first_name || ''} ${appt.last_name || ''}`.trim(),
      lead_status: appt.lead_status,
      appointment_status: appt.status,
      classification,
      start_at: appt.start_at,
      created_at: appt.created_at,
      updated_at: appt.updated_at,
      google_event_id: appt.google_event_id,
      google_travel_event_id: appt.google_travel_event_id,
      version: appt.version,
      appointment_events: events,
      attendee_history: attendeeHistory,
    });
  }

  const unintendedRemovals = records.filter(
    (r) => r.attendee_history && Object.values(r.attendee_history).some((h) => h.unintended_removal)
  );

  return {
    generated_at: new Date().toISOString(),
    window: { since, until, limit },
    configured_staff_recipients: staff,
    coverage,
    window_appointment_count: records.length,
    classification_counts: records.reduce((acc, r) => { acc[r.classification] = (acc[r.classification] || 0) + 1; return acc; }, {}),
    unintended_attendee_removal_count: unintendedRemovals.length,
    without_google_event_id_count: withoutGoogleEventId.length,
    records,
    without_google_event_id: withoutGoogleEventId,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const since = flagVal('since') || undefined;
  const until = flagVal('until') || undefined;
  const limitVal = flagVal('limit');
  const limit = limitVal ? parseInt(limitVal, 10) : undefined;

  const report = await buildReport({ since, until, limit });

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[history] window ${report.window.since} .. ${report.window.until} (limit=${report.window.limit})`);
    console.log(`[history] configured staff recipients: ${report.configured_staff_recipients.join(', ')}`);
    console.log(`[history] TRUE current coverage: ${report.coverage.total_active} active appointments total (${report.coverage.total_active_synced} synced, ${report.coverage.total_active_unsynced} never synced)`);
    console.log(`[history] appointments touched in window: ${report.window_appointment_count}`);
    console.log('[history] by classification:', JSON.stringify(report.classification_counts));
    console.log(`[history] UNINTENDED ATTENDEE REMOVALS found: ${report.unintended_attendee_removal_count}`);
    console.log(`[history] appointments never synced to Google at all (window): ${report.without_google_event_id_count}`);
    if (report.unintended_attendee_removal_count) {
      console.log('[history] --- affected appointments (re-run with --json for full detail) ---');
      for (const r of report.records) {
        if (r.attendee_history && Object.values(r.attendee_history).some((h) => h.unintended_removal)) {
          console.log(`  ${r.appointment_id} (${r.name}, status=${r.appointment_status}): ${JSON.stringify(r.attendee_history)}`);
        }
      }
    }
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { buildReport, analyzeAttendeeHistory, classifyAppointment };
