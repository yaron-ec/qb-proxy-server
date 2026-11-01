/* eslint-disable no-undef */
/**
 * Pacific timezone + formatting helpers.
 *
 * Ported VERBATIM from the Base44 sendAppointmentReminder function so the
 * Railway worker computes identical appointment instants. Appointment times
 * are stored as Pacific local strings and must be DST-correctly converted
 * to UTC. The Railway runtime is UTC; America/Los_Angeles is handled via
 * Intl timeZone (same technique as the Base44 function), not env TZ.
 */
'use strict';

/** Format "9" or "09:00" or "9:00 AM" -> "9:00 AM". */
function fmt12(t) {
  if (!t) return '';
  const normalized = String(t).replace(/\s*(AM|PM)/i, '').trim();
  const [h, m] = normalized.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${ampm}`;
}

/** "2026-07-22" -> "Wednesday, July 22, 2026" (en-US) or the installation's
 * configured locale (company_settings.locale — PRODUCTIZATION PHASE 2, e.g.
 * 'en-GB' -> "Wednesday, 22 July 2026"). Defaults to 'en-US' when omitted,
 * preserving EC's exact historical customer-facing reminder email format. */
function formatDate(dateStr, locale) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString(locale || 'en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

const DEFAULT_TZ = 'America/Los_Angeles';

/** Format a UTC ms timestamp as local time string for logs (default Pacific,
 * preserving EC's exact historical behavior — pass the installation's
 * configured timezone, see lib/companyConfig.js#getTimezone, for anything
 * company-specific). */
function toLA(ms, tz) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: tz || DEFAULT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/**
 * The zone's real UTC offset (in minutes) at a given instant — computed by
 * reading the zone's own wall-clock reading of `ms` and treating THAT as if
 * it were itself a UTC instant; the difference from the real `ms` is exactly
 * the offset in effect at `ms`. No hardcoded offset assumptions, so this
 * works for any IANA zone, not just America/Los_Angeles.
 */
function offsetMinutesAt(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(ms).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some ICU implementations report midnight as "24"
  const zonedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return (zonedAsUtc - ms) / 60000;
}

/**
 * Convert a local wall-clock appointment (date + time) to UTC milliseconds,
 * DST-correct. Mirrors the Base44 pacificToUtcMs exactly when `tz` is
 * omitted (default 'America/Los_Angeles', preserving EC's exact historical
 * behavior) — pass the installation's configured timezone
 * (lib/companyConfig.js#getTimezone) so a non-Pacific installation's
 * reminder windows fire against ITS wall-clock time, not a hidden Pacific
 * assumption.
 *
 * DST FIX (November 2026): the original implementation probed the offset at
 * a FIXED anchor — noon UTC of the calendar date — and applied that single
 * offset to every time of day on that date. On the day a DST transition
 * actually happens, a date can straddle TWO different offsets (e.g. the US
 * "fall back" day is PDT before ~2:00 AM local and PST from ~1:00 AM local
 * onward), so the noon anchor (always well past the transition) silently
 * applied the WRONG, later-in-the-day offset to every early-morning time —
 * a full 1-hour miscalculation, confirmed to reproduce for any wall-clock
 * time from local midnight up to the transition on the US "fall back" day
 * (and symmetrically on the "spring forward" day). This was found when
 * test/phoneCallRemindersMichelleExclusion.test.js failed only when CI
 * happened to run in the ~2-hour window this bug affects (2026-11-01,
 * America/Los_Angeles) — reproduced and root-caused via direct comparison
 * against this function's actual output, not guessed.
 *
 * Fixed by probing the offset from the TARGET instant's own neighborhood
 * instead of a fixed anchor: an initial guess is taken by treating the
 * requested wall-clock date/time as if it were already UTC (near enough to
 * the real target to usually land in the correct offset regime), then that
 * guess is cross-checked against the OTHER offset in effect a few hours to
 * either side of the resulting candidate. Whichever candidate round-trips
 * back to the exact requested date/time is used; if a transition makes the
 * requested local time genuinely AMBIGUOUS (the repeated hour on a
 * "fall back" day — both candidates round-trip correctly), the earlier
 * (pre-transition) instant is used, a defensible, deterministic default.
 * If the requested local time is genuinely NONEXISTENT (the skipped hour on
 * a "spring forward" day), neither candidate round-trips; the later
 * (post-transition) candidate is used as a best-effort fallback — this
 * case has no correct answer by construction and is not a realistic
 * appointment time in practice.
 */
function pacificToUtcMs(dateStr, timeStr, tz) {
  const zone = tz || DEFAULT_TZ;
  const [y, mo, d] = dateStr.split('-').map(Number);
  let normalized = String(timeStr || '09:00').replace(/\s*(AM|PM)/i, '').trim();
  if (!normalized.includes(':')) normalized = `${normalized}:00`;
  const [h, m] = normalized.split(':').map(Number);

  const naiveMs = Date.UTC(y, mo - 1, d, h, m, 0);
  const guessOffsetMin = offsetMinutesAt(naiveMs, zone);
  const candidateA = naiveMs - guessOffsetMin * 60000;

  // Probe a few hours either side of the first-guess candidate (comfortably
  // wider than any real-world DST shift, which is always 1-2 hours) for a
  // DIFFERENT offset — if found, build a second candidate from it. This is
  // how a genuinely ambiguous or nonexistent local time near a transition is
  // ever detected at all.
  const margin = 2 * 3600000;
  const farBefore = offsetMinutesAt(candidateA - margin, zone);
  const farAfter = offsetMinutesAt(candidateA + margin, zone);
  const altOffsetMin = farBefore !== guessOffsetMin ? farBefore
    : (farAfter !== guessOffsetMin ? farAfter : guessOffsetMin);
  const candidateB = naiveMs - altOffsetMin * 60000;

  const roundTrips = (candidateMs) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(candidateMs).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    let hh = Number(parts.hour);
    if (hh === 24) hh = 0;
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hh, Number(parts.minute), Number(parts.second)) === naiveMs;
  };

  const aOk = roundTrips(candidateA);
  const bOk = altOffsetMin !== guessOffsetMin && roundTrips(candidateB);

  if (aOk && bOk) return Math.min(candidateA, candidateB); // ambiguous: prefer the earlier (pre-transition) instant
  if (aOk) return candidateA;
  if (bOk) return candidateB;
  return candidateB !== candidateA ? Math.max(candidateA, candidateB) : candidateA; // nonexistent: best-effort fallback
}

/**
 * Extract the appointment instance { date, time, type } from a reminder lead.
 * Shared by the reminder engine (getAppointmentMs) and the action router
 * (appointment fingerprint for change-detection).
 *
 * ONLY the canonical appointment (reminder_leads.appointment_* — projected from
 * the lead's active appointments row) is an appointment. A follow-up of ANY
 * type — including 'Meeting' and 'Phone Call' — is an internal next action and
 * never produces a customer appointment reminder. (Timed 'Phone Call'
 * follow-ups get staff call reminders via lib/phoneCallReminders.js, which
 * does not use this function.)
 * Returns null when there is nothing to remind about.
 */
function appointmentParts(lead) {
  if (!lead || !lead.appointment_date) return null;
  return {
    date: lead.appointment_date,
    time: lead.appointment_time || '09:00',
    type: lead.appointment_type || 'Meeting',
  };
}

module.exports = { fmt12, formatDate, toLA, pacificToUtcMs, appointmentParts, DEFAULT_TZ };