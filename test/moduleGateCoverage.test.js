/* eslint-disable no-undef */
'use strict';

/**
 * moduleGateCoverage.test.js — PRODUCTIZATION Phase I systemic drift guard.
 *
 * Structural coverage check for lib/moduleGate.js: every dedicated
 * integration router that exists for an optional module must actually gate
 * on it. Found and fixed during this audit: server.js's in-process QB
 * Estimate Sync cron (`cronLib.schedule('*\/15 * * * *', ...)` calling
 * runQbEstimateSync()/runQbEstimatePdfSync() directly, NOT through
 * routes/qbInboundSync.js or any other already-gated router) made real
 * QuickBooks API calls on a fixed schedule with no `isModuleEnabled('quickbooks')`
 * check at all — a company with the quickbooks module disabled would still
 * have this cron attempt live QuickBooks calls every 15 minutes. The
 * sibling QB Inbound Reconciliation cron in the same file was already safe
 * because it calls routes/cronJobs.js's own already-gated
 * POST /qb-inbound-reconcile over HTTP rather than running the sync
 * in-process.
 *
 * This test is a structural (source-text) check, not a runtime one,
 * because server.js's cron body is an anonymous closure registered at
 * require-time via node-cron — there is no exported function to invoke in
 * isolation without starting the whole server. It mirrors the same
 * structural-check pattern already established by
 * destructiveScriptsInstallationGate.test.js for an analogous reason.
 */
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('server.js: the in-process QB Estimate Sync cron checks isModuleEnabled(quickbooks) before calling runQbEstimateSync', () => {
  const src = readFile('server.js');
  const cronStart = src.indexOf("cronLib.schedule('*/15 * * * *'");
  assert.ok(cronStart !== -1, 'expected to find the QB Estimate Sync cron registration');
  const syncCallIdx = src.indexOf('runQbEstimateSync()', cronStart);
  assert.ok(syncCallIdx !== -1, 'expected runQbEstimateSync() to be called inside the cron');
  const between = src.slice(cronStart, syncCallIdx);
  assert.match(
    between,
    /isModuleEnabled\(['"]quickbooks['"]\)/,
    'the QB Estimate Sync cron must check companyConfig.isModuleEnabled(\'quickbooks\') and skip before calling runQbEstimateSync() — otherwise a company with QuickBooks disabled still makes live QB API calls on every tick'
  );
});

test('every dedicated optional-integration router gates on its own module key', () => {
  const expectations = [
    ['routes/signnow.js', 'signnow'],
    ['routes/handoffEstimates.js', 'handoff'],
    ['routes/handoffSync.js', 'handoff'],
    ['routes/leadQB.js', 'quickbooks'],
    ['routes/qbInboundSync.js', 'quickbooks'],
    ['routes/metaWebhook.js', 'meta'],
  ];
  for (const [file, key] of expectations) {
    const src = readFile(file);
    assert.match(
      src,
      new RegExp(`requireModuleEnabled\\(['"]${key}['"]\\)`),
      `${file} must call requireModuleEnabled('${key}')`
    );
  }
});
