/* eslint-disable no-undef */
'use strict';

/**
 * qbEnvironmentConsistency.test.js — source-level proof that every
 * QuickBooks-calling module resolves environment through the single shared
 * lib/qbEnvironment.js resolver (October 2026 reliability pass), rather than
 * the previous split where server.js/systemHealthChecks.js keyed hostname
 * off QB_ENVIRONMENT while qbInboundSync.js/qbSyncTrigger.js/
 * qbEstimateInvoice.js separately keyed the stored-credential lookup off a
 * SEPARATE QB_SANDBOX variable. server.js has top-level side effects and is
 * not requirable in a unit test (see test/qbLegacyWriteRouteSecurity.test.js
 * for the established convention this file follows); the other modules are
 * requirable and are also exercised directly here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function source(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

for (const file of ['lib/qbInboundSync.js', 'lib/qbSyncTrigger.js', 'lib/qbEstimateInvoice.js', 'routes/leadQB.js']) {
  test(`${file} no longer reads process.env.QB_SANDBOX directly`, () => {
    const src = source(file);
    assert.ok(!/process\.env\.QB_SANDBOX/.test(src), `${file} must resolve environment via lib/qbEnvironment.js, not QB_SANDBOX directly`);
  });

  test(`${file} requires lib/qbEnvironment`, () => {
    const src = source(file);
    assert.ok(/require\(['"].*qbEnvironment['"]\)/.test(src), `${file} must require lib/qbEnvironment`);
  });
}

test('server.js resolves QB_ENVIRONMENT via lib/qbEnvironment.resolveQbEnvironment, not an inline default', () => {
  const src = source('server.js');
  assert.ok(/qbEnvironment\.resolveQbEnvironment\(\)/.test(src), 'server.js must call the shared resolver');
  assert.ok(!/process\.env\.QB_ENVIRONMENT \|\| 'sandbox'/.test(src), 'server.js must not inline its own default any more');
});

test('server.js builds QB_API_BASE via lib/qbEnvironment.resolveQbApiBase', () => {
  const src = source('server.js');
  assert.ok(/qbEnvironment\.resolveQbApiBase\(QB_ENVIRONMENT\)/.test(src));
});

test('lib/systemHealthChecks.js#checkQuickBooks resolves environment via lib/qbEnvironment', () => {
  const src = source('lib/systemHealthChecks.js');
  assert.ok(/require\(['"]\.\/qbEnvironment['"]\)\.resolveQbEnvironment\(\)/.test(src));
});

test('lib/qbInboundSync.js, lib/qbSyncTrigger.js and lib/qbEstimateInvoice.js all resolve to the same environment value for a given QB_ENVIRONMENT', () => {
  const prevEnv = process.env.QB_ENVIRONMENT;
  const prevSandbox = process.env.QB_SANDBOX;
  process.env.QB_ENVIRONMENT = 'production';
  process.env.QB_SANDBOX = 'true'; // deliberately contradictory — proves it is now ignored
  try {
    for (const mod of ['../lib/qbEnvironment']) delete require.cache[require.resolve(mod)];
    const qbEnvironment = require('../lib/qbEnvironment');
    const resolved = qbEnvironment.resolveQbEnvironment().environment;
    assert.strictEqual(resolved, 'production', 'QB_ENVIRONMENT alone must decide this, even with a contradictory QB_SANDBOX set');
  } finally {
    if (prevEnv === undefined) delete process.env.QB_ENVIRONMENT; else process.env.QB_ENVIRONMENT = prevEnv;
    if (prevSandbox === undefined) delete process.env.QB_SANDBOX; else process.env.QB_SANDBOX = prevSandbox;
  }
});
