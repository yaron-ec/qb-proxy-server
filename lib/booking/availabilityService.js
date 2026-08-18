/* eslint-disable no-undef */
/**
 * availabilityService — daily availability combining the canonical
 * appointments table AND real Google Calendar events for the owner calendar.
 *
 * Two sources merged into ONE canonical blocked result:
 *   1. Railway/Postgres appointments (appointments.busy_range, already buffered
 *      [start-60m, end+60m] at insert time) → source "crm".
 *   2. Real Google Calendar events (GOOGLE_CALENDAR_ID, default 'primary') →
 *      buffered [eventStart-60m, eventEnd+60m] → source "google".
 *
 * Buffer rule (identical for both sources): each busy window already carries
 * the 1hr-before + duration + 1hr-after protected window. A candidate slot is
 * the ACTUAL meeting [slot, slot+duration] (NOT buffered again) and is blocked
 * iff it strictly overlaps any busy window. Touching at a point is NOT a
 * conflict. Pure slot logic lives in ./slotBlocking (unchanged, unit-tested).
 *
 * Dedup: a CRM appointment that also exists as a Google event collapses into a
 * single merged window tagged with both sources — no double-buffer.
 *
 * Google failure is NEVER silently reported as free: getAvailability throws a
 * CalendarUnavailableError so the public route returns 503 (reps cannot book
 * into an unknown calendar state).
 *
 * Reminders are unaffected — they use the real appointment start_at only; this
 * buffer logic is read-only availability and never shifts stored times.
 */
'use strict';

const { query } = require('../../db/client');
const { getType, resolveDuration } = require('./appointmentTypes');
const { computeBlockedSlots, SLOTS, toUtcIso, DEFAULT_TZ } = require('./slotBlocking');
const { getGoogleBusyWindows } = require('./googleAvailability');
const { mergeWindows, CalendarUnavailableError, combineBusyWindows } = require('./windowMerge');

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

function dateBoundsUtc(date, tz) {
  const zone = tz || DEFAULT_TZ;
  const timeMin = toUtcIso(date, '00:00', zone);
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const timeMax = toUtcIso(next.toISOString().slice(0, 10), '00:00', zone);
  return { timeMin, timeMax };
}

async function getAvailability({ owner_id, date, timezone, appointment_type_id, duration_minutes }) {
  const tz = timezone || DEFAULT_TZ;
  const { timeMin, timeMax } = dateBoundsUtc(date, tz);

  const r = await query(
    `SELECT id, start_at, end_at, timezone,
            lower(busy_range) AS busy_start,
            upper(busy_range) AS busy_end
     FROM appointments
     WHERE owner_id = $1
       AND status IN ('scheduled','confirmed')
       AND start_at >= $2 AND start_at < $3`,
    [owner_id, timeMin, timeMax]
  );

  const crmWindows = r.rows.map(a => ({
    start: new Date(a.busy_start).toISOString(),
    end: new Date(a.busy_end).toISOString(),
    source: 'crm',
    appointment_id: a.id,
  }));

  let googleResult;
  try {
    const googleWindows = await getGoogleBusyWindows({
      calendarId: CALENDAR_ID,
      date,
      timezone: tz
    });
    googleResult = { windows: googleWindows };
  } catch (e) {
    googleResult = { error: e };
  }

  const busyWindows = combineBusyWindows(crmWindows, googleResult);

  let duration = 60;
  if (duration_minutes != null) {
    duration = Number(duration_minutes);
  } else if (appointment_type_id) {
    const t = await getType(appointment_type_id);
    if (t) duration = resolveDuration(t, null);
  }

  const blocked = computeBlockedSlots(SLOTS, date, tz, duration, busyWindows);

  return {
    date,
    timezone: tz,
    duration_minutes: duration,
    blocked_slots: blocked,
    busy_windows: busyWindows,
  };
}

module.exports = {
  getAvailability, computeBlockedSlots, SLOTS, dateBoundsUtc, toUtcIso, DEFAULT_TZ,
  CalendarUnavailableError, mergeWindows,
};