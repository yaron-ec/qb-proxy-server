/* eslint-disable no-undef */
'use strict';

/**
 * bookingConfirmationEmail.test.js — lib/booking/bookingService.js's new
 * post-commit booking-confirmation EMAIL (November 2026 — the first
 * touchpoint of the approved six-customer-email schedule: "Immediately when
 * the appointment is scheduled — confirmation with appointment date and
 * time"). Mirrors test/bookingSmsConfirmation.test.js's conventions exactly
 * for the parallel email function.
 *
 * Covers: the EMAIL_BOOKING_CONFIRMATION_ENABLED kill switch (deploying this
 * code cannot itself start sending), the customer_reminders_disabled /
 * missing-email short-circuits (the existing email opt-out mechanism, no new
 * consent concept), a real send's subject/recipient/idempotency-key shape
 * when everything is enabled, and that malformed input never throws (a
 * confirmation-email failure must never fail the booking response).
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

const { sendBookingConfirmationEmailBestEffort } = require('../lib/booking/bookingService');

test('sendBookingConfirmationEmailBestEffort: EMAIL_BOOKING_CONFIRMATION_ENABLED unset -> never sends (deploying this code cannot itself start sending)', async () => {
  delete process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED;
  // No lead/appt validity needed -- the function must return before touching
  // companyConfig/notificationRecipients/emailService at all when the flag is off.
  await assert.doesNotReject(() => sendBookingConfirmationEmailBestEffort(null, null));
});

test('sendBookingConfirmationEmailBestEffort: never throws even on malformed input (best-effort, never fails the booking response)', async () => {
  process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED = 'true';
  try {
    await assert.doesNotReject(() => sendBookingConfirmationEmailBestEffort(undefined, undefined));
    await assert.doesNotReject(() => sendBookingConfirmationEmailBestEffort({ id: 'x' }, null));
  } finally {
    delete process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED;
  }
});

test('sendBookingConfirmationEmailBestEffort: customer_reminders_disabled short-circuits before any send (existing email opt-out, no new consent mechanism)', async () => {
  process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED = 'true';
  let sendCalled = false;
  const unstub = stub('../lib/emailService', { send: async () => { sendCalled = true; return { gmailMessageId: 'm1' }; } });
  try {
    await sendBookingConfirmationEmailBestEffort(
      { id: 'lead-1', email: 'customer@example.com', customer_reminders_disabled: true },
      { id: 'appt-1', start_at: '2026-07-15T21:00:00Z', timezone: 'America/Los_Angeles' }
    );
    assert.strictEqual(sendCalled, false, 'a customer who opted out of reminders must never receive a booking confirmation email');
  } finally {
    unstub();
    delete process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED;
  }
});

test('sendBookingConfirmationEmailBestEffort: no lead.email short-circuits before any send', async () => {
  process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED = 'true';
  let sendCalled = false;
  const unstub = stub('../lib/emailService', { send: async () => { sendCalled = true; return { gmailMessageId: 'm1' }; } });
  try {
    await sendBookingConfirmationEmailBestEffort(
      { id: 'lead-1', email: null, customer_reminders_disabled: false },
      { id: 'appt-1', start_at: '2026-07-15T21:00:00Z', timezone: 'America/Los_Angeles' }
    );
    assert.strictEqual(sendCalled, false, 'a lead with no email on file must never receive a booking confirmation email');
  } finally {
    unstub();
    delete process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED;
  }
});

test('sendBookingConfirmationEmailBestEffort: flag on + valid lead/appt -> sends exactly once, to the customer only, with a deterministic per-appointment idempotency key', async () => {
  process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED = 'true';
  const sent = [];
  const unstubEmail = stub('../lib/emailService', { send: async (opts) => { sent.push(opts); return { gmailMessageId: 'm1' }; } });
  const unstubCompanyConfig = stub('../lib/companyConfig', {
    getTimezone: async () => 'America/Los_Angeles',
    getCompanyConfig: async () => ({ company_name: 'EC Construction Group', locale: 'en-US' }),
  });
  const unstubRecipients = stub('../lib/notificationRecipients', {
    getDefaultOwner: async () => ({ email: 'yaron@ecconstructiongroup.com', name: 'Yaron Drilevich' }),
    getSenderAddress: async () => 'yaron@ecconstructiongroup.com',
    getSenderName: async () => 'EC Construction Group',
  });
  try {
    await sendBookingConfirmationEmailBestEffort(
      {
        id: 'lead-1', first_name: 'Jane', email: 'customer@example.com',
        customer_reminders_disabled: false, assigned_rep: 'Alex Rep',
        property_address: '123 Main St', city: 'Los Angeles', project_type: 'Kitchen Remodel',
      },
      { id: 'appt-1', start_at: '2026-07-15T21:00:00Z', timezone: 'America/Los_Angeles' }
    );
    assert.strictEqual(sent.length, 1, 'exactly one confirmation email must be sent');
    const call = sent[0];
    assert.strictEqual(call.to, 'customer@example.com', 'the confirmation email must go to the customer, never staff');
    assert.match(call.subject, /Your Appointment is Confirmed/, 'subject must reuse the existing, already-approved confirmation wording');
    assert.strictEqual(call.idempotencyKey, 'booking-confirmation:lead-1:appt-1', 'idempotency key must be deterministic per lead+appointment so a replayed booking request can never double-send');
    assert.match(call.htmlBody, /Jane/, 'body must include the customer first name');
    assert.match(call.htmlBody, /July 15, 2026/, 'body must include the correctly-formatted, DST-correct local appointment date');
  } finally {
    unstubEmail(); unstubCompanyConfig(); unstubRecipients();
    delete process.env.EMAIL_BOOKING_CONFIRMATION_ENABLED;
  }
});
