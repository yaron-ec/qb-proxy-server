'use strict';

/**
 * freeDays — future test days guaranteed to hold no appointment.
 *
 * The integration database persists between runs (only CI starts empty), and
 * every booking file books for the same owner. Random day pickers therefore
 * collided with appointments left by earlier runs or other files, and the
 * canonical conflict check (correctly) answered 409. loadFreeDayPicker reads
 * the days already in use once, then hands out random far-future days whose
 * whole ±1-day neighbourhood is empty, and reserves each day it returns.
 */
async function loadFreeDayPicker(db) {
  const busy = new Set((await db.query(
    `SELECT DISTINCT to_char((start_at AT TIME ZONE 'America/Los_Angeles')::date, 'YYYY-MM-DD') AS d
       FROM appointments WHERE start_at >= '2030-01-01'`)).rows.map(r => r.d));
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const DAY = 86400000;
  const base = Date.UTC(2040, 0, 1);
  return function freeDay() {
    for (;;) {
      const t = base + Math.floor(Math.random() * 60000) * DAY;
      if ([-1, 0, 1].some(k => busy.has(iso(t + k * DAY)))) continue;
      [-1, 0, 1].forEach(k => busy.add(iso(t + k * DAY)));
      return iso(t);
    }
  };
}

module.exports = { loadFreeDayPicker };
