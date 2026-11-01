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

const { isEstimateSyncCronEnabled } = require('../lib/qbSyncCronConfig');

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
