/* eslint-disable no-undef */
'use strict';

/**
 * reminderChannelControlsEmailGate.test.js — CRM repair item 10 (November
 * 2026): source-level proof that lib/reminderEngine.js's appointment/
 * phone-call-follow-up email loop and lib/phoneCallReminders.js both
 * respect the new Email-specific "Customer Reminders" override
 * (customer_email_reminders_disabled) in addition to the existing Master
 * control (customer_reminders_disabled) — direct-call unit testing isn't
 * practical here (sendWindowEmails/the phone-call loop also drive Gmail/
 * activity-logging/claim bookkeeping), so this proves the exact gating
 * expression exists, the same convention already used elsewhere in this
 * suite for reminderEngine.js internals (e.g.
 * test/reminderEngineSmsSkipReason.test.js). The SMS-side gate (a single
 * central choke point, lib/smsService.js#sendSms) IS proven end-to-end
 * against real Postgres in
 * test/integration/customerReminderChannelControls.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function src(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

test('reminderEngine.js: sendCustomer is gated on BOTH customer_reminders_disabled (Master) AND customer_email_reminders_disabled (Email-specific)', () => {
  const s = src('lib/reminderEngine.js');
  assert.match(s, /const customerRemindersFullyDisabled = !!lead\.customer_reminders_disabled \|\| !!lead\.customer_email_reminders_disabled;/);
  assert.match(s, /const sendCustomer = !customerRemindersFullyDisabled && !!lead\.email;/);
});

test('phoneCallReminders.js: the customer email send is gated on BOTH customer_reminders_disabled and customer_email_reminders_disabled', () => {
  const s = src('lib/phoneCallReminders.js');
  assert.match(s, /if \(!lead\.customer_reminders_disabled && !lead\.customer_email_reminders_disabled && lead\.email\)/);
});

test('lib/booking/bookingService.js: sendBookingConfirmationEmailBestEffort checks both flags', () => {
  const s = src('lib/booking/bookingService.js');
  assert.match(s, /if \(!lead \|\| !lead\.email \|\| lead\.customer_reminders_disabled \|\| lead\.customer_email_reminders_disabled\) return;/);
});

test('lib/smsService.js: sendSms gates automated-reminder sends on Master OR the SMS-specific flag, scoped to REMINDER_SMS_SENDERS only', () => {
  const s = src('lib/smsService.js');
  assert.match(s, /REMINDER_SMS_SENDERS\.has\(sentBy\) && \(leadRow\.customer_reminders_disabled \|\| leadRow\.customer_sms_reminders_disabled\)/);
  // Every known automated-reminder sender literal this codebase actually uses must be in the set.
  for (const sender of ['system:booking_confirmation', 'system:reminder_12h', 'system:reminder_12h_deferred', 'system:reminder_2h', 'system:reminder_2h_deferred']) {
    assert.ok(s.includes(`'${sender}'`), `REMINDER_SMS_SENDERS must include "${sender}"`);
  }
});

test('the reminder_leads/test_leads projection carries customer_email_reminders_disabled (lib/reminderProjection.js, lib/leadIngest.js, lib/crmRepository.js) — otherwise the Email-specific flag would never reach reminderEngine.js at all', () => {
  assert.match(src('lib/reminderProjection.js'), /customer_email_reminders_disabled: leadRow\.customer_email_reminders_disabled,/);
  assert.match(src('lib/leadIngest.js'), /customer_email_reminders_disabled: boolish\(input\.customer_email_reminders_disabled\),/);
  assert.match(src('lib/crmRepository.js'), /rl\.customer_email_reminders_disabled/);
  assert.match(src('lib/crmRepository.js'), /notes, customer_reminders_disabled, customer_email_reminders_disabled, crm_created_date\s*\n\s*FROM test_leads/);
});
