#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditCalendarAttendeeOmissions — find (and, only with --apply, correct)
 * active appointments whose most recent Google Calendar main-event payload
 * is missing a currently-configured staff attendee.
 *
 * PRODUCTION INCIDENT this backfills for: Michelle (michelle@ecconstructiongroup.com)
 * reported appointments previously visible on her Google Calendar had
 * disappeared. Root cause: lib/booking/calendarOutbox.js's enqueueCreate/
 * enqueueUpdate (and lib/booking/followUpReminders.js's Meeting follow-up
 * representation) computed the calendar event's attendee list by filtering
 * through notificationPreferences.filterRecipientsForCategory() — the SAME
 * mechanism used to gate staff EMAILS — so the moment migration 2026-62
 * correctly disabled Michelle's 'appointment'/'follow_up' EMAIL categories,
 * she was ALSO silently dropped from the calendar invite attendee list for
 * every appointment created or updated afterward. Fixed in this same change
 * (see calendarOutbox.js's header "PERMANENT RULE"): calendar attendee
 * membership is now ALWAYS every configured staff recipient, unconditionally.
 *
 * That code fix only affects FUTURE create/update operations. This script
 * finds appointments whose LAST enqueued main-event payload (the one most
 * recently sent to Google) is missing a staff member who is a configured
 * recipient TODAY, and — only with --apply — re-enqueues a corrective
 * update through the exact same (now-fixed) canonical path, which sends
 * that staff member a fresh Google Calendar invite for the existing event.
 *
 * READ-ONLY BY DEFAULT.
 *
 *   node scripts/auditCalendarAttendeeOmissions.js [--json]
 *   node scripts/auditCalendarAttendeeOmissions.js --apply --confirm-host=<db host> [--json]
 *
 * ── Scope / safety ───────────────────────────────────────────────────────
 * Only ever touches an appointment that is STILL 'scheduled'/'confirmed' at
 * apply time (re-verified under FOR UPDATE immediately before mutating,
 * same discipline as scripts/auditPhoneCallCalendarArtifacts.js) — a
 * completed/cancelled/no_show/rescheduled appointment is never selected or
 * touched. Never deletes or cancels anything; only enqueues a corrective
 * 'update_main' (and, for a real Site Visit, 'update_travel') calendar_outbox
 * row through calendarOutbox.enqueueUpdate — the SAME canonical path every
 * live reschedule uses — which the already-running calendar-outbox worker
 * then processes on its normal cadence (never restarted or triggered by
 * this script). This is a correction, not a guess: the current attendee
 * list is recomputed via the exact same (now-fixed) buildOperation() every
 * live create/update call uses, so the corrected event is byte-identical to
 * what a live update would have produced today.
 *
 * Generalized beyond Michelle on purpose: it checks EVERY currently
 * configured staff recipient against each appointment's last-sent attendee
 * list, so it also catches the same class of omission for any other staff
 * member whose email-category preference was ever disabled while this bug
 * existed — not just the one person who happened to report it.
 */
'use strict';

const { pool } = require('../db/client');
const calendarOutbox = require('../lib/booking/calendarOutbox');
const { isPhoneCallAppointment } = require('../lib/booking/appointmentKind');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

const APPT_COLS = `a.id AS appointment_id, a.lead_id, a.owner_id, a.start_at, a.end_at, a.timezone,
       a.status, a.version, a.google_event_id, a.google_travel_event_id, a.idempotency_key,
       l.first_name, l.last_name, l.email, l.phone, l.property_address, l.city, l.project_type, l.follow_up_type,
       ow.email AS owner_email`;

async function findOmissions() {
  const staff = await require('../lib/notificationRecipients').getAllStaffRecipients();
  if (!staff.length) return { staff, omissions: [] };

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (o.appointment_id)
            o.appointment_id, o.payload, o.action, o.created_at AS last_outbox_at,
            ${APPT_COLS}
       FROM calendar_outbox o
       JOIN appointments a ON a.id = o.appointment_id
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN owners ow ON ow.id = a.owner_id
      WHERE o.action IN ('create_main', 'update_main')
        AND a.status IN ('scheduled', 'confirmed')
      ORDER BY o.appointment_id, o.created_at DESC`
  );

  const omissions = [];
  for (const row of rows) {
    const sentAttendees = new Set(
      (row.payload && Array.isArray(row.payload.attendees) ? row.payload.attendees : []).map((a) => String(a.email).toLowerCase())
    );
    const missing = staff.filter((s) => !sentAttendees.has(String(s).toLowerCase()));
    if (missing.length) {
      omissions.push({
        appointment_id: row.appointment_id,
        lead_id: row.lead_id,
        name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        start_at: row.start_at,
        status: row.status,
        version: row.version,
        last_outbox_action: row.action,
        last_outbox_at: row.last_outbox_at,
        missing_staff: missing,
      });
    }
  }
  return { staff, omissions };
}

async function applyCorrection(appointment_id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT ${APPT_COLS}
         FROM appointments a
         LEFT JOIN leads l ON l.id = a.lead_id
         LEFT JOIN owners ow ON ow.id = a.owner_id
        WHERE a.id = $1 FOR UPDATE OF a`,
      [appointment_id]
    );
    const row = rows[0];
    if (!row || !['scheduled', 'confirmed'].includes(row.status)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no_longer_active' };
    }
    const newVersion = (row.version || 1) + 1;
    await client.query(
      `UPDATE appointments SET version = $1, calendar_sync_status = 'pending', updated_at = NOW() WHERE id = $2`,
      [newVersion, appointment_id]
    );
    const lead = {
      first_name: row.first_name, last_name: row.last_name, email: row.email, phone: row.phone,
      property_address: row.property_address, city: row.city, project_type: row.project_type,
      follow_up_type: row.follow_up_type,
    };
    const fullAppt = {
      id: row.appointment_id, lead_id: row.lead_id, owner_id: row.owner_id,
      start_at: row.start_at, end_at: row.end_at, timezone: row.timezone,
      version: newVersion, google_event_id: row.google_event_id, google_travel_event_id: row.google_travel_event_id,
      idempotency_key: row.idempotency_key,
    };
    await calendarOutbox.enqueueUpdate(client, fullAppt, lead, row.owner_email, newVersion, isPhoneCallAppointment(fullAppt));
    await client.query('COMMIT');
    return { ok: true, new_version: newVersion };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    return { ok: false, reason: 'error', error: e.message };
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return '?'; } })();
  const apply = !!flag('apply');
  if (apply && flagVal('confirm-host') !== host) {
    console.error(`--apply requires --confirm-host=${host} (the DATABASE_URL host). Nothing changed.`);
    process.exit(2);
  }

  const { staff, omissions } = await findOmissions();
  const report = {
    database_host: host, generated_at: new Date().toISOString(), mode: apply ? 'apply' : 'report-only',
    configured_staff_recipients: staff, omission_count: omissions.length, records: omissions,
  };

  if (apply) {
    for (const o of omissions) {
      o.apply_result = await applyCorrection(o.appointment_id);
    }
  }

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[audit] db host=${host} mode=${report.mode}`);
    console.log(`[audit] configured staff recipients: ${staff.join(', ') || '(none)'}`);
    console.log(`[audit] appointments with a missing staff attendee: ${omissions.length}`);
    if (apply) {
      const corrected = omissions.filter((o) => o.apply_result.ok).length;
      const failed = omissions.length - corrected;
      console.log(`[audit] corrective update enqueued: ${corrected}, failed/skipped: ${failed}`);
    } else if (omissions.length) {
      console.log('[audit] report only — nothing changed. Re-run with --apply --confirm-host=' + host + ' to send corrective updates.');
    }
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { findOmissions, applyCorrection };
