/* eslint-disable no-undef */
/**
 * followUp — the canonical Follow-Up / Next Update model (leads.follow_up_*).
 *
 * A follow-up is the lead's internal next action. It is INDEPENDENT of the
 * appointment (lib/booking/appointmentView.js): saving, editing or clearing a
 * follow-up never creates, moves or cancels an appointment, never blocks
 * availability and never touches Google Calendar.
 *
 *   follow_up_date    'YYYY-MM-DD' (Pacific business date) | null
 *   follow_up_time    'HH:MM' 24h Pacific | null (requires a date)
 *   follow_up_type    one of FOLLOW_UP_TYPES | null
 *   follow_up_notes   free text (≤ 2000 chars) | null
 *   follow_up_status  'pending' | 'completed' | null (null only when cleared)
 *
 * 'Meeting' remains an accepted type so existing follow-ups keep validating;
 * a customer site visit itself is booked as an Appointment, not a follow-up.
 */
'use strict';

const FOLLOW_UP_TYPES = ['Phone Call', 'Text', 'Email', 'Meeting', 'Other'];
const FOLLOW_UP_STATUSES = ['pending', 'completed'];
const FOLLOW_UP_FIELDS = ['follow_up_date', 'follow_up_time', 'follow_up_type', 'follow_up_notes', 'follow_up_status'];
const MAX_NOTES = 2000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function blank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Accept 'H:MM' / 'HH:MM' / 'HH:MM:SS' (Postgres TIME text) → 'HH:MM'.
function normTime(v) {
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const t = `${m[1].padStart(2, '0')}:${m[2]}`;
  return TIME_RE.test(t) ? t : null;
}

/**
 * Validate + normalize a complete follow-up. Returns
 * { ok: true, value: {follow_up_*}, cleared } or { ok: false, errors }.
 * All-blank input means "no follow-up" (cleared: every field null).
 */
function normalizeFollowUp(input) {
  const src = input || {};
  const errors = [];
  const allBlank = FOLLOW_UP_FIELDS.every(f => blank(src[f]));
  if (allBlank) {
    return { ok: true, cleared: true, value: {
      follow_up_date: null, follow_up_time: null, follow_up_type: null,
      follow_up_notes: null, follow_up_status: null,
    } };
  }

  let date = null, time = null, type = null, notes = null, status = null;
  if (!blank(src.follow_up_date)) {
    const d = String(src.follow_up_date).trim().slice(0, 10);
    if (!validDate(d)) errors.push('follow_up_date must be a valid YYYY-MM-DD date');
    else date = d;
  }
  if (!blank(src.follow_up_time)) {
    time = normTime(src.follow_up_time);
    if (!time) errors.push('follow_up_time must be HH:MM (24h)');
  }
  if (!blank(src.follow_up_type)) {
    type = String(src.follow_up_type).trim();
    if (!FOLLOW_UP_TYPES.includes(type)) errors.push(`follow_up_type must be one of: ${FOLLOW_UP_TYPES.join(', ')}`);
  }
  if (!blank(src.follow_up_notes)) {
    notes = String(src.follow_up_notes).trim();
    if (notes.length > MAX_NOTES) errors.push(`follow_up_notes must be at most ${MAX_NOTES} characters`);
  }
  if (!blank(src.follow_up_status)) {
    status = String(src.follow_up_status).trim().toLowerCase();
    if (!FOLLOW_UP_STATUSES.includes(status)) errors.push(`follow_up_status must be one of: ${FOLLOW_UP_STATUSES.join(', ')}`);
  }

  if (!date) {
    if (!errors.some(e => e.startsWith('follow_up_date'))) errors.push('follow_up_date is required for a follow-up');
  }
  if (!type && !errors.some(e => e.startsWith('follow_up_type'))) errors.push('follow_up_type is required for a follow-up');

  if (errors.length) return { ok: false, errors };
  return { ok: true, cleared: false, value: {
    follow_up_date: date, follow_up_time: time, follow_up_type: type,
    follow_up_notes: notes, follow_up_status: status || 'pending',
  } };
}

module.exports = { normalizeFollowUp, FOLLOW_UP_TYPES, FOLLOW_UP_STATUSES, FOLLOW_UP_FIELDS };
