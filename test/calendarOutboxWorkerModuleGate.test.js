/* eslint-disable no-undef */
'use strict';

/**
 * calendarOutboxWorkerModuleGate.test.js — PRODUCTIZATION: proves
 * scripts/calendarOutboxWorker.js#tick() never makes a real Google Calendar
 * or Google Contacts call when the respective module is disabled for this
 * installation, while unrelated work (legacy Phone Call conversion, a pure
 * CRM data-cleanup step with no external call) still runs regardless. Also
 * proves main() no longer hard-requires GOOGLE_SERVICE_ACCOUNT_KEY for an
 * installation that uses neither Google module (previously crash-looped).
 *
 * All dependencies mocked via require.cache substitution — no live DB, no
 * live Google.
 */
const test = require('node:test');
const assert = require('node:assert');

const calls = { calendarProcess: 0, contactsProcess: 0, legacyConversion: 0, followupReminders: 0, reconcile: 0 };
let isModuleEnabledImpl = async () => true;
let enabledModulesForMain = { google_calendar: true, google_contacts: true };

function resetCalls() { for (const k of Object.keys(calls)) calls[k] = 0; }

const dbPath = require.resolve('../db/client');
delete require.cache[dbPath];
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { pool: { end: async () => {}, query: async () => ({ rows: [] }) }, query: async () => ({ rows: [] }) },
};

const outboxPath = require.resolve('../lib/booking/calendarOutbox');
delete require.cache[outboxPath];
require.cache[outboxPath] = {
  id: outboxPath, filename: outboxPath, loaded: true,
  exports: {
    reapStuck: async () => {},
    claimAndProcess: async () => { calls.calendarProcess++; return { claimed: 0, processed: 0 }; },
    reconcileSyncedAppointments: async () => { calls.reconcile++; return { checked: 0 }; },
  },
};

const contactsOutboxPath = require.resolve('../lib/googleContactsOutbox');
delete require.cache[contactsOutboxPath];
require.cache[contactsOutboxPath] = {
  id: contactsOutboxPath, filename: contactsOutboxPath, loaded: true,
  exports: {
    ensureContactsOutbox: async () => {},
    reapStuckContacts: async () => {},
    processContactsOutbox: async () => { calls.contactsProcess++; return { claimed: 0 }; },
  },
};

const followUpRemindersPath = require.resolve('../lib/booking/followUpReminders');
delete require.cache[followUpRemindersPath];
require.cache[followUpRemindersPath] = {
  id: followUpRemindersPath, filename: followUpRemindersPath, loaded: true,
  exports: { reconcileFollowUpReminders: async () => { calls.followupReminders++; return { desired: 0, upserted: 0, removed: 0, expired: 0, unchanged: 0, errors: 0 }; } },
};

const legacyConversionPath = require.resolve('../lib/booking/legacyPhoneCallConversion');
delete require.cache[legacyConversionPath];
require.cache[legacyConversionPath] = {
  id: legacyConversionPath, filename: legacyConversionPath, loaded: true,
  exports: { convertLegacyPhoneCallAppointments: async () => { calls.legacyConversion++; return { candidates: 0 }; } },
};

const companyConfigPath = require.resolve('../lib/companyConfig');
delete require.cache[companyConfigPath];
require.cache[companyConfigPath] = {
  id: companyConfigPath, filename: companyConfigPath, loaded: true,
  exports: {
    isModuleEnabled: (...a) => isModuleEnabledImpl(...a),
    getCompanyConfig: async () => ({ enabled_modules: enabledModulesForMain }),
  },
};

// FOLLOWUP_REMINDERS_EVERY_N_TICKS/RECONCILE_EVERY_N_TICKS are read once at
// module load from these env vars — force both to 1 so section 3/4's
// "every N ticks" gate never skips a tick based on internal counter state
// carrying over between this file's separate test() calls.
process.env.FOLLOWUP_REMINDER_INTERVAL = '1';
process.env.CALENDAR_RECONCILE_INTERVAL = '1';
delete require.cache[require.resolve('../scripts/calendarOutboxWorker')];
const { tick } = require('../scripts/calendarOutboxWorker');

test('both Google modules disabled: no calendar/contacts/reminder-reconcile calls; legacy conversion still runs', async () => {
  resetCalls();
  isModuleEnabledImpl = async (key) => false;
  await tick('test-worker', { batchSize: 10, leaseMs: 60000 });
  assert.strictEqual(calls.calendarProcess, 0);
  assert.strictEqual(calls.contactsProcess, 0);
  assert.strictEqual(calls.followupReminders, 0, 'follow-up reminder reconciliation calls Google — must not run when google_calendar is disabled');
  assert.strictEqual(calls.legacyConversion, 1, 'legacy phone-call conversion is pure CRM data cleanup, no external call — must still run');
});

test('google_calendar enabled, google_contacts disabled: only calendar processing runs', async () => {
  resetCalls();
  isModuleEnabledImpl = async (key) => key === 'google_calendar';
  await tick('test-worker', { batchSize: 10, leaseMs: 60000 });
  assert.strictEqual(calls.calendarProcess, 1);
  assert.strictEqual(calls.contactsProcess, 0);
  assert.strictEqual(calls.followupReminders, 1);
});

test('google_contacts enabled, google_calendar disabled: only contacts processing runs', async () => {
  resetCalls();
  isModuleEnabledImpl = async (key) => key === 'google_contacts';
  await tick('test-worker', { batchSize: 10, leaseMs: 60000 });
  assert.strictEqual(calls.calendarProcess, 0);
  assert.strictEqual(calls.contactsProcess, 1);
  assert.strictEqual(calls.followupReminders, 0);
});

test('both enabled (EC\'s exact production shape): everything runs, matching pre-productization behavior', async () => {
  resetCalls();
  isModuleEnabledImpl = async () => true;
  await tick('test-worker', { batchSize: 10, leaseMs: 60000 });
  assert.strictEqual(calls.calendarProcess, 1);
  assert.strictEqual(calls.contactsProcess, 1);
  assert.strictEqual(calls.followupReminders, 1);
  assert.strictEqual(calls.legacyConversion, 1);
});

test('main(): neither Google module enabled + no GOOGLE_SERVICE_ACCOUNT_KEY -> does not exit(1) on the Google check', async () => {
  enabledModulesForMain = { google_calendar: false, google_contacts: false };
  const originalKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const originalDbUrl = process.env.DATABASE_URL;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  process.env.DATABASE_URL = 'postgres://fake/for-this-test-only';
  const originalExit = process.exit;
  const exitCodes = [];
  process.exit = (code) => { exitCodes.push(code); throw new Error('__exit__'); };
  const originalArgv = process.argv;
  process.argv = [...process.argv, '--once'];
  try {
    const { main } = require('../scripts/calendarOutboxWorker');
    await main();
  } catch (e) {
    if (e.message !== '__exit__') throw e;
  } finally {
    process.exit = originalExit;
    process.argv = originalArgv;
    if (originalKey !== undefined) process.env.GOOGLE_SERVICE_ACCOUNT_KEY = originalKey;
    if (originalDbUrl !== undefined) process.env.DATABASE_URL = originalDbUrl; else delete process.env.DATABASE_URL;
  }
  assert.deepStrictEqual(exitCodes, [], 'must never call process.exit when neither Google module needs the credential');
});
