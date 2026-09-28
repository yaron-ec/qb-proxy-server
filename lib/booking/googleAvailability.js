/* eslint-disable no-undef */
/**
 * googleAvailability — read REAL Google Calendar events and convert them into
 * buffered busy windows for the public capture availability path.
 *
 * Reuses the existing Railway Google Calendar client (service-account JWT in
 * googleCalendarClient.js). No Base44. No browser tokens.
 *
 * Calendar id = GOOGLE_CALENDAR_ID (default 'primary') — the SAME calendar the
 * calendar outbox writes EC appointments to (lib/booking/calendarOutbox.js).
 * This is the canonical "Yaron" calendar for the capture flow.
 *
 * Buffer rule (matches the Postgres appointments.busy_range convention):
 *   window = [eventStart - 1h, eventEnd + 1h]
 * i.e. 1 hour BEFORE + full event duration + 1 hour AFTER.
 *
 * Exclusions (so CRM-generated artifacts do not over-block beyond the rule):
 *   - extendedProperties.private.ec_kind === 'followup_reminder'  (Phone Call
 *     follow-up reminder — calendar visibility only, never occupancy)
 *   - extendedProperties.private.ec_kind === 'travel'  (CRM driving artifact;
 *     the parent appointment's Postgres busy_range already covers it)
 *   - extendedProperties.private.ec_appointment_kind === 'phone_call'
 *     (a Phone Call is a reminder/activity, never an Appointment/Site
 *     Visit — it must never block availability or participate in conflict
 *     detection, even for its own exact time slot; see calendarOutbox.js's
 *     buildOperation, which tags this on every Phone Call's main event)
 *   - transparency === 'transparent'  (event marked "free" on Google)
 * Genuine external Google events (e.g. a 5pm appointment a rep added by hand)
 * are included and buffered.
 */
'use strict';

const googleCalendarClient = require('./googleCalendarClient');
const { toUtcIso, DEFAULT_TZ } = require('./slotBlocking');
const { isNonBlockingCrmGoogleEvent } = require('./phoneCallModel');

const BUFFER_MS = 60 * 60 * 1000; // 1 hour

// Convert a Google event start/end to UTC epoch ms. Handles timed events
// (dateTime with offset) and all-day events (date; end is exclusive).
function eventTimesToUtcMs(event, tz) {
  const s = (event && event.start) || {};
  const e = (event && event.end) || {};
  let startMs;
  let endMs;
  if (s.dateTime) {
    startMs = Date.parse(s.dateTime);
  } else if (s.date) {
    startMs = Date.parse(toUtcIso(s.date, '00:00', tz));
  } else {
    return null;
  }
  if (e.dateTime) {
    endMs = Date.parse(e.dateTime);
  } else if (e.date) {
    endMs = Date.parse(toUtcIso(e.date, '00:00', tz));
  } else {
    endMs = startMs;
  }
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  if (endMs < startMs) endMs = startMs;
  return { startMs, endMs };
}

// Pure: convert one Google event to a buffered busy window (source: google).
// ec_appointment_id is carried through so availabilityService can drop events
// that belong to a legacy Phone Call appointment row synced before the
// phone_call marker existed (see dropLegacyPhoneCallWindows).
function eventToBusyWindow(event, tz) {
  const t = eventTimesToUtcMs(event, tz);
  if (!t) return null;
  const p = (event && event.extendedProperties && event.extendedProperties.private) || {};
  return {
    start: new Date(t.startMs - BUFFER_MS).toISOString(),
    end: new Date(t.endMs + BUFFER_MS).toISOString(),
    source: 'google',
    google_event_id: event.id || null,
    ...(p.ec_appointment_id ? { ec_appointment_id: p.ec_appointment_id } : {}),
    summary: event.summary || '',
  };
}

// Exclude CRM non-blocking events (Phone Call follow-up reminders, Driving /
// Travel Time, marked legacy Phone Call events — phoneCallModel is the one
// classification) and events explicitly marked "free" on Google.
function isExcluded(event) {
  if (isNonBlockingCrmGoogleEvent(event)) return true;
  if (event && event.transparency === 'transparent') return true;
  return false;
}

// Query Google Calendar for the local date (±2h padding so buffer edges of
// near-day events are caught) and return buffered busy windows.
async function getGoogleBusyWindows({ calendarId, date, timezone }) {
  const tz = timezone || DEFAULT_TZ;
  const dayStartMs = Date.parse(toUtcIso(date, '00:00', tz));
  if (Number.isNaN(dayStartMs)) return [];
  const timeMin = new Date(dayStartMs - 2 * BUFFER_MS).toISOString();
  const timeMax = new Date(dayStartMs + 24 * 60 * 60 * 1000 + 2 * BUFFER_MS).toISOString();
  const events = await googleCalendarClient.listEvents(calendarId, timeMin, timeMax);
  const windows = [];
  for (const ev of events) {
    if (!ev || ev.status === 'cancelled') continue;
    if (isExcluded(ev)) continue;
    const w = eventToBusyWindow(ev, tz);
    if (w) windows.push(w);
  }
  return windows;
}

module.exports = {
  getGoogleBusyWindows,
  eventToBusyWindow,
  eventTimesToUtcMs,
  isExcluded,
  BUFFER_MS,
};