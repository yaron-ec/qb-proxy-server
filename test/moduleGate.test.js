/* eslint-disable no-undef */
/**
 * moduleGate.test.js — lib/moduleGate.js (PRODUCTIZATION PHASE 2, module
 * enforcement). Verifies: disabled module -> 404 module_disabled, never a
 * 500/missing-secret error; enabled module -> passes through; a config-read
 * failure fails open (never blocks an otherwise-healthy route over an
 * unrelated DB hiccup).
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const companyConfigPath = require.resolve('../lib/companyConfig');

function mockCompanyConfig(isModuleEnabledImpl) {
  require.cache[companyConfigPath] = {
    id: companyConfigPath, filename: companyConfigPath, loaded: true,
    exports: { isModuleEnabled: isModuleEnabledImpl },
  };
  delete require.cache[require.resolve('../lib/moduleGate')];
  return require('../lib/moduleGate');
}

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('requireModuleEnabled', () => {
  test('disabled module: 404 module_disabled, next() never called', async () => {
    const { requireModuleEnabled } = mockCompanyConfig(async () => false);
    const res = fakeRes();
    let nextCalled = false;
    await requireModuleEnabled('signnow')({}, res, () => { nextCalled = true; });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.error, 'module_disabled');
    assert.strictEqual(res.body.module, 'signnow');
    assert.strictEqual(nextCalled, false);
  });

  test('enabled module: calls next(), no response written', async () => {
    const { requireModuleEnabled } = mockCompanyConfig(async () => true);
    const res = fakeRes();
    let nextCalled = false;
    await requireModuleEnabled('handoff')({}, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.statusCode, null);
  });

  test('config-read failure fails open: calls next(), never 500s the route', async () => {
    const { requireModuleEnabled } = mockCompanyConfig(async () => { throw new Error('db down'); });
    const res = fakeRes();
    let nextCalled = false;
    await requireModuleEnabled('meta')({}, res, () => { nextCalled = true; });
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(res.statusCode, null);
  });
});
