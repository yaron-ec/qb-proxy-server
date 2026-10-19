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
 * That code fix only affects FUTURE create/update operations. The DEFAULT
 * (DB-only) mode finds appointments whose LAST enqueued main-event payload
 * (the one most recently sent to Google) is missing a staff member who is a
 * configured recipient TODAY, and — only with --apply — re-enqueues a
 * corrective update through the exact same (now-fixed) canonical path.
 *
 * ── IMPORTANT LIMITATION OF THE DEFAULT MODE (found after a production run
 * reported 0 omissions while the incident was still visibly ongoing) ───────
 * The default mode only inspects calendar_outbox.payload — the request body
 * WE most recently queued to send. An empty result proves only that the
 * last row we WROTE TO OUR OWN DATABASE for every active appointment lists
 * every configured staff member. It does NOT prove: (a) that row was ever
 * successfully DELIVERED to Google (the row could still be 'pending',
 * 'failed', or 'dead' — this mode never checks calendar_outbox.status), or
 * (b) that Google's actual live event currently reflects that attendee
 * list (our own write and Google's resulting state can diverge). Use
 * --verify-live (below) to check REAL ground truth instead of inferring it
 * from our own write history.
 *
 * READ-ONLY BY DEFAULT.
 *
 *   node scripts/auditCalendarAttendeeOmissions.js [--json]
 *   node scripts/auditCalendarAttendeeOmissions.js --verify-live [--limit=N] [--json]
 *   node scripts/auditCalendarAttendeeOmissions.js --apply --confirm-host=<db host> [--json]
 *
 * ── --verify-live (NEW — ground-truth check, GET-only, zero writes) ────────
 * For every active (scheduled/confirmed) appointment with a google_event_id,
 * calls the live Google Calendar API (googleCalendarClient.getEvent — the
 * same function reconcileSyncedAppointments already uses to detect missing
 * events) and compares Google's ACTUAL CURRENT attendees list against every
 * configured staff recipient, independent of what our own database claims
 * was sent. Reports, per appointment: whether the event still exists at all
 * on Google's side, which configured staff members are missing from its
 * live attendee list, and the DB's own last-known outbox row status for
 * cross-reference. This makes no writes of any kind — it is a read-only
 * diagnostic — so it needs no --confirm-host. Requires
 * GOOGLE_SERVICE_ACCOUNT_KEY (the same credential every other live Calendar
 * call in this codebase uses) and makes one Google API call per appointment
 * checked (rate-limited, same 200ms-between-calls discipline as
 * reconcileSyncedAppointments) — pass --limit=N to cap how many are checked
 * in one run (default 200).
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

// Ground-truth check against Google's live Calendar API — never trusts our
// own database's record of what we intended to send. Read-only: calls only
// googleCalendarClient.getEvent (a GET), never create/update/cancel.
async function verifyLiveAttendees(opts = {}) {
  const staff = await require('../lib/notificationRecipients').getAllStaffRecipients();
  if (!staff.length) return { staff, checked: 0, records: [] };

  const limit = opts.limit || 200;
  const delayMs = opts.delayMs != null ? opts.delayMs : 200;
  const googleCalendarClient = require('../lib/booking/googleCalendarClient');
  const calId = calendarOutbox.CALENDAR_ID;
  const subEmail = (calId && calId.includes('@')) ? calId : await calendarOutbox.dwdSubjectFallback();

  const { rows } = await pool.query(
    `SELECT a.id AS appointment_id, a.lead_id, a.start_at, a.google_event_id,
            l.first_name, l.last_name,
            (SELECT status FROM calendar_outbox o WHERE o.appointment_id = a.id AND o.action IN ('create_main', 'update_main')
               ORDER BY o.created_at DESC LIMIT 1) AS last_outbox_status,
            (SELECT created_at FROM calendar_outbox o WHERE o.appointment_id = a.id AND o.action IN ('create_main', 'update_main')
               ORDER BY o.created_at DESC LIMIT 1) AS last_outbox_at
       FROM appointments a
       LEFT JOIN leads l ON l.id = a.lead_id
      WHERE a.status IN ('scheduled', 'confirmed') AND a.google_event_id IS NOT NULL
      ORDER BY a.start_at ASC
      LIMIT $1`,
    [limit]
  );

  const records = [];
  let checked = 0;
  for (const row of rows) {
    checked++;
    const record = {
      appointment_id: row.appointment_id, lead_id: row.lead_id,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
      start_at: row.start_at,
      last_outbox_status: row.last_outbox_status,
      last_outbox_at: row.last_outbox_at,
    };
    try {
      const token = await googleCalendarClient.getAccessToken(subEmail);
      const result = await googleCalendarClient.getEvent(token, calId, row.google_event_id);
      if (!result.exists) {
        record.live_status = 'event_missing';
        record.live_missing_staff = staff;
      } else {
        const liveAttendeeEmails = (result.event.attendees || []).map((a) => String(a.email).toLowerCase());
        const missing = staff.filter((s) => !liveAttendeeEmails.includes(String(s).toLowerCase()));
        record.live_status = missing.length ? 'attendee_missing' : 'ok';
        record.live_attendees = (result.event.attendees || []).map((a) => ({ email: a.email, responseStatus: a.responseStatus || null }));
        record.live_missing_staff = missing;
      }
    } catch (e) {
      // API failure (5xx, quota, network) is NOT proof of anything — report
      // it distinctly rather than conflating it with a real omission.
      record.live_status = 'check_failed';
      record.live_error = e.message;
    }
    if (record.live_status !== 'ok') records.push(record);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { staff, checked, records };
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

  const verifyLive = !!flag('verify-live');
  if (verifyLive) {
    const limitVal = flagVal('limit');
    const limit = limitVal ? parseInt(limitVal, 10) : undefined;
    report.live_verification = await verifyLiveAttendees({ limit });
  }

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
    console.log(`[audit] (DB-only) appointments with a missing staff attendee in our last-sent payload: ${omissions.length}`);
    if (verifyLive) {
      const lv = report.live_verification;
      const missingLive = lv.records.filter((r) => r.live_status === 'attendee_missing').length;
      const eventMissing = lv.records.filter((r) => r.live_status === 'event_missing').length;
      const checkFailed = lv.records.filter((r) => r.live_status === 'check_failed').length;
      console.log(`[audit] (LIVE, ground truth) checked ${lv.checked} active appointments against Google directly:`);
      console.log(`[audit]   live attendee list missing a staff member: ${missingLive}`);
      console.log(`[audit]   event no longer exists on Google at all: ${eventMissing}`);
      console.log(`[audit]   live check failed (API error, not proof of either): ${checkFailed}`);
    }
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

module.exports = { findOmissions, applyCorrection, verifyLiveAttendees };
