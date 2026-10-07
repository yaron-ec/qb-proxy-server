/* eslint-disable no-undef */
'use strict';

/**
 * companyConfigContract.test.js — unit coverage for
 * scripts/install/companyConfigContract.js, the canonical installation
 * config contract (PRODUCTIZATION — Company Provisioning System).
 */
const test = require('node:test');
const assert = require('node:assert');
const contract = require('../scripts/install/companyConfigContract');

function validConfig(overrides = {}) {
  return {
    company_name: 'Acme Remodeling',
    company_slug: 'acme-remodeling',
    admin_email: 'jordan@acme.example',
    admin_password: 'a-genuinely-long-password-123',
    frontend_url: 'https://crm.acme.example',
    backend_url: 'https://acme-api.up.railway.app',
    ...overrides,
  };
}

test('validateConfig: a minimal valid config passes with no errors', () => {
  const r = contract.validateConfig(validConfig());
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validateConfig: missing company_name, admin_email, admin_password, frontend_url, backend_url, company_slug all reported', () => {
  const r = contract.validateConfig({});
  assert.strictEqual(r.ok, false);
  const fields = r.errors.map((e) => e.field);
  for (const required of ['company_name', 'company_slug', 'admin_email', 'admin_password', 'frontend_url', 'backend_url']) {
    assert.ok(fields.includes(required), `expected a missing-field error for "${required}", got: ${fields.join(', ')}`);
  }
});

test('validateConfig: admin_password shorter than 12 chars fails', () => {
  const r = contract.validateConfig(validConfig({ admin_password: 'short' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'admin_password'));
});

test('validateConfig: malformed company_slug (uppercase/spaces) fails', () => {
  const r = contract.validateConfig(validConfig({ company_slug: 'Acme Remodeling!' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'company_slug'));
});

test('validateConfig: invalid frontend_url/backend_url fails', () => {
  const r = contract.validateConfig(validConfig({ frontend_url: 'not-a-url' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'frontend_url'));
});

test('validateConfig: invalid timezone fails', () => {
  const r = contract.validateConfig(validConfig({ timezone: 'Not/A/Zone' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'timezone'));
});

test('validateConfig: invalid currency code fails', () => {
  const r = contract.validateConfig(validConfig({ currency: 'dollars' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'currency'));
});

test('validateConfig: a non-boolean enabled_modules value fails', () => {
  const r = contract.validateConfig(validConfig({ enabled_modules: { quickbooks: 'yes' } }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'enabled_modules'));
});

test('validateConfig: an unknown enabled_modules key fails', () => {
  const r = contract.validateConfig(validConfig({ enabled_modules: { not_a_real_module: true } }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'enabled_modules'));
});

test('validateConfig: at least one contact email is required even when admin_email is set elsewhere is fine, but all three absent fails', () => {
  const cfg = validConfig();
  delete cfg.admin_email; // remove the one contact email this config had
  const r = contract.validateConfig(cfg);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === 'default_owner_email'));
});

test('validateConfig: enabling a module with missing env vars produces a WARNING, never an error', () => {
  const r = contract.validateConfig(validConfig({ enabled_modules: { quickbooks: true } }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.field === 'enabled_modules.quickbooks'));
});

test('computeCallbackUrls: QuickBooks callback is on the FRONTEND url (qb-callback page), matching routes/auth.js/App.jsx reality', () => {
  const urls = contract.computeCallbackUrls(validConfig());
  assert.strictEqual(urls.quickbooks.callback_url, 'https://crm.acme.example/qb-callback');
});

test('computeCallbackUrls: Gmail OAuth callback is on the BACKEND url, matching lib/gmailOAuthRouter.js mount path', () => {
  const urls = contract.computeCallbackUrls(validConfig());
  assert.strictEqual(urls.gmail.callback_url, 'https://acme-api.up.railway.app/internal/gmail/oauth/callback');
});

test('computeCallbackUrls: Meta webhook and website-intake webhook are on the BACKEND url, matching server.js mount paths', () => {
  const urls = contract.computeCallbackUrls(validConfig());
  assert.strictEqual(urls.meta.callback_url, 'https://acme-api.up.railway.app/api/v1/meta-webhook');
  assert.strictEqual(urls.website_intake.callback_url, 'https://acme-api.up.railway.app/api/v1/website-leads');
});

test('computeCallbackUrls: Google Calendar/Contacts and SignNow/Handoff have no callback URL (admin-console/API-key authorization, not browser OAuth)', () => {
  const urls = contract.computeCallbackUrls(validConfig());
  for (const key of ['google_calendar', 'google_contacts', 'signnow', 'handoff', 'sms']) {
    assert.strictEqual(urls[key].callback_url, null, `expected ${key} to have no callback URL`);
  }
});

test('MODULE_KEYS matches the keys of MODULES exactly (no drift)', () => {
  assert.deepStrictEqual([...contract.MODULE_KEYS].sort(), Object.keys(contract.MODULES).sort());
});

test('every FIELD_SPECS entry has a unique key', () => {
  const keys = contract.FIELD_SPECS.map((s) => s.key);
  assert.strictEqual(new Set(keys).size, keys.length);
});
