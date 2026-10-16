/* eslint-disable no-undef */
'use strict';

/**
 * actionRouterRescheduleRecipientFilter.test.js — structural guard: the
 * customer "Reschedule Request" notification's primary recipient
 * (lib/actionRouter.js, POST /r/reschedule/:token) previously came straight
 * from notificationRecipients.getPrimaryRecipient() — unconditionally
 * Michelle for EC, regardless of her per-category notification preferences.
 * It must now be narrowed through
 * lib/notificationPreferences.js#filterRecipientsForCategory(APPOINTMENT)
 * first, the same category lib/reminderNotifications.js already applies to
 * this same "reschedule" notification's cc list on flush.
 *
 * A full HTTP-level test of this route needs a live token store + Postgres
 * (see test/integration/*.int.test.js for that style); this is a fast,
 * dependency-free source check that the fix is actually wired, not removed
 * by a later edit.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'actionRouter.js'), 'utf8');

test('actionRouter.js requires notificationPreferences', () => {
  assert.ok(/require\(['"]\.\/notificationPreferences['"]\)/.test(SRC));
});

test('the reschedule notification\'s recipientEmails is narrowed by filterRecipientsForCategory(APPOINTMENT) before use, not a raw getPrimaryRecipient()', () => {
  const idx = SRC.indexOf("recipientEmails: appointmentStaff[0]");
  assert.ok(idx > -1, 'recipientEmails must be built from a category-filtered staff list');
  const before = SRC.slice(Math.max(0, idx - 400), idx);
  assert.ok(/filterRecipientsForCategory/.test(before), 'the staff list feeding recipientEmails must pass through filterRecipientsForCategory');
  assert.ok(/CATEGORIES\.APPOINTMENT/.test(before), 'must use the APPOINTMENT category — same one reminderNotifications.js applies to this same notification type\'s cc list');
});

test('getPrimaryRecipient() (the old, unfiltered single-address source) is no longer used for the reschedule recipient', () => {
  assert.ok(!/recipientEmails:\s*await notificationRecipients\.getPrimaryRecipient\(\)/.test(SRC));
});
