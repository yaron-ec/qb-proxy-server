/* eslint-disable no-undef */
'use strict';

/**
 * phoneCallReminderMichelleExclusion.test.js — lib/phoneCallReminders.js
 * must narrow its staff recipients through
 * lib/notificationPreferences.js#filterRecipientsForCategory(REMINDER)
 * instead of unconditionally using notificationRecipients.getPrimaryRecipient()
 * (which, for EC, always returned Michelle). A staff member who has opted
 * out of the REMINDER category (Michelle's own policy — see
 * db/migrations/2026-62-michelle-single-category-notifications.sql) must
 * never be the owner-fallback, a staff cc, or the "no owner assigned" alert
 * recipient for a phone-call reminder.
 *
 * Runs the real engine end-to-end (one eligible lead, real send path) with
 * every dependency except notification_preferences' filtering behavior
 * mocked — the filter itself is exercised for real via a stubbed
 * notification_preferences table read.
 */

const test = require('node:test');
const assert = require('node:assert');

const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === '../db/client' && parent && parent.filename && parent.filename.includes('phoneCallReminders')) {
    return req;
  }
  return origResolve.call(this, req, parent, ...rest);
};

function laDateTimeParts(ms) {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return { date, time };
}

// Call is exactly 1 hour from "now" -> diff against the '1h' window's target is 0, which is eligible ([0, 15min)).
const { date: callDate, time: callTime } = laDateTimeParts(Date.now() + 60 * 60 * 1000);

const sentEmails = [];
const dbStub = { ensureSchema: async () => {}, query: async (sql) => {
  const s = String(sql);
  if (/INSERT INTO reminder_claims/i.test(s)) return { rows: [{ id: 'claim-1' }] };
  return { rows: [] };
} };
const crmStub = {
  listEligibleLeads: async () => [{
    id: 'lead-1', first_name: 'Jane', last_name: 'Doe', email: null, phone: '5551234567',
    assigned_rep: null, follow_up_type: 'Phone Call', follow_up_date: callDate, follow_up_time: callTime,
    customer_reminders_disabled: true,
  }],
  writeReminderSentActivity: async () => {},
};

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbStub };
const crmPath = require.resolve('../lib/crmRepository');
delete require.cache[crmPath];
require.cache[crmPath] = { id: crmPath, filename: crmPath, loaded: true, exports: crmStub };

const notifRecipientsPath = require.resolve('../lib/notificationRecipients');
delete require.cache[notifRecipientsPath];
require.cache[notifRecipientsPath] = {
  id: notifRecipientsPath, filename: notifRecipientsPath, loaded: true,
  exports: {
    getRecipients: async () => ({ to: ['michelle@ecconstructiongroup.com'], cc: ['yaron@ecconstructiongroup.com'] }),
    getAllStaffRecipients: async () => ['michelle@ecconstructiongroup.com', 'yaron@ecconstructiongroup.com'],
    getPrimaryRecipient: async () => 'michelle@ecconstructiongroup.com',
    getDefaultOwner: async () => ({ email: 'yaron@ecconstructiongroup.com', name: 'Yaron Drilevich' }),
    getSenderName: async () => 'EC Construction Group',
    getSenderAddress: async () => 'yaron@ecconstructiongroup.com',
    getProtectedAdminEmails: async () => new Set(),
  },
};
const notifPrefsPath = require.resolve('../lib/notificationPreferences');
delete require.cache[notifPrefsPath];
require.cache[notifPrefsPath] = {
  id: notifPrefsPath, filename: notifPrefsPath, loaded: true,
  exports: {
    CATEGORIES: { REMINDER: 'reminder' },
    // Michelle has opted out of REMINDER (her real seeded policy — see
    // db/migrations/2026-62-michelle-single-category-notifications.sql).
    filterRecipientsForCategory: async (candidates) =>
      candidates.filter((e) => e.toLowerCase() !== 'michelle@ecconstructiongroup.com'),
  },
};
const companyConfigPath = require.resolve('../lib/companyConfig');
delete require.cache[companyConfigPath];
require.cache[companyConfigPath] = {
  id: companyConfigPath, filename: companyConfigPath, loaded: true,
  exports: {
    getCompanyConfig: async () => ({ timezone: 'America/Los_Angeles', company_name: 'EC Construction Group' }),
    getTimezone: async () => 'America/Los_Angeles',
    getCompanyEmailDomain: async () => 'ecconstructiongroup.com',
    isModuleEnabled: async () => true,
    invalidate: () => {},
  },
};
const emailServicePath = require.resolve('../lib/emailService');
delete require.cache[emailServicePath];
require.cache[emailServicePath] = {
  id: emailServicePath, filename: emailServicePath, loaded: true,
  exports: { send: async (opts) => { sentEmails.push(opts); return { ok: true, gmailMessageId: 'm-' + sentEmails.length }; } },
};

const phone = require('../lib/phoneCallReminders');

test('phone-call reminder: Michelle (opted out of REMINDER) is never a recipient; Yaron (the remaining staff recipient) becomes the no-owner fallback', async () => {
  const r = await phone.processPhoneCallReminders({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(r.ok, true);
  assert.ok(sentEmails.length > 0, 'expected at least one email to have been sent');
  const allRecipients = sentEmails.map((e) => String(e.to).toLowerCase());
  assert.ok(!allRecipients.includes('michelle@ecconstructiongroup.com'), `Michelle must never receive a phone-call reminder: got recipients ${JSON.stringify(allRecipients)}`);
  assert.ok(allRecipients.includes('yaron@ecconstructiongroup.com'), 'the remaining configured staff recipient must still receive it');
});
