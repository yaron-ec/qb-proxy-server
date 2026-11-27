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

const {
  isEstimateSyncCronEnabled, getInboundReconcileIntervalMinutes, inboundReconcileCronExpression, DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES,
  getFullReconcileIntervalHours, fullReconcileCronExpression, DEFAULT_FULL_RECONCILE_INTERVAL_HOURS,
} = require('../lib/qbSyncCronConfig');

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
// call volume. SUPERSEDED in the November 2026 "QB API consumption
// root-cause investigation" follow-up: this interval now governs the NEW,
// cheap, company-wide CDC-based incremental sync (not the old per-customer
// full-refetch loop), so the default is lowered back to 15 minutes — see
// this module's own header for the full reasoning.

test('getInboundReconcileIntervalMinutes: unset -> the restored 15-minute default (now governs the cheap CDC-based incremental sync, not the old per-customer loop)', () => {
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: undefined }, () => {
    assert.strictEqual(getInboundReconcileIntervalMinutes(), 15);
    assert.strictEqual(DEFAULT_INBOUND_RECONCILE_INTERVAL_MINUTES, 15);
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
      assert.strictEqual(getInboundReconcileIntervalMinutes(), 15, `bad value "${bad}" must fall back to the default`);
    });
  }
});

test('inboundReconcileCronExpression: the default (15 min) produces a clean minute-step schedule', () => {
  withEnv({ QB_INBOUND_RECONCILE_INTERVAL_MINUTES: undefined }, () => {
    assert.strictEqual(inboundReconcileCronExpression(), '*/15 * * * *');
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

test('server.js registers the incremental reconciliation cron using the shared inboundReconcileCronExpression(), not a hardcoded schedule', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const idx = source.indexOf('QB Inbound Reconciliation: incremental');
  assert.ok(idx > -1, 'expected the QB Inbound Reconciliation incremental+full section');
  const block = source.slice(idx, idx + 2500);
  assert.ok(/qbSyncCronConfig\.inboundReconcileCronExpression\(\)/.test(block), 'the incremental cron registration must use the shared, configurable interval resolver');
  assert.ok(/qbSyncCronConfig\.fullReconcileCronExpression\(\)/.test(block), 'the daily full-reconcile cron must use its own shared, configurable interval resolver');
  assert.ok(!/cronLib\.schedule\('\*\/15 \* \* \* \*'/.test(block), 'neither cron may use a hardcoded literal schedule string');
});

// ── getFullReconcileIntervalHours / fullReconcileCronExpression — the
// once-daily (default) safety net that still runs the ORIGINAL, unchanged
// per-customer full reconciliation (syncAllMappedCustomers). ──────────────

test('getFullReconcileIntervalHours: unset -> the 24-hour default', () => {
  withEnv({ QB_FULL_RECONCILE_INTERVAL_HOURS: undefined }, () => {
    assert.strictEqual(getFullReconcileIntervalHours(), 24);
    assert.strictEqual(DEFAULT_FULL_RECONCILE_INTERVAL_HOURS, 24);
  });
});

test('getFullReconcileIntervalHours: a valid positive integer override is honored', () => {
  withEnv({ QB_FULL_RECONCILE_INTERVAL_HOURS: '12' }, () => {
    assert.strictEqual(getFullReconcileIntervalHours(), 12);
  });
});

test('getFullReconcileIntervalHours: zero, negative, or non-numeric values fall back to the 24-hour default', () => {
  for (const bad of ['0', '-5', 'abc', '']) {
    withEnv({ QB_FULL_RECONCILE_INTERVAL_HOURS: bad }, () => {
      assert.strictEqual(getFullReconcileIntervalHours(), 24, `bad value "${bad}" must fall back to the default`);
    });
  }
});

test('fullReconcileCronExpression: the default (24h) runs once daily at 3am', () => {
  withEnv({ QB_FULL_RECONCILE_INTERVAL_HOURS: undefined }, () => {
    assert.strictEqual(fullReconcileCronExpression(), '0 3 * * *');
  });
});

test('fullReconcileCronExpression: a clean multiple of 24 (multiple days) uses a day-step schedule', () => {
  withEnv({ QB_FULL_RECONCILE_INTERVAL_HOURS: '48' }, () => {
    assert.strictEqual(fullReconcileCronExpression(), '0 3 */2 * *');
  });
});

test('fullReconcileCronExpression: a clean sub-24 divisor uses hour-step syntax', () => {
  withEnv({ QB_FULL_RECONCILE_INTERVAL_HOURS: '12' }, () => {
    assert.strictEqual(fullReconcileCronExpression(), '0 */12 * * *');
  });
});

test('fullReconcileCronExpression: an unsupported value falls back to the clean once-daily default', () => {
  withEnv({ QB_FULL_RECONCILE_INTERVAL_HOURS: '13' }, () => {
    assert.strictEqual(fullReconcileCronExpression(), '0 3 * * *');
  });
});
