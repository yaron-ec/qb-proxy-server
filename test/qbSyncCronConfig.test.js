/* eslint-disable no-undef */
'use strict';

/**
 * qbSyncCronConfig.test.js — the shared QB_SYNC_CRON_ENABLED resolver
 * server.js and lib/systemHealthChecks.js both now use, so the two can
 * never disagree about whether the scheduled QB Estimate Sync cron is
 * allowed to run.
 */
const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const path = require('path');

const { isEstimateSyncCronEnabled, getInboundReconcileIntervalMinutes, inboundReconcileCronExpression, DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES } = require('../lib/qbSyncCronConfig');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('isEstimateSyncCronEnabled: unset -> enabled (default)', () => {
  withEnv({ QB_SYNC_CRON_ENABLED: undefined }, () => {
    assert.strictEqual(isEstimateSyncCronEnabled(), true);
  });
});

test('isEstimateSyncCronEnabled: "false" -> disabled', () => {
  withEnv({ QB_SYNC_CRON_ENABLED: 'false' }, () => {
    assert.strictEqual(isEstimateSyncCronEnabled(), false);
  });
});

test('isEstimateSyncCronEnabled: "true" -> enabled', () => {
  withEnv({ QB_SYNC_CRON_ENABLED: 'true' }, () => {
    assert.strictEqual(isEstimateSyncCronEnabled(), true);
  });
});

test('isEstimateSyncCronEnabled: any other value -> enabled (only the literal "false" disables it)', () => {
  withEnv({ QB_SYNC_CRON_ENABLED: 'False' }, () => {
    assert.strictEqual(isEstimateSyncCronEnabled(), true, 'case-sensitive — "False" is not "false"');
  });
  withEnv({ QB_SYNC_CRON_ENABLED: '0' }, () => {
    assert.strictEqual(isEstimateSyncCronEnabled(), true);
  });
});

// ── Source-level wiring proof (server.js is not directly requirable — same
// constraint as test/qbSyncCursorPersistence.test.js) that the QB Estimate
// Sync cron's own gate actually delegates to this shared resolver instead
// of re-checking process.env.QB_SYNC_CRON_ENABLED === 'false' a second,
// independently-drifting time. ─────────────────────────────────────────────
test('server.js gates the QB Estimate Sync cron through the shared isEstimateSyncCronEnabled() resolver, not a second inline check', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = source.indexOf("QB sync cron explicitly disabled");
  assert.ok(idx > -1, 'expected the QB sync cron disabled log line in server.js');
  const block = source.slice(Math.max(0, idx - 300), idx + 50);
  assert.ok(/qbSyncCronConfig'\)\.isEstimateSyncCronEnabled\(\)/.test(block), 'the cron gate must call the shared resolver');
  assert.ok(!/QB_SYNC_CRON_ENABLED === 'false'/.test(block), 'the inline re-check this fix replaced must not reappear here');
});

// ── getInboundReconcileIntervalMinutes / inboundReconcileCronExpression ────
// November 2026 "sustained 429 never recovers" incident: the QB Inbound
// Reconciliation cron's own default interval was widened from 15 to 60
// minutes to reduce its dominant share of total monthly QuickBooks API
// call volume (see this module's own header for the exact math).

test('getInboundReconcileIntervalMinutes: unset -> the new 60-minute default (never silently 15 again)', () => {
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: undefined }, () => {
    assert.strictEqual(getInboundReconcileIntervalMinutes(), 60);
    assert.strictEqual(DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES, 60);
  });
});

test('getInboundReconcileIntervalMinutes: a valid positive integer override is honored', () => {
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: '30' }, () => {
    assert.strictEqual(getInboundReconcileIntervalMinutes(), 30);
  });
});

test('getInboundReconcileIntervalMinutes: zero, negative, or non-numeric values fall back to the default rather than producing a broken/runaway schedule', () => {
  for (const bad of ['0', '-5', 'abc', '']) {
    withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: bad }, () => {
      assert.strictEqual(getInboundReconcileIntervalMinutes(), 60, `bad value "${bad}" must fall back to the default`);
    });
  }
});

test('inboundReconcileCronExpression: the default (60 min) produces "top of every hour"', () => {
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: undefined }, () => {
    assert.strictEqual(inboundReconcileCronExpression(), '0 * * * *');
  });
});

test('inboundReconcileCronExpression: a clean sub-60 divisor uses minute-step syntax', () => {
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: '15' }, () => {
    assert.strictEqual(inboundReconcileCronExpression(), '*/15 * * * *');
  });
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: '20' }, () => {
    assert.strictEqual(inboundReconcileCronExpression(), '*/20 * * * *');
  });
});

test('inboundReconcileCronExpression: a clean multiple of 60 (whole hours) uses hour-step syntax', () => {
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: '120' }, () => {
    assert.strictEqual(inboundReconcileCronExpression(), '0 */2 * * *');
  });
});

test('inboundReconcileCronExpression: an unsupported (non-divisor, non-multiple) value falls back to the clean 60-minute default rather than producing an invalid/misleading schedule', () => {
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: '47' }, () => {
    assert.strictEqual(inboundReconcileCronExpression(), '0 * * * *');
  });
});

test('server.js registers the inbound reconciliation cron using the shared inboundReconcileCronExpression(), not a hardcoded */15 schedule', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = source.indexOf('QB Inbound Reconciliation Cron');
  assert.ok(idx > -1, 'expected the QB Inbound Reconciliation Cron section');
  const block = source.slice(idx, idx + 1200);
  assert.ok(/qbSyncCronConfig'\)\.inboundReconcileCronExpression\(\)/.test(block), 'the cron registration must use the shared, configurable interval resolver');
  assert.ok(!/cronLib\.schedule\('\*\/15 \* \* \* \*'/.test(block), 'the old hardcoded 15-minute schedule must not reappear for this cron');
});
