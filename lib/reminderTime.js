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

module.exports = { fmt12, formatDate, toLA, pacificToUtcMs, appointmentParts };