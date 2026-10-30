/* eslint-disable no-undef */
'use strict';

/**
 * qbEnvironment.test.js — lib/qbEnvironment.js, the single validated source
 * of truth for QB_ENVIRONMENT introduced in the October 2026 "QuickBooks
 * Company Identity / Environment Consistency" reliability pass. Before this
 * module existed, server.js and lib/systemHealthChecks.js resolved the API
 * hostname from QB_ENVIRONMENT (default 'sandbox') while
 * lib/qbInboundSync.js / lib/qbSyncTrigger.js / lib/qbEstimateInvoice.js
 * separately resolved which stored credential to load from QB_SANDBOX
 * (default 'production') — this file proves the new resolver is correct in
 * isolation; test/qbEnvironmentConsistency.test.js proves every module now
 * actually uses it.
 */
const test = require('node:test');
const assert = require('node:assert');

function freshModule() {
  delete require.cache[require.resolve('../lib/qbEnvironment')];
  return require('../lib/qbEnvironment');
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

test('resolveQbEnvironment: "production" resolves cleanly, never misconfigured', () => {
  withEnv({ QB_ENVIRONMENT: 'production' }, () => {
    const mod = freshModule();
    const r = mod.resolveQbEnvironment();
    assert.strictEqual(r.environment, 'production');
    assert.strictEqual(r.misconfigured, false);
  });
});

test('resolveQbEnvironment: "sandbox" resolves cleanly, never misconfigured', () => {
  withEnv({ QB_ENVIRONMENT: 'sandbox' }, () => {
    const mod = freshModule();
    const r = mod.resolveQbEnvironment();
    assert.strictEqual(r.environment, 'sandbox');
    assert.strictEqual(r.misconfigured, false);
  });
});

test('resolveQbEnvironment: case-insensitive', () => {
  withEnv({ QB_ENVIRONMENT: 'PRODUCTION' }, () => {
    const mod = freshModule();
    assert.strictEqual(mod.resolveQbEnvironment().environment, 'production');
  });
});

test('resolveQbEnvironment: unset falls back to sandbox and reports misconfigured (fail safe, fail visible)', () => {
  withEnv({ QB_ENVIRONMENT: undefined }, () => {
    delete process.env.QB_ENVIRONMENT;
    const mod = freshModule();
    const r = mod.resolveQbEnvironment();
    assert.strictEqual(r.environment, 'sandbox');
    assert.strictEqual(r.misconfigured, true);
  });
});

test('resolveQbEnvironment: an unrecognized value falls back to sandbox and reports misconfigured', () => {
  withEnv({ QB_ENVIRONMENT: 'prod' }, () => {
    const mod = freshModule();
    const r = mod.resolveQbEnvironment();
    assert.strictEqual(r.environment, 'sandbox');
    assert.strictEqual(r.misconfigured, true);
    assert.strictEqual(r.raw, 'prod');
  });
});

test('resolveQbApiBase: production and sandbox map to the correct Intuit hosts', () => {
  const mod = freshModule();
  assert.strictEqual(mod.resolveQbApiBase('production'), 'https://quickbooks.api.intuit.com/v3/company');
  assert.strictEqual(mod.resolveQbApiBase('sandbox'), 'https://sandbox-quickbooks.api.intuit.com/v3/company');
  assert.strictEqual(mod.resolveQbApiBase('garbage'), mod.resolveQbApiBase('sandbox'), 'unrecognized input defaults to sandbox host, never undefined');
});

test('resolveQbAppUrlBase: production and sandbox map to the correct QBO app URLs', () => {
  const mod = freshModule();
  assert.strictEqual(mod.resolveQbAppUrlBase('production'), 'https://app.qbo.intuit.com');
  assert.strictEqual(mod.resolveQbAppUrlBase('sandbox'), 'https://sandbox.qbo.intuit.com');
});

test('the misconfiguration warning logs at most once per process (no log spam)', () => {
  withEnv({ QB_ENVIRONMENT: undefined }, () => {
    delete process.env.QB_ENVIRONMENT;
    const mod = freshModule();
    mod._resetWarnedOnceForTests();
    let calls = 0;
    const orig = console.error;
    console.error = (...args) => { calls++; };
    try {
      mod.resolveQbEnvironment();
      mod.resolveQbEnvironment();
      mod.resolveQbEnvironment();
    } finally { console.error = orig; }
    assert.strictEqual(calls, 1);
  });
});
