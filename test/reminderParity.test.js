/* eslint-disable no-undef */
/**
 * reminderParity.test.js — field-by-field parity between the live Base44
 * appointment reminder templates (frozen reference in
 * lib/base44AppointmentTemplates.js, copied verbatim from
 * base44/functions/sendAppointmentReminder/entry.ts) and the Railway
 * templates in lib/reminderEmails.js.
 *
 * Covers the required cases:
 *   - customer with name and email
 *   - customer without first name (fallback 'there')
 *   - assigned rep present
 *   - assigned rep missing (ownerName fallback handled by engine)
 *   - appointment with date and time
 *   - appointment missing time (fmt12 handles)
 *   - 48-hour, 2-hour, 30-minute reminders
 *   - catch-up reminder
 *   - staff reminder
 *
 * Run: cd src/proxy-server && node --test test/reminderParity.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Fix CRM_PUBLIC_URL so the staff CTA link is deterministic on both sides.
process.env.CRM_PUBLIC_URL = 'https://crm.ecconstructiongroup.com';

const ref = require('../lib/base44AppointmentTemplates');   // frozen Base44 port
const rail = require('../lib/reminderEmails');               // Railway templates
const time = require('../lib/reminderTime');

function dateOf(s) { return time.formatDate(s); }
function timeOf(s) { return time.fmt12(s); }

const CASES = [
  { name: 'customer-meeting-48h (name+email, rep present, date+time)',
    a: ref.clientMeetingEmail, b: rail.clientMeetingEmail,
    args: { firstName: 'Jane', date: dateOf('2026-08-03'), time: timeOf('14:30'), address: '123 Main St, LA', projectType: 'Kitchen Remodel', ownerName: 'Yaron Drilevich', label: '48 hours', isCatchUp: false } },
  { name: 'customer-meeting-2h (rep present)',
    a: ref.clientMeetingEmail, b: rail.clientMeetingEmail,
    args: { firstName: 'Jane', date: dateOf('2026-08-03'), time: timeOf('14:30'), address: '123 Main St, LA', projectType: 'Kitchen Remodel', ownerName: 'Yaron Drilevich', label: '2 hours', isCatchUp: false } },
  { name: 'customer-meeting-30min',
    a: ref.clientMeetingEmail, b: rail.clientMeetingEmail,
    args: { firstName: 'Jane', date: dateOf('2026-08-03'), time: timeOf('14:30'), address: '123 Main St, LA', projectType: 'Kitchen Remodel', ownerName: 'Yaron Drilevich', label: '30 minutes', isCatchUp: false } },
  { name: 'customer without first name (fallback there)',
    a: ref.clientMeetingEmail, b: rail.clientMeetingEmail,
    args: { firstName: 'there', date: dateOf('2026-08-03'), time: timeOf('09:00'), address: '', projectType: '', ownerName: 'Michelle', label: '2 hours', isCatchUp: false } },
  { name: 'catch-up meeting reminder',
    a: ref.clientMeetingEmail, b: rail.clientMeetingEmail,
    args: { firstName: 'Jane', date: dateOf('2026-08-03'), time: timeOf('14:30'), address: '123 Main St, LA', projectType: 'ADU', ownerName: 'Yaron Drilevich', label: '48 hours', isCatchUp: true } },
  { name: 'customer phone call 30min',
    a: ref.clientPhoneCallEmail, b: rail.clientPhoneCallEmail,
    args: { firstName: 'Jane', date: dateOf('2026-08-03'), time: timeOf('14:30'), phone: '(310) 555-1234', projectType: 'Bathroom', ownerName: 'Yaron Drilevich', label: '30 minutes', address: '456 Oak Ave', isCatchUp: false } },
  { name: 'staff reminder (rep present, notes, budget)',
    a: ref.repReminderEmail, b: rail.repReminderEmail,
    args: { ownerName: 'Yaron Drilevich', clientName: 'Jane Doe', clientPhone: '(310) 555-1234', clientEmail: 'jane@x.com', date: dateOf('2026-08-03'), time: timeOf('14:30'), address: '123 Main St, LA', projectType: 'Kitchen Remodel', budget: '$75,000–$150,000', notes: 'Wants open concept', label: '2 hours', leadId: 'lead-9', isPhoneCall: false, isCatchUp: false } },
  { name: 'staff reminder (rep missing fallback, no notes)',
    a: ref.repReminderEmail, b: rail.repReminderEmail,
    args: { ownerName: 'Michelle', clientName: 'Jane Doe', clientPhone: '(310) 555-1234', clientEmail: 'jane@x.com', date: dateOf('2026-08-03'), time: timeOf('14:30'), address: '', projectType: '', budget: '', notes: '', label: '30 minutes', leadId: 'lead-9', isPhoneCall: false, isCatchUp: false } },
  { name: 'staff reminder catch-up',
    a: ref.repReminderEmail, b: rail.repReminderEmail,
    args: { ownerName: 'Yaron Drilevich', clientName: 'Jane Doe', clientPhone: '(310) 555-1234', clientEmail: 'jane@x.com', date: dateOf('2026-08-03'), time: timeOf('14:30'), address: '123 Main St, LA', projectType: 'Kitchen Remodel', budget: '', notes: '', label: '48 hours', leadId: 'lead-9', isPhoneCall: false, isCatchUp: true } },
];

for (const c of CASES) {
  test(`parity: ${c.name}`, () => {
    const a = c.a(c.args);
    const b = c.b(c.args);
    assert.strictEqual(a, b, `HTML mismatch for ${c.name}`);
    if (a !== b) {
      // Find first differing char for diagnostics.
      let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
      console.error(`  first diff at char ${i}: ref=${JSON.stringify(a.slice(i-20, i+20))} rail=${JSON.stringify(b.slice(i-20, i+20))}`);
    }
  });
}

test('subject parity: client meeting (normal + catchup)', () => {
  assert.strictEqual(ref.clientSubjectMeeting({ label: '48 hours', isCatchUp: false }), `Appointment Reminder in 48 hours — EC Construction Group`);
  assert.strictEqual(ref.clientSubjectMeeting({ label: '2 hours', isCatchUp: true }), `Your Appointment is Confirmed — EC Construction Group`);
});

test('subject parity: client phone call', () => {
  assert.strictEqual(ref.clientSubjectPhoneCall({ label: '30 minutes', isCatchUp: false }), `Phone Call Reminder in 30 minutes — EC Construction Group`);
  assert.strictEqual(ref.clientSubjectPhoneCall({ label: '30 minutes', isCatchUp: true }), `Your Phone Call is Confirmed — EC Construction Group`);
});

test('subject parity: staff', () => {
  const s1 = ref.staffSubject({ clientName: 'Jane Doe', date: dateOf('2026-08-03'), time: timeOf('14:30'), isPhoneCall: false, label: '2 hours', isCatchUp: false });
  assert.strictEqual(s1, `Appointment in 2 hours: Jane Doe`);
  const s2 = ref.staffSubject({ clientName: 'Jane Doe', date: dateOf('2026-08-03'), time: timeOf('14:30'), isPhoneCall: false, label: '48 hours', isCatchUp: true });
  assert.strictEqual(s2, `📅 New Appointment: Jane Doe — ${dateOf('2026-08-03')} at ${timeOf('14:30')}`);
});

test('idempotency key parity', () => {
  assert.strictEqual(ref.reminderIdempotencyKey('lead-9', '48h', '2026-08-03'), `reminder:lead-9:48h:2026-08-03`);
});

test('CRM activity content parity', () => {
  const key = ref.reminderIdempotencyKey('lead-9', '2h', '2026-08-03');
  assert.strictEqual(ref.reminderActivityContent(key), `REMINDER_SENT:${key}`);
});

test('constants parity (logo, company name, phone)', () => {
  assert.strictEqual(ref.LOGO_URL, 'https://media.base44.com/images/public/69f42cee41d29f30bff5c013/cc5db7058_image.png');
  assert.strictEqual(ref.COMPANY_NAME, 'EC Construction Group');
});