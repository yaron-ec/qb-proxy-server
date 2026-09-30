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
const { computeBlockedSlots, SLOTS, toUtcIso, DEFAULT_TZ, computeSlots } = require('./slotBlocking');

// The installation's configured business-hours slot grid (company_settings.
// business_hours — PRODUCTIZATION PHASE 2: { start: "HH:MM", end: "HH:MM" }).
// Falls back to the product default SLOTS grid (08:30–18:30, EC's exact
// historical behavior) when unconfigured or malformed — never throws, never
// silently narrows a company's real bookable hours from a bad config value.
async function getEffectiveSlots() {
  const cfg = await require('../companyConfig').getCompanyConfig();
  const bh = cfg.business_hours;
  if (bh && typeof bh.start === 'string' && typeof bh.end === 'string' && /^\d{2}:\d{2}$/.test(bh.start) && /^\d{2}:\d{2}$/.test(bh.end)) {
    return computeSlots(bh.start, bh.end);
  }
  return SLOTS;
}
const { getGoogleBusyWindows } = require('./googleAvailability');
const { mergeWindows, CalendarUnavailableError, combineBusyWindows } = require('./windowMerge');

// Reuse the exact same calendar id the calendar outbox writes to.
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

function dateBoundsUtc(date, tz) {
  const zone = tz || DEFAULT_TZ;
  const timeMin = toUtcIso(date, '00:00', zone);
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const timeMax = toUtcIso(next.toISOString().slice(0, 10), '00:00', zone);
  return { timeMin, timeMax };
}

// Pre-transaction Google Calendar conflict check for the booking WRITE path
// (lib/booking/bookingService.js) — NEVER call inside a DB transaction, this
// does real network I/O. Checks the candidate's ACTUAL, unbuffered [start,
// end] meeting window against real Google Calendar events for the shared
// calendar, buffered the same 1hr-before/after way as the CRM appointments
// table, so a slot already taken by a manually-added Google event (no CRM
// appointment row) is rejected the same way the availability DISPLAY already
// shows it (getAvailability merges CRM + Google). If Google can't be read,
// this resolves to no conflict (non-blocking) rather than failing the whole
// booking closed — the availability DISPLAY already fails closed (503) when
// Google is unreachable, so a user can never reach submit with stale/unknown
// Google state in the first place; the CRM check remains authoritative.
// Legacy Phone Call appointment rows (pre-rule, unbuffered busy_range) may
// still have a Google event synced BEFORE the ec_appointment_kind marker
// existed. Those events carry ec_appointment_id: look the row up and drop the
// window when the row is Phone-Call-shaped (any status) — deterministic, by the
// row itself, never by title. Genuine external events have no
// ec_appointment_id and are untouched.
async function dropLegacyPhoneCallWindows(windows) {
  const ids = [...new Set(windows.map((w) => w.ec_appointment_id).filter(Boolean))];
  if (!ids.length) return windows;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const valid = ids.filter((id) => uuid.test(id));
  if (!valid.length) return windows;
  const r = await query(
    'SELECT id FROM appointments WHERE id = ANY($1::uuid[]) AND lower(busy_range) >= start_at', [valid]);
  const phoneCallIds = new Set(r.rows.map((x) => String(x.id)));
  return windows.filter((w) => !(w.ec_appointment_id && phoneCallIds.has(String(w.ec_appointment_id))));
}

async function getGoogleConflictWindows({ start, end, timezone }) {
  // PRODUCTIZATION: never attempt the call at all when this installation
  // doesn't use Google Calendar — not just "fail open if it errors".
  if (!(await require('../companyConfig').isModuleEnabled('google_calendar'))) return [];
  const tz = timezone || DEFAULT_TZ;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(start);
  try {
    const windows = await dropLegacyPhoneCallWindows(await getGoogleBusyWindows({ calendarId: CALENDAR_ID, date, timezone: tz }));
    return windows.filter(w => new Date(start) < new Date(w.end) && new Date(end) > new Date(w.start));
  } catch (e) {
    console.warn('[booking] Google conflict pre-check failed (non-blocking, CRM check remains authoritative):', e.message);
    return [];
  }
}

