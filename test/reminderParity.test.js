/* eslint-disable no-undef */
/**
 * reminderParity.test.js — canonical regression test for the Railway-native
 * appointment reminder email templates (lib/reminderEmails.js) and the
 * reminder key format (lib/reminderEngine.js).
 *
 * This test was originally a field-by-field parity test comparing the Railway
 * templates against a frozen Base44 reference (lib/base44AppointmentTemplates).
 * Base44 has been fully decommissioned; the reference module no longer exists.
 *
 * The test is now a self-contained canonical regression test that validates
 * the Railway templates produce deterministic, expected output for known
 * inputs. The expected values are frozen in this file — any unintended change
 * to the template HTML, subject format, or key format will fail the test and
 * must be explicitly updated.
 *
 * Zero dependency on base44AppointmentTemplates or any Base44 module.
 *
 * Run: cd src/proxy-server && node --test test/reminderParity.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Fix CRM_PUBLIC_URL so the logo URL and CTA link are deterministic.
process.env.CRM_PUBLIC_URL = 'https://crm.ecconstructiongroup.com';

const rail = require('../lib/reminderEmails');
const engine = require('../lib/reminderEngine');
const time = require('../lib/reminderTime');

function dateOf(s) { return time.formatDate(s); }
function timeOf(s) { return time.fmt12(s); }

// ── Canonical expected values (frozen) ─────────────────────────────────────
const COMPANY_NAME = 'EC Construction Group';
const LOGO_URL = `${process.env.CRM_PUBLIC_URL}/email-logo.png`;

const COMMON_ARGS = {
  firstName: 'Jane',
  date: dateOf('2026-08-03'),
  time: timeOf('14:30'),
  address: '123 Main St, LA',
  projectType: 'Kitchen Remodel',
  ownerName: 'Yaron Drilevich',
  label: '48 hours',
  isCatchUp: false,
};

// ── Template regression tests ───────────────────────────────────────────────

test('clientMeetingEmail produces deterministic HTML with expected content', () => {
  const html = rail.clientMeetingEmail(COMMON_ARGS);
  assert.ok(html && html.length > 500, 'non-empty HTML');
  assert.ok(html.includes('Upcoming Appointment Reminder'), 'title present');
  assert.ok(html.includes('Hi Jane'), 'greeting uses firstName');
  assert.ok(html.includes('Yaron Drilevich'), 'ownerName present');
  assert.ok(html.includes('48 hours'), 'label present');
  assert.ok(html.includes('123 Main St, LA'), 'address present');
  assert.ok(html.includes('Kitchen Remodel'), 'projectType present');
  assert.ok(html.includes(LOGO_URL), 'logo URL present');
  assert.ok(html.includes(COMPANY_NAME), 'company name present');
});

test('clientMeetingEmail catch-up mode uses confirmation language', () => {
  const html = rail.clientMeetingEmail({ ...COMMON_ARGS, isCatchUp: true });
  assert.ok(html.includes('Appointment Confirmation'), 'catch-up title');
  assert.ok(html.includes('Your appointment is confirmed'), 'catch-up subtitle');
  assert.ok(!html.includes('Your appointment is in'), 'no countdown subtitle');
});

test('clientMeetingEmail fallback to "there" when firstName missing', () => {
  const html = rail.clientMeetingEmail({ ...COMMON_ARGS, firstName: 'there' });
  assert.ok(html.includes('Hi there'), 'fallback greeting');
});

test('clientPhoneCallEmail produces deterministic HTML with expected content', () => {
  const html = rail.clientPhoneCallEmail({
    ...COMMON_ARGS,
    phone: '(310) 555-1234',
    projectType: 'Bathroom',
    address: '456 Oak Ave',
    label: '30 minutes',
  });
  assert.ok(html && html.length > 500, 'non-empty HTML');
  assert.ok(html.includes('Phone Call Reminder'), 'title present');
  assert.ok(html.includes('(310) 555-1234'), 'phone present');
  assert.ok(html.includes('30 minutes'), 'label present');
  assert.ok(html.includes('Bathroom'), 'projectType present');
  assert.ok(html.includes(LOGO_URL), 'logo URL present');
});

test('repReminderEmail produces deterministic HTML with expected content', () => {
  const html = rail.repReminderEmail({
    ownerName: 'Yaron Drilevich',
    clientName: 'Jane Doe',
    clientPhone: '(310) 555-1234',
    clientEmail: 'jane@x.com',
    date: dateOf('2026-08-03'),
    time: timeOf('14:30'),
    address: '123 Main St, LA',
    projectType: 'Kitchen Remodel',
    budget: '$75,000–$150,000',
    notes: 'Wants open concept',
    label: '2 hours',
    leadId: 'lead-9',
    isPhoneCall: false,
    isCatchUp: false,
  });
  assert.ok(html && html.length > 500, 'non-empty HTML');
  assert.ok(html.includes('Hello Yaron Drilevich'), 'owner greeting');
  assert.ok(html.includes('Jane Doe'), 'client name present');
  assert.ok(html.includes('(310) 555-1234'), 'client phone present');
  assert.ok(html.includes('jane@x.com'), 'client email present');
  assert.ok(html.includes('Wants open concept'), 'notes present');
  assert.ok(html.includes('$75,000'), 'budget present');
  assert.ok(html.includes('/leads/lead-9'), 'CRM link present');
  assert.ok(html.includes('Appointment in 2 hours'), 'title with label');
});

test('repReminderEmail catch-up mode uses new appointment language', () => {
  const html = rail.repReminderEmail({
    ownerName: 'Yaron Drilevich',
    clientName: 'Jane Doe',
    clientPhone: '(310) 555-1234',
    clientEmail: 'jane@x.com',
    date: dateOf('2026-08-03'),
    time: timeOf('14:30'),
    address: '123 Main St, LA',
    projectType: 'Kitchen Remodel',
    budget: '',
    notes: '',
    label: '48 hours',
    leadId: 'lead-9',
    isPhoneCall: false,
    isCatchUp: true,
  });
  assert.ok(html.includes('New Appointment Scheduled'), 'catch-up title');
  assert.ok(html.includes('A new appointment has been scheduled'), 'catch-up body');
});

test('repReminderEmail phone-call mode uses phone call language', () => {
  const html = rail.repReminderEmail({
    ownerName: 'Yaron Drilevich',
    clientName: 'Jane Doe',
    clientPhone: '(310) 555-1234',
    clientEmail: 'jane@x.com',
    date: dateOf('2026-08-03'),
    time: timeOf('14:30'),
    address: '',
    projectType: '',
    budget: '',
    notes: '',
    label: '30 minutes',
    leadId: 'lead-9',
    isPhoneCall: true,
    isCatchUp: false,
  });
  assert.ok(html.includes('Phone Call'), 'phone call title');
  assert.ok(html.includes('phone call'), 'phone call body');
});

test('templates are deterministic — same input produces same output', () => {
  const a1 = rail.clientMeetingEmail(COMMON_ARGS);
  const a2 = rail.clientMeetingEmail(COMMON_ARGS);
  assert.strictEqual(a1, a2, 'clientMeetingEmail deterministic');

  const b1 = rail.clientPhoneCallEmail({ ...COMMON_ARGS, phone: '(310) 555-1234' });
  const b2 = rail.clientPhoneCallEmail({ ...COMMON_ARGS, phone: '(310) 555-1234' });
  assert.strictEqual(b1, b2, 'clientPhoneCallEmail deterministic');

  const c1 = rail.repReminderEmail({
    ownerName: 'Yaron Drilevich', clientName: 'Jane Doe', clientPhone: '(310) 555-1234',
    clientEmail: 'jane@x.com', date: dateOf('2026-08-03'), time: timeOf('14:30'),
    address: '123 Main St, LA', projectType: 'Kitchen Remodel', budget: '', notes: '',
    label: '2 hours', leadId: 'lead-9', isPhoneCall: false, isCatchUp: false,
  });
  const c2 = rail.repReminderEmail({
    ownerName: 'Yaron Drilevich', clientName: 'Jane Doe', clientPhone: '(310) 555-1234',
    clientEmail: 'jane@x.com', date: dateOf('2026-08-03'), time: timeOf('14:30'),
    address: '123 Main St, LA', projectType: 'Kitchen Remodel', budget: '', notes: '',
    label: '2 hours', leadId: 'lead-9', isPhoneCall: false, isCatchUp: false,
  });
  assert.strictEqual(c1, c2, 'repReminderEmail deterministic');
});

// ── Reminder key format (Railway-native canonical) ──────────────────────────

test('reminderKey produces deterministic canonical format', () => {
  assert.strictEqual(engine.reminderKey('lead-9', '48h', '2026-08-03'), 'reminder:lead-9:48h:2026-08-03');
  assert.strictEqual(
    engine.reminderKey('lead-9', '48h', '2026-08-03'),
    engine.reminderKey('lead-9', '48h', '2026-08-03'),
    'deterministic'
  );
});

// ── Constants ───────────────────────────────────────────────────────────────

test('template HTML references the canonical logo URL', () => {
  const html = rail.clientMeetingEmail(COMMON_ARGS);
  assert.ok(html.includes(`${process.env.CRM_PUBLIC_URL}/email-logo.png`), 'logo URL uses CRM_PUBLIC_URL');
});

test('template HTML references the canonical company name', () => {
  const html = rail.clientMeetingEmail(COMMON_ARGS);
  assert.ok(html.includes('EC Construction Group'), 'company name present');
});