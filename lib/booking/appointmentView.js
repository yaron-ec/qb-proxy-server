/* eslint-disable no-undef */
/**
 * appointmentView — the ONE read-side interpretation of a canonical appointment.
 *
 * Domain model (authoritative):
 *   APPOINTMENT  = the lead's active row in `appointments` (status scheduled |
 *                  confirmed). It is the ONLY source of truth for the site
 *                  visit / scheduled customer engagement: its date/time, kind,
 *                  availability blocking, Google Calendar event and customer
 *                  reminders all derive from this row. The `leads` table holds
 *                  NO copy of it.
 *   FOLLOW-UP    = leads.follow_up_date / follow_up_time / follow_up_type /
 *                  follow_up_notes / follow_up_status — the internal next
 *                  update. It never creates, moves or cancels an appointment,
 *                  never blocks availability and never touches Google Calendar.
 *   MEETING      = display wording for an appointment of kind 'Meeting'
 *                  (vs 'Phone Call'). Every "Meeting …" line shown for a lead
 *                  is rendered from the appointment, never from the follow-up.
 *
 * Appointment kind is derived from the row itself — busy_range is written by
 * bookingService with a 1h travel buffer on both sides for Meetings and no
 * buffer for Phone Calls — so kind can never disagree with the blocking that
 * was actually reserved.
 */
'use strict';

const { isoToLaParts } = require('./calendarOutbox');
const { parseRangeLower, appointmentKind, isPhoneCallAppointment } = require('./appointmentKind');

const ACTIVE_STATUSES = ['scheduled', 'confirmed'];

// UI-facing calendar state. 'retrying' is a transient failure that the worker
// will retry; 'failed' is terminal (dead-lettered) and needs a manual re-sync.
function calendarState(appt) {
  if (!appt) return null;
  const s = appt.calendar_sync_status || 'pending';
  if (s === 'synced' && appt.google_event_id) return 'synced';
  if (s === 'failed' || s === 'error') return 'failed';
  if (s === 'retrying') return 'retrying';
  return 'pending';
}

function serializeAppointment(appt) {
  if (!appt) return null;
  const tz = appt.timezone || 'America/Los_Angeles';
  const start = isoToLaParts(appt.start_at, tz);
  const end = appt.end_at ? isoToLaParts(appt.end_at, tz) : null;
  const durationMin = appt.end_at
    ? Math.round((new Date(appt.end_at) - new Date(appt.start_at)) / 60000) : null;
  return {
    id: appt.id,
    date: start.date,
    time: start.hhmmColon,
    end_time: end ? end.hhmmColon : null,
    start_at: new Date(appt.start_at).toISOString(),
    end_at: appt.end_at ? new Date(appt.end_at).toISOString() : null,
    duration_minutes: durationMin,
    timezone: tz,
    kind: appointmentKind(appt),
    status: appt.status,
    calendar_sync_status: calendarState(appt),
    calendar_last_error: appt.calendar_last_error || null,
    calendar_synced_at: appt.calendar_synced_at || null,
    google_event_id: appt.google_event_id || null,
  };
}

/** Pacific-local {date, time, kind} of a lead's active appointment, or nulls. */
function appointmentLocalFields(appt) {
  const s = serializeAppointment(appt);
  return {
    appointment_date: s ? s.date : null,
    appointment_time: s ? s.time : null,
    appointment_type: s ? s.kind : null,
  };
}

async function fetchActiveAppointment(db, leadId) {
  const { rows } = await db.query(
    `SELECT * FROM appointments
      WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed')
      ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  );
  return rows[0] || null;
}

/** Map<lead_id, active appointment row> for a batch of leads (one query). */
async function fetchActiveAppointmentsForLeads(db, leadIds) {
  const map = new Map();
  const ids = (leadIds || []).filter(Boolean);
  if (!ids.length) return map;
  const { rows } = await db.query(
    `SELECT DISTINCT ON (lead_id) * FROM appointments
      WHERE lead_id = ANY($1::uuid[]) AND status IN ('scheduled', 'confirmed')
      ORDER BY lead_id, created_at DESC`,
    [ids]
  );
  for (const r of rows) map.set(String(r.lead_id), r);
  return map;
}

module.exports = {
  ACTIVE_STATUSES,
  appointmentKind, isPhoneCallAppointment, calendarState,
  serializeAppointment, appointmentLocalFields,
  fetchActiveAppointment, fetchActiveAppointmentsForLeads,
  parseRangeLower,
};
