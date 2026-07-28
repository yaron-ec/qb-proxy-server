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

/** "2026-07-22" -> "Wednesday, July 22, 2026". */
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/** Format a UTC ms timestamp as LA local time string for logs. */
function toLA(ms) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/**
 * Convert a Pacific-local appointment (date + time) to UTC milliseconds,
 * DST-correct. Mirrors the Base44 pacificToUtcMs exactly.
 */
function pacificToUtcMs(dateStr, timeStr) {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const laHour = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', hour12: false,
  }).format(probe));
  const offsetHours = laHour - 12; // PDT=-7, PST=-8
  const [y, mo, d] = dateStr.split('-').map(Number);
  let normalized = String(timeStr || '09:00').replace(/\s*(AM|PM)/i, '').trim();
  if (!normalized.includes(':')) normalized = `${normalized}:00`;
  const [h, m] = normalized.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h - offsetHours, m || 0, 0);
}

/**
 * Extract the appointment instance { date, time, type } from a lead, using the
 * same follow-up-preferred rule as the reminder engine's getAppointmentMs.
 * Used by the action router to compute the CURRENT appointment fingerprint for
 * change-detection (date/time/type/rep change → "appointment changed" page).
 */
function appointmentParts(lead) {
  const hasFollowUp = lead.follow_up_date && lead.follow_up_type;
  return {
    date: hasFollowUp ? lead.follow_up_date : lead.appointment_date,
    time: hasFollowUp ? (lead.follow_up_time || '09:00') : (lead.appointment_time || '09:00'),
    type: hasFollowUp ? lead.follow_up_type : 'Meeting',
  };
}

module.exports = { fmt12, formatDate, toLA, pacificToUtcMs, appointmentParts };