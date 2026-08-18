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
 *   - extendedProperties.private.ec_kind === 'travel'  (CRM driving artifact;
 *     the parent appointment's Postgres busy_range already covers it)
 *   - transparency === 'transparent'  (event marked "free" on Google)
 * Genuine external Google events (e.g. a 5pm appointment a rep added by hand)
 * are included and buffered.
 */
'use strict';

const googleCalendarClient = require('./googleCalendarClient');
const { toUtcIso, DEFAULT_TZ } = require('./slotBlocking');

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
function eventToBusyWindow(event, tz) {
  const t = eventTimesToUtcMs(event, tz);
  if (!t) return null;
  return {
    start: new Date(t.startMs - BUFFER_MS).toISOString(),
    end: new Date(t.endMs + BUFFER_MS).toISOString(),
    source: 'google',
    google_event_id: event.id || null,
    summary: event.summary || '',
  };
}

// Exclude CRM travel artifacts + events explicitly marked "free" on Google.
function isExcluded(event) {
  const ext = (event && event.extendedProperties && event.extendedProperties.private) || {};
  if (ext.ec_kind === 'travel') return true;
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