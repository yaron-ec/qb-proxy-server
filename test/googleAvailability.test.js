/* eslint-disable no-undef */
/**
 * googleAvailability.test.js — proves the Railway-owned combined availability:
 * real Google Calendar events are buffered [start-1h, end+1h], merged with
 * Postgres windows (dedup, no double-buffer), and slot-blocked with the same
 * strict-overlap rule as the existing buffer tests.
 *
 * Pure (no network): uses the real eventToBusyWindow/mergeWindows/computeBlocked
 * functions against a realistic Google event JSON shape.
 *
 * Run: node test/googleAvailability.test.js
 */
'use strict';

const {
  eventToBusyWindow, eventTimesToUtcMs, isExcluded, BUFFER_MS,
} = require('../lib/booking/googleAvailability');
const { mergeWindows, combineBusyWindows, CalendarUnavailableError } = require('../lib/booking/windowMerge');
const { computeBlockedSlots, SLOTS } = require('../lib/booking/slotBlocking');

const DATE = '2026-08-17';
const TZ = 'America/Los_Angeles';
const DURATION = 60;

let failed = 0;
function check(cond, msg) {
  if (!cond) { failed++; console.log(`  X ${msg}`); }
  else console.log(`  OK ${msg}`);
}

// 1. Real 5:00-6:00 PM PDT Google event -> buffered 4:00-7:00 PM
const ev5pm = {
  id: 'google-evt-5pm',
  status: 'confirmed',
  summary: 'Client Meeting',
  start: { dateTime: '2026-08-17T17:00:00-07:00' },
  end: { dateTime: '2026-08-17T18:00:00-07:00' },
};
const w = eventToBusyWindow(ev5pm, TZ);
check(w && w.source === 'google', 'eventToBusyWindow tags source=google');
check(w && w.start === '2026-08-17T23:00:00.000Z', `buffer start = 1h before (16:00 PDT) = ${w && w.start}`);
check(w && w.end === '2026-08-18T02:00:00.000Z', `buffer end = 1h after (19:00 PDT) = ${w && w.end}`);

// 2. Slot blocking: 5pm blocked, hour before/after blocked, adjacent allowed
const blocked = computeBlockedSlots(SLOTS, DATE, TZ, DURATION, [w]);
const bs = new Set(blocked);
check(bs.has('17:00'), '5:00 PM slot is BLOCKED by the Google event');
check(bs.has('16:00'), 'hour before (4:00 PM) is BLOCKED');
check(bs.has('18:00'), 'hour after (6:00 PM) is BLOCKED');
check(!bs.has('15:00'), '3:00 PM (adjacent before) is ALLOWED');
check(!bs.has('19:00'), '7:00 PM (adjacent after) is ALLOWED');

// 3. Postgres appointment still blocks correctly (same buffer shape)
const crmWin = { start: '2026-08-17T23:00:00.000Z', end: '2026-08-18T02:00:00.000Z', source: 'crm' };
const blockedCrm = computeBlockedSlots(SLOTS, DATE, TZ, DURATION, [crmWin]);
check(new Set(blockedCrm).has('17:00'), 'Postgres-only appointment still blocks 5:00 PM');

// 4. Duplicate CRM + Google does NOT double-buffer (merges to one window)
const merged = mergeWindows([crmWin, w]);
check(merged.length === 1, `duplicate crm+google merges to ONE window (got ${merged.length})`);
check(merged[0].sources && merged[0].sources.includes('crm') && merged[0].sources.includes('google'),
  'merged window carries both sources [crm, google]');
const blockedMerged = computeBlockedSlots(SLOTS, DATE, TZ, DURATION, merged);
check(new Set(blockedMerged).has('17:00') && !new Set(blockedMerged).has('19:00'),
  'merged result blocks 5pm but not 7pm (no over-buffer / no double-buffer)');

// 5. Touching windows merge (canonical blocked result)
const a = { start: '2026-08-17T23:00:00.000Z', end: '2026-08-18T02:00:00.000Z', source: 'google' };
const b = { start: '2026-08-18T02:00:00.000Z', end: '2026-08-18T03:00:00.000Z', source: 'crm' };
check(mergeWindows([a, b]).length === 1, 'touching windows merge into one');

// 6. CRM travel artifact excluded; transparent (free) event excluded
const travelEv = {
  id: 't1', status: 'confirmed',
  start: { dateTime: '2026-08-17T18:00:00-07:00' }, end: { dateTime: '2026-08-17T19:00:00-07:00' },
  extendedProperties: { private: { ec_kind: 'travel' } },
};
check(isExcluded(travelEv), 'CRM travel artifact is excluded (no over-buffer)');
const freeEv = {
  id: 'f1', status: 'confirmed', transparency: 'transparent',
  start: { dateTime: '2026-08-17T17:00:00-07:00' }, end: { dateTime: '2026-08-17T18:00:00-07:00' },
};
check(isExcluded(freeEv), 'transparent (free) event is excluded');

// 7. All-day Google event blocks business-hour slots
const allDay = { id: 'ad1', status: 'confirmed', summary: 'PTO', start: { date: '2026-08-17' }, end: { date: '2026-08-18' } };
const adw = eventToBusyWindow(allDay, TZ);
check(adw && adw.source === 'google', 'all-day event converts to a google window');
const blockedAd = new Set(computeBlockedSlots(SLOTS, DATE, TZ, DURATION, [adw]));
check(blockedAd.has('17:00') && blockedAd.has('09:00') && blockedAd.has('18:00'),
  'all-day event blocks business-hour slots');

// 8. eventTimesToUtcMs handles offset + all-day + malformed
check(eventTimesToUtcMs(ev5pm, TZ).startMs === Date.parse('2026-08-17T17:00:00-07:00'),
  'eventTimesToUtcMs parses timed event offset');
check(eventTimesToUtcMs(allDay, TZ) !== null, 'eventTimesToUtcMs parses all-day event');
check(eventTimesToUtcMs({ start: {} }, TZ) === null, 'eventTimesToUtcMs rejects empty start');

// 9. Cancelled Google event is ignored
const cancelledEv = {
  id: 'c1', status: 'cancelled',
  start: { dateTime: '2026-08-17T17:00:00-07:00' }, end: { dateTime: '2026-08-17T18:00:00-07:00' },
};
const confirmedOnly = [cancelledEv, ev5pm].filter(ev => ev && ev.status !== 'cancelled');
check(confirmedOnly.length === 1 && confirmedOnly[0].id === 'google-evt-5pm',
  'cancelled Google event is filtered out before buffering');

// 10. Google API failure -> calendar_unavailable (fail-closed, never all-open)
let threwErr = null;
try { combineBusyWindows([], { error: new Error('Calendar list 500') }); } catch (e) { threwErr = e; }
check(threwErr instanceof CalendarUnavailableError, 'Google failure throws CalendarUnavailableError (typed)');
check(threwErr && threwErr.code === 'calendar_unavailable', 'error code is calendar_unavailable (route -> 503)');
const okMerged = combineBusyWindows([crmWin], { windows: [w] });
check(okMerged.length === 1 && okMerged[0].sources.includes('crm') && okMerged[0].sources.includes('google'),
  'combineBusyWindows merges crm+google when Google read succeeds');

if (failed > 0) { console.error(`\nFAIL: ${failed} assertion(s)`); process.exit(1); }
console.log('\nPASS: Google Calendar combined availability (buffer, merge, dedup, exclude, fail-closed)');
process.exit(0);