/* eslint-disable no-undef */
'use strict';

/**
 * phoneCallCalendarReminder.test.js — pure tests of the ONE canonical Phone
 * Call classification (lib/booking/phoneCallModel.js), the non-blocking
 * follow-up reminder event (lib/booking/followUpReminders.js) and the legacy
 * Phone Call row classifier (lib/booking/legacyPhoneCallConversion.js).
 *
 * PERMANENT RULE: every follow-up type gets SOME calendar representation
 * (isActiveFollowUpReminder() / CALENDAR_REMINDER_FOLLOWUP_TYPES) — but WHICH
 * one depends on type: Phone Call/Text/Email/Other get the lightweight, FREE,
 * non-blocking 15-minute reminder this file tests (buildReminderEvent);
 * Meeting gets a real physical-meeting representation (1h, BUSY, + travel) —
 * see test/followUpMeeting.test.js and
 * lib/booking/followUpReminders.js#desiredRepresentation for that split.
 * Real-Postgres coverage: test/integration/phoneCallCalendarReminder.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  isActiveFollowUpReminder, isNonBlockingCrmGoogleEvent, followUpStartIso, CALENDAR_REMINDER_FOLLOWUP_TYPES,
} = require('../lib/booking/phoneCallModel');
const { FOLLOW_UP_TYPES } = require('../lib/followUp');
const { buildReminderEvent, reminderEventId, fingerprint, desiredRepresentation } = require('../lib/booking/followUpReminders');
const { isExcluded, eventToBusyWindow } = require('../lib/booking/googleAvailability');
const { classify, laDateTime } = require('../lib/booking/legacyPhoneCallConversion');
const { computeBlockedSlots, SLOTS } = require('../lib/booking/slotBlocking');

const LEAD = {
  id: '11111111-2222-3333-4444-555555555555', first_name: 'Test', last_name: 'Lead', phone: '555-0100',
  follow_up_type: 'Phone Call', follow_up_date: '2026-10-14', follow_up_time: '10:00',
  follow_up_status: 'pending', follow_up_notes: 'call back', owner_email: 'rep@example.com',
};

test('an active timed follow-up of ANY type is recognised; completed / untimed are not', () => {
  assert.strictEqual(isActiveFollowUpReminder(LEAD), true);
  assert.strictEqual(isActiveFollowUpReminder({ ...LEAD, follow_up_status: null }), true);
  assert.strictEqual(isActiveFollowUpReminder({ ...LEAD, follow_up_status: 'completed' }), false);
  assert.strictEqual(isActiveFollowUpReminder({ ...LEAD, follow_up_time: null }), false);
  assert.strictEqual(isActiveFollowUpReminder({ ...LEAD, follow_up_date: '10/14/2026' }), false);
  assert.strictEqual(isActiveFollowUpReminder({ ...LEAD, follow_up_type: null }), false, 'no type, no reminder');
  for (const t of ['Meeting', 'Text', 'Email', 'Other']) {
    assert.strictEqual(isActiveFollowUpReminder({ ...LEAD, follow_up_type: t }), true, `${t} gets a calendar reminder too (permanent rule)`);
  }
  assert.deepStrictEqual(CALENDAR_REMINDER_FOLLOWUP_TYPES, FOLLOW_UP_TYPES, 'every defined follow-up type is covered');
});

test('the reminder event is a free, marked, owner-only, 15-minute reminder at the follow-up time', () => {
  const ev = buildReminderEvent(LEAD, 'https://crm.example.com/', 0);
  assert.strictEqual(ev.id, reminderEventId(LEAD.id, 0));
  assert.match(ev.id, /^[0-9a-v]{5,1024}$/, 'valid Google event id (base32hex)');
  assert.strictEqual(ev.transparency, 'transparent');
  assert.deepStrictEqual(ev.start, { dateTime: '2026-10-14T10:00:00', timeZone: 'America/Los_Angeles' });
  assert.deepStrictEqual(ev.end, { dateTime: '2026-10-14T10:15:00', timeZone: 'America/Los_Angeles' });
  assert.deepStrictEqual(ev.attendees, [{ email: 'rep@example.com' }], 'owner only — the customer is never invited');
  assert.match(ev.summary, /^Phone Call: Test Lead$/);
  assert.match(ev.description, /NOT an appointment/);
  assert.match(ev.description, /https:\/\/crm\.example\.com\/leads\/11111111-/);
  assert.deepStrictEqual(ev.extendedProperties.private, {
    ec_kind: 'followup_reminder', ec_followup_kind: 'phone_call', ec_blocking: 'false', ec_source: 'crm', ec_lead_id: LEAD.id,
  });
  assert.strictEqual(followUpStartIso(LEAD), '2026-10-14T17:00:00.000Z');
});

test('desiredRepresentation: Meeting gets the physical-meeting representation; everything else gets the lightweight reminder', () => {
  assert.strictEqual(desiredRepresentation({ ...LEAD, follow_up_type: 'Meeting' }), 'meeting');
  for (const t of ['Phone Call', 'Text', 'Email', 'Other']) {
    assert.strictEqual(desiredRepresentation({ ...LEAD, follow_up_type: t }), 'reminder', `${t} stays the lightweight reminder`);
  }
});

test('timezone/DST: the follow-up time conversion is correct on both sides of the US spring-forward transition (2026-03-08) — shared by both representations', () => {
  // Reuses the same toUtcIso/isoToLaParts primitives as the Appointment path
  // (lib/booking/slotBlocking.js, already proven DST-correct by
  // test/multiTimezoneBooking.test.js). See test/followUpMeeting.test.js for
  // the Meeting-representation-specific DST proof (1h duration + travel).
  const before = { ...LEAD, follow_up_date: '2026-03-07', follow_up_time: '10:00' }; // PST (UTC-8)
  const after = { ...LEAD, follow_up_date: '2026-03-09', follow_up_time: '10:00' }; // PDT (UTC-7)
  assert.strictEqual(followUpStartIso(before), '2026-03-07T18:00:00.000Z');
  assert.strictEqual(followUpStartIso(after), '2026-03-09T17:00:00.000Z');
  const evBefore = buildReminderEvent(before, '', 0);
  const evAfter = buildReminderEvent(after, '', 0);
  assert.strictEqual(evBefore.start.dateTime, '2026-03-07T10:00:00');
  assert.strictEqual(evAfter.start.dateTime, '2026-03-09T10:00:00');
  assert.strictEqual(evBefore.start.timeZone, 'America/Los_Angeles');
  assert.strictEqual(evAfter.start.timeZone, 'America/Los_Angeles');
});

test('the reminder id is deterministic per lead + generation (a reschedule keeps the id; a new generation never reuses one)', () => {
  const a = buildReminderEvent(LEAD, '', 0);
  const moved = buildReminderEvent({ ...LEAD, follow_up_date: '2026-10-20', follow_up_time: '15:30', owner_email: 'other@example.com' }, '', 0);
  assert.strictEqual(a.id, moved.id, 'same event updated in place');
  assert.notStrictEqual(fingerprint(a), fingerprint(moved), 'but the content change is detected');
  assert.notStrictEqual(reminderEventId(LEAD.id, 0), reminderEventId(LEAD.id, 1));
  assert.notStrictEqual(reminderEventId(LEAD.id, 0), reminderEventId('99999999-2222-3333-4444-555555555555', 0));
  assert.strictEqual(fingerprint(a), fingerprint(buildReminderEvent(LEAD, '', 0)), 'idempotent');
});

test('availability ignores CRM non-blocking events by marker — even when Google shows them as busy', () => {
  const opaqueReminder = { ...buildReminderEvent(LEAD, '', 0), transparency: 'opaque' };
  assert.strictEqual(isNonBlockingCrmGoogleEvent(opaqueReminder), true);
  assert.strictEqual(isExcluded(opaqueReminder), true, 'marker, not Google free/busy');
  assert.strictEqual(isExcluded({ extendedProperties: { private: { ec_kind: 'travel' } } }), true);
  assert.strictEqual(isExcluded({ extendedProperties: { private: { ec_kind: 'main', ec_appointment_kind: 'phone_call' } } }), true);
  assert.strictEqual(isExcluded({ extendedProperties: { private: { ec_blocking: 'false' } } }), true);
});

test('D: a genuine external Google event (no CRM marker) still blocks ±1h — even titled "Phone Call"', () => {
  const ext = { id: 'ext1', status: 'confirmed', summary: 'Phone Call with bank',
    start: { dateTime: '2026-10-14T13:00:00-07:00' }, end: { dateTime: '2026-10-14T14:00:00-07:00' } };
  assert.strictEqual(isNonBlockingCrmGoogleEvent(ext), false);
  assert.strictEqual(isExcluded(ext), false, 'title text is never a classifier');
  const w = eventToBusyWindow(ext, 'America/Los_Angeles');
  const blocked = computeBlockedSlots(SLOTS, '2026-10-14', 'America/Los_Angeles', 60, [w]);
  assert.deepStrictEqual(blocked, ['11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30']);
  // A real CRM Meeting's main event (ec_kind main, no phone_call kind) blocks too.
  assert.strictEqual(isExcluded({ ...ext, extendedProperties: { private: { ec_kind: 'main', ec_appointment_kind: 'meeting' } } }), false);
});

test('eventToBusyWindow carries ec_appointment_id so legacy Phone Call events can be dropped by row', () => {
  const w = eventToBusyWindow({ id: 'g1', start: { dateTime: '2026-10-14T10:00:00-07:00' }, end: { dateTime: '2026-10-14T10:30:00-07:00' },
    extendedProperties: { private: { ec_kind: 'main', ec_appointment_id: 'abc' } } }, 'America/Los_Angeles');
  assert.strictEqual(w.ec_appointment_id, 'abc');
});

test('legacy Phone Call row classification: converted / deduplicated / ambiguous', () => {
  const appt = { start_at: '2026-10-14T17:00:00.000Z' };
  assert.deepStrictEqual(laDateTime(appt.start_at), { date: '2026-10-14', time: '10:00' });
  assert.strictEqual(classify(appt, null).action, 'ambiguous');
  assert.strictEqual(classify(appt, { status: 'Lost' }).reason, 'lead_status_Lost');
  assert.strictEqual(classify(appt, { status: 'New' }).action, 'converted');
  assert.strictEqual(classify(appt, { status: 'New', follow_up_date: '2026-10-01', follow_up_status: 'completed' }).action, 'converted');
  assert.strictEqual(classify(appt, { status: 'New', follow_up_type: 'Phone Call', follow_up_date: '2026-10-14', follow_up_time: '10:00', follow_up_status: 'pending' }).action, 'deduplicated');
  const other = classify(appt, { status: 'New', follow_up_type: 'Email', follow_up_date: '2026-10-20', follow_up_time: '09:00', follow_up_status: 'pending' });
  assert.deepStrictEqual(other, { action: 'ambiguous', reason: 'lead_has_different_active_follow_up' });
});
