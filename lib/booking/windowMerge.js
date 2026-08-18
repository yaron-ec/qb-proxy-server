/* eslint-disable no-undef */
/**
 * windowMerge — pure, DB-free helpers for the availability path.
 *
 *   - CalendarUnavailableError: typed error surfaced when Google Calendar
 *     cannot be read (public route returns 503 — never silently free).
 *   - mergeWindows: collapse touching/overlapping busy windows into canonical
 *     blocked windows. A window present in both CRM and Google (same
 *     appointment) collapses into ONE window tagged with both sources — no
 *     double-buffer.
 *
 * Pure (no require) so it can be unit-tested without a database connection.
 */
'use strict';

class CalendarUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CalendarUnavailableError';
    this.code = 'calendar_unavailable';
  }
}

function mergeWindows(windows) {
  const sorted = windows.slice().sort((a, b) =>
    Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end));
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && Date.parse(w.start) <= Date.parse(last.end)) {
      if (Date.parse(w.end) > Date.parse(last.end)) last.end = w.end;
      const set = new Set(last.sources || [last.source]);
      for (const s of (w.sources || [w.source])) set.add(s);
      last.sources = Array.from(set);
      last.source = last.sources.length === 1 ? last.sources[0] : last.sources.join('+');
    } else {
      merged.push({
        start: w.start,
        end: w.end,
        source: w.source,
        sources: w.sources || [w.source],
      });
    }
  }
  return merged;
}

// Combine CRM (Postgres) windows with a Google read result. FAIL-CLOSED:
// if Google could not be read (googleResult.error), throw CalendarUnavailableError
// so the route returns 503 — the day is NEVER silently reported as free.
// On success, merge CRM + Google windows (dedup, no double-buffer).
function combineBusyWindows(crmWindows, googleResult) {
  if (googleResult && googleResult.error) {
    throw new CalendarUnavailableError(
      (googleResult.error && googleResult.error.message) || 'Google Calendar read failed'
    );
  }
  const googleWindows = (googleResult && googleResult.windows) || [];
  return mergeWindows([...(crmWindows || []), ...googleWindows]);
}

module.exports = { mergeWindows, CalendarUnavailableError, combineBusyWindows };