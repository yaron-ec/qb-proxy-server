/* eslint-disable no-undef */
'use strict';

/**
 * companyConfig.test.js — regression coverage for lib/companyConfig.js, the
 * productization foundation's single read path for per-installation config.
 *
 * Verifies: (1) an unbootstrapped database (no company_settings row) returns
 * PRODUCT_DEFAULTS — a company_settings.timezone equal to today's hardcoded
 * 'America/Los_Angeles' so existing behavior is unchanged; (2) a real row
 * overrides defaults field-by-field, never leaving a key undefined;
 * (3) getCompanyEmailDomain() derives a domain from company_email/admin_email
 * and NEVER invents one; (4) isModuleEnabled() reads enabled_modules
 * correctly; (5) invalidate() forces a fresh read (proves the cache doesn't
 * hide a just-saved change from routes/companySettings.js's PUT handler).
 *
 * DB access is mocked (require.cache substitution for db/client) — no live
 * database is used or required.
 */
const test = require('node:test');
const assert = require('node:assert');

const dbPath = require.resolve('../db/client');
let queryImpl = async () => ({ rows: [] });
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { query: (...a) => queryImpl(...a), pool: { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) } },
};

const { getCompanyConfig, getTimezone, getCompanyEmailDomain, isModuleEnabled, invalidate, PRODUCT_DEFAULTS } = require('../lib/companyConfig');

test.beforeEach(() => { invalidate(); });

test('no company_settings row (unbootstrapped DB) → PRODUCT_DEFAULTS, timezone matches historical hardcoded value', async () => {
  queryImpl = async () => ({ rows: [] });
  const c = await getCompanyConfig();
  assert.strictEqual(c.timezone, 'America/Los_Angeles');
  assert.strictEqual(c.timezone, PRODUCT_DEFAULTS.timezone);
  assert.strictEqual(c.appointment_travel_buffer_minutes, 60);
  assert.strictEqual(c.company_name, null);
  assert.deepStrictEqual(c.enabled_modules, PRODUCT_DEFAULTS.enabled_modules);
});

test('a real company_settings row overrides defaults; every key still present', async () => {
  queryImpl = async () => ({ rows: [{
    company_name: 'Acme Remodeling', legal_name: 'Acme Remodeling LLC', dba: null,
    company_email: 'hello@acme.example', admin_email: 'admin@acme.example',
    timezone: 'America/New_York', locale: 'en-US', appointment_travel_buffer_minutes: 45,
    business_hours: { mon: '9-5' }, enabled_modules: { quickbooks: true, gmail: false },
    installation_id: '11111111-1111-1111-1111-111111111111',
  }] });
  const c = await getCompanyConfig();
  assert.strictEqual(c.company_name, 'Acme Remodeling');
  assert.strictEqual(c.timezone, 'America/New_York');
  assert.strictEqual(c.appointment_travel_buffer_minutes, 45);
  assert.strictEqual(c.installation_id, '11111111-1111-1111-1111-111111111111');
  assert.strictEqual((await getTimezone()), 'America/New_York');
});

test('getCompanyEmailDomain derives from company_email, falls back to admin_email, never invents one', async () => {
  queryImpl = async () => ({ rows: [{ company_email: 'hello@acme.example', admin_email: 'admin@other.example' }] });
  assert.strictEqual(await getCompanyEmailDomain(), 'acme.example');

  invalidate();
  queryImpl = async () => ({ rows: [{ company_email: null, admin_email: 'admin@only.example' }] });
  assert.strictEqual(await getCompanyEmailDomain(), 'only.example');

  invalidate();
  queryImpl = async () => ({ rows: [{ company_email: null, admin_email: null }] });
  assert.strictEqual(await getCompanyEmailDomain(), null, 'must never fabricate a domain when nothing is configured');
});

test('isModuleEnabled reads enabled_modules; an unconfigured key is false, never a crash', async () => {
  queryImpl = async () => ({ rows: [{ enabled_modules: { quickbooks: true } }] });
  assert.strictEqual(await isModuleEnabled('quickbooks'), true);
  assert.strictEqual(await isModuleEnabled('meta'), false);
  assert.strictEqual(await isModuleEnabled('not_a_real_module'), false);
});

test('invalidate() forces a fresh read — a save is visible immediately, not after the cache window', async () => {
  let calls = 0;
  queryImpl = async () => { calls++; return { rows: [{ company_name: `call-${calls}` }] }; };
  const before = await getCompanyConfig();
  assert.strictEqual(before.company_name, 'call-1');
  const cachedAgain = await getCompanyConfig();
  assert.strictEqual(cachedAgain.company_name, 'call-1', 'within the cache window, no new query');
  invalidate();
  const after = await getCompanyConfig();
  assert.strictEqual(after.company_name, 'call-2', 'after invalidate(), a fresh row is read');
});

test('a slow read in flight when invalidate() fires never repopulates the cache with stale data', async () => {
  // Reproduces a real race: request A starts reading company_settings (slow
  // query), request B saves a change and calls invalidate() before A's query
  // resolves. A's own return value is necessarily the pre-save snapshot (it
  // already started), but A must NEVER let that stale result win the cache
  // for every subsequent reader — that would silently hide B's save for up to
  // CACHE_MS.
  let resolveSlowQuery;
  const slowQuery = new Promise((resolve) => { resolveSlowQuery = resolve; });
  queryImpl = async () => { await slowQuery; return { rows: [{ company_name: 'stale-before-save' }] }; };

  const slowRead = getCompanyConfig(); // in flight, not yet resolved

  invalidate(); // a concurrent save fires while the slow read is still pending
  queryImpl = async () => ({ rows: [{ company_name: 'fresh-after-save' }] });

  resolveSlowQuery();
  const slowResult = await slowRead;
  assert.strictEqual(slowResult.company_name, 'stale-before-save', "the in-flight read's own return value reflects its own snapshot");

  const nextRead = await getCompanyConfig();
  assert.strictEqual(nextRead.company_name, 'fresh-after-save',
    "the stale in-flight read must not have repopulated the cache — the next caller must see the save, not the race loser's snapshot");
});