async function getAvailability({ owner_id, date, timezone, appointment_type_id, duration_minutes, exclude_appointment_id }) {
  const tz = timezone || DEFAULT_TZ;
  const { timeMin, timeMax } = dateBoundsUtc(date, tz);

  // 1. Canonical Railway/Postgres appointments (busy_range already buffered).
  //    exclude_appointment_id excludes the appointment being edited/rescheduled
  //    from its own conflict set (self-conflict), matching the write path's
  //    excludeAppointmentId in lib/booking/appointmentWriter.js.
  //
  //    PHONE CALLS NEVER BLOCK: a Phone Call is a reminder/activity, not an
  //    Appointment/Site Visit — it must never make a slot unavailable, and a
  //    real Appointment may freely overlap one. lower(busy_range) < start_at
  //    is the canonical, deterministic kind distinction (see
  //    lib/booking/appointmentKind.js#appointmentKind, the same rule the rest
  //    of the codebase already uses): a Meeting's busy_range always starts
  //    exactly 1h before start_at; a Phone Call's busy_range starts exactly
  //    AT start_at (bookingService.js's busyWindow — skipTravel skips the
  //    buffer). Excluding non-strictly-less rows here excludes Phone Calls
  //    from ever contributing a busy window.
  const r = await query(
    `SELECT id, start_at, end_at, timezone,
            lower(busy_range) AS busy_start,
            upper(busy_range) AS busy_end
     FROM appointments
     WHERE owner_id = $1
       AND status IN ('scheduled','confirmed')
       AND start_at >= $2 AND start_at < $3
       AND ($4::uuid IS NULL OR id != $4::uuid)
       AND lower(busy_range) < start_at`,
    [owner_id, timeMin, timeMax, exclude_appointment_id || null]
  );
  const crmWindows = r.rows.map(a => ({
    start: new Date(a.busy_start).toISOString(),
    end: new Date(a.busy_end).toISOString(),
    source: 'crm',
    appointment_id: a.id,
  }));

  // 2. Real Google Calendar events for the owner calendar (buffered).
  //    Fail-closed: a Google read error is captured here and converted to a
  //    typed CalendarUnavailableError by combineBusyWindows (never all-open)
  //    — but ONLY when this installation actually uses Google Calendar.
  //    PRODUCTIZATION: an installation with google_calendar disabled (never
  //    configured GOOGLE_SERVICE_ACCOUNT_KEY, never intends to use it) is a
  //    fundamentally different case from "Google is temporarily unreachable"
  //    — treating both the same way previously meant a company that simply
  //    doesn't use Google Calendar got a permanent 503 on every availability
  //    check, breaking booking entirely. "Disabled" -> proceed CRM-only, zero
  //    external windows. "Enabled but the read failed" -> unchanged fail-closed
  //    behavior (EC's exact historical guarantee, preserved).
  const googleCalendarEnabled = await require('../companyConfig').isModuleEnabled('google_calendar');
  let googleResult;
  if (!googleCalendarEnabled) {
    googleResult = { windows: [] };
  } else {
    try {
      const googleWindows = await dropLegacyPhoneCallWindows(await getGoogleBusyWindows({ calendarId: CALENDAR_ID, date, timezone: tz }));
      googleResult = { windows: googleWindows };
    } catch (e) {
      googleResult = { error: e };
    }
  }

  // 3. Merge CRM + Google (dedup, no double-buffer). Throws CalendarUnavailableError
  //    if Google could not be read → route returns 503.
  const busyWindows = combineBusyWindows(crmWindows, googleResult);

  // Candidate duration for slot blocking.
  let duration = 60;
  if (duration_minutes != null) {
    duration = Number(duration_minutes);
  } else if (appointment_type_id) {
    const t = await getType(appointment_type_id);
    if (t) duration = resolveDuration(t, null);
  }

  const slots = await getEffectiveSlots();
  const blocked = computeBlockedSlots(slots, date, tz, duration, busyWindows);

  return {
    date,
    timezone: tz,
    duration_minutes: duration,
    blocked_slots: blocked,
    slots,
    busy_windows: busyWindows,
  };
}

module.exports = {
  getAvailability, computeBlockedSlots, SLOTS, dateBoundsUtc, toUtcIso, DEFAULT_TZ,
  CalendarUnavailableError, mergeWindows, getGoogleConflictWindows, dropLegacyPhoneCallWindows, CALENDAR_ID,
};