/* eslint-disable no-undef */
'use strict';

/**
 * monitoringIncidentAlertCooldown.int.test.js — real-Postgres proof of the
 * full persistent-incident notification policy (November 2026 fix for the
 * repeated-hourly-QuickBooks-quota-alert production incident).
 *
 * Exercises lib/monitoring/crashLoopDetector.js's recordFailure/shouldAlert/
 * markAlertSent/recordSuccess directly against real monitoring_incidents
 * rows — this is durable Postgres state, so "worker restart" and
 * "deployment" are simulated by simply re-requiring the module fresh (a
 * fresh require never re-creates or resets any row; everything it reads
 * comes straight back out of the database).
 */
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

if (!process.env.TEST_DATABASE_URL) {
  test('skipped — set TEST_DATABASE_URL to run', () => {});
  return;
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

function freshCrashLoop() {
  delete require.cache[require.resolve('../../lib/monitoring/crashLoopDetector')];
  return require('../../lib/monitoring/crashLoopDetector');
}

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const SERVICE_ID = `test-monitoring-cooldown-${Date.now()}`;

test.after(async () => {
  await pool.query('DELETE FROM monitoring_incidents WHERE service_id = $1', [SERVICE_ID]);
  await pool.end();
});

test('persistent incident: new -> duplicate reports suppressed -> 24h reminder -> genuinely different failure interrupts the cooldown -> verified recovery -> recurrence opens a NEW incident', async () => {
  let crashLoop = freshCrashLoop();

  // 1. Brand-new failure — must alert immediately.
  let { incident, isNew, isCrashLoop } = await crashLoop.recordFailure(SERVICE_ID, 'quota exhausted', 'qb_integration', {});
  assert.strictEqual(isNew, true);
  let alert = crashLoop.shouldAlert(incident, { isNew, isCrashLoop, newErrorType: 'quota_exhausted' });
  assert.strictEqual(alert, true, 'a new incident must always alert');
  await crashLoop.markAlertSent(incident.id, 'quota_exhausted');
  const firstIncidentId = incident.id;

  // Backdate first_failure_at so subsequent probe ticks in this test don't
  // accidentally trip the UNRELATED crash-loop rule (3 failures within 10
  // minutes) just because this test's calls happen milliseconds apart —
  // in real production, the watchdog's own ~15-30 minute tick spacing
  // already keeps a long-lived, externally-blocked incident like this one
  // far outside that 10-minute window by the time a second tick occurs.
  await pool.query(`UPDATE monitoring_incidents SET first_failure_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [incident.id]);

  // 2. "Worker restart" — simulated by re-requiring the module fresh. A
  // DUPLICATE report of the SAME unchanged failure moments later must NOT
  // re-alert (this is the exact reported bug: the old rule would re-alert
  // here once failure_count reached a multiple of 5).
  crashLoop = freshCrashLoop();
  for (let i = 0; i < 6; i++) {
    const r = await crashLoop.recordFailure(SERVICE_ID, 'quota exhausted', 'qb_integration', {});
    incident = r.incident;
    const should = crashLoop.shouldAlert(incident, { isNew: r.isNew, isCrashLoop: r.isCrashLoop, newErrorType: 'quota_exhausted' });
    assert.strictEqual(should, false, `tick ${i + 1} (failure_count=${incident.failure_count}) must not re-alert — same unchanged persistent incident within the cooldown`);
  }
  assert.strictEqual(incident.id, firstIncidentId, 'must remain the SAME incident row, never a duplicate');

  // 3. Simulate the 24h cooldown having elapsed by backdating alert_sent_at
  // directly (this is itself the real, durable column the fix reads —
  // backdating it is the most direct way to prove the time-based gate).
  await pool.query(`UPDATE monitoring_incidents SET alert_sent_at = NOW() - INTERVAL '25 hours' WHERE id = $1`, [incident.id]);
  {
    const r = await crashLoop.recordFailure(SERVICE_ID, 'quota exhausted', 'qb_integration', {});
    const should = crashLoop.shouldAlert(r.incident, { isNew: r.isNew, isCrashLoop: r.isCrashLoop, newErrorType: 'quota_exhausted' });
    assert.strictEqual(should, true, 'a persistent, unchanged incident must still send its once-per-24h consolidated reminder');
    await crashLoop.markAlertSent(r.incident.id, 'quota_exhausted');
    incident = r.incident;
  }

  // 4. A genuinely DIFFERENT failure (e.g. the credential itself is now
  // revoked, not merely rate-limited) must alert immediately — the 24h
  // cooldown from step 3 has barely started, so the old time-based rule
  // ALONE would have suppressed this; the error-type-change override must
  // win.
  {
    const r = await crashLoop.recordFailure(SERVICE_ID, 'reconnect required', 'qb_integration', {});
    const should = crashLoop.shouldAlert(r.incident, { isNew: r.isNew, isCrashLoop: r.isCrashLoop, newErrorType: 'reconnect_required' });
    assert.strictEqual(should, true, 'a genuinely different failure category must interrupt the cooldown and alert immediately');
    await crashLoop.markAlertSent(r.incident.id, 'reconnect_required');
    incident = r.incident;
  }

  // 5. Verified recovery — resolves the incident.
  const { resolved } = await crashLoop.recordSuccess(SERVICE_ID);
  assert.strictEqual(resolved, true);
  const { rows: resolvedRows } = await pool.query('SELECT status FROM monitoring_incidents WHERE id = $1', [incident.id]);
  assert.strictEqual(resolvedRows[0].status, 'resolved');

  // 6. Recurrence after verified recovery opens a BRAND NEW incident (never
  // reopens the resolved one) and that new incident alerts immediately.
  const r2 = await crashLoop.recordFailure(SERVICE_ID, 'quota exhausted again', 'qb_integration', {});
  assert.strictEqual(r2.isNew, true, 'a recurrence after resolution must be a NEW incident');
  assert.notStrictEqual(r2.incident.id, incident.id, 'must be a different incident row than the resolved one');
  const shouldAlertOnRecurrence = crashLoop.shouldAlert(r2.incident, { isNew: r2.isNew, isCrashLoop: r2.isCrashLoop, newErrorType: 'quota_exhausted' });
  assert.strictEqual(shouldAlertOnRecurrence, true, 'a recurrence must generate its own fresh notification');
});

test('a crash-loop transition always interrupts the cooldown, even seconds after the last alert, same unchanged error category', async () => {
  const crashLoop = freshCrashLoop();
  const serviceId = `${SERVICE_ID}-crashloop`;
  let incident;
  for (let i = 0; i < 3; i++) {
    const r = await crashLoop.recordFailure(serviceId, 'transient blip', 'http', {});
    incident = r.incident;
    if (i === 0) await crashLoop.markAlertSent(incident.id, 'http'); // first alert already sent, moments ago
    if (i === 2) {
      // 3rd failure within the 10-minute crash-loop window -> isCrashLoop true
      assert.strictEqual(r.isCrashLoop, true, 'this test assumes the 3-in-10-minutes crash-loop threshold is met');
      const should = crashLoop.shouldAlert(incident, { isNew: r.isNew, isCrashLoop: r.isCrashLoop, newErrorType: 'http' });
      assert.strictEqual(should, true, 'a crash-loop transition must alert immediately regardless of the cooldown');
    }
  }
  await pool.query('DELETE FROM monitoring_incidents WHERE service_id = $1', [serviceId]);
});
