/* eslint-disable no-undef */
/**
 * slotBlocking — pure, DB-free slot-blocking logic for appointment availability.
 *
 * Extracted from availabilityService so the buffer rule can be unit-tested
 * without a Postgres connection. No requires.
 *
 * Buffer rule: each appointment's busy_range is stored at insert time as
 * [start-60m, end+60m] (the protected window). A candidate is blocked when its
 * ACTUAL meeting window [slot, slot+duration] overlaps any busy_range. The
 * candidate is NOT buffered again — busy_range already carries the 1hr buffer
 * on each side, so buffering the candidate too would double-buffer (2hr each
 * side). Strict overlap: candStart < busyEnd && candEnd > busyStart. Touching at
 * a point (candStart == busyEnd or candEnd == busyStart) is adjacent, NOT a
 * conflict.
 */
'use strict';

const DEFAULT_TZ = 'America/Los_Angeles';

// 08:30–18:30, 30-min increments
const SLOTS = [];
for (let h = 8; h <= 18; h++) {
  for (let m = 0; m < 60; m += 30) {
    if (h === 8 && m === 0) continue;
    if (h === 18 && m > 30) continue;
    SLOTS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
}

// Convert a (date, "HH:MM", tz) local wall-clock time to a UTC ISO string.
function toUtcIso(date, time, tz) {
  const zone = tz || DEFAULT_TZ;
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(noonUtc);
  const pm = {};
  for (const p of parts) pm[p.type] = p.value;
  const laH = parseInt(pm.hour === '24' ? '0' : pm.hour, 10);
  const laM = parseInt(pm.minute, 10);
  const offsetMin = 720 - (laH * 60 + laM);
  const [tH, tM] = time.split(':').map(Number);
  const target = tH * 60 + tM + offsetMin;
  const uH = Math.floor(target / 60) % 24;
  const uM = target % 60;
  const dayOff = Math.floor(target / (60 * 24));
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + dayOff);
  base.setUTCHours(uH, uM, 0, 0);
  return base.toISOString();
}

// Pure slot-blocking (no DB). busyWindows carry the already-buffered busy_range
// ([start-1hr, end+1hr]) from the appointments table. The candidate is the
// ACTUAL meeting [slot, slot+duration] — NOT buffered again.
function computeBlockedSlots(slots, date, tz, durationMinutes, busyWindows) {
  const blocked = [];
  for (const slot of slots) {
    const slotStart = new Date(toUtcIso(date, slot, tz));
    const candStart = slotStart;
    const candEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000);
    const isBlocked = busyWindows.some(w =>
      new Date(candStart) < new Date(w.end) && new Date(candEnd) > new Date(w.start)
    );
    if (isBlocked) blocked.push(slot);
  }
  return blocked;
}

module.exports = { computeBlockedSlots, SLOTS, toUtcIso, DEFAULT_TZ };