/* eslint-disable no-undef */
'use strict';

/**
 * postAppointmentEstimateSync.test.js — pure/DB-stubbed unit coverage for
 * lib/postAppointmentEstimateSync.js's eligibility, retry-schedule, and
 * attempt-outcome logic. Real-Postgres end-to-end coverage (enqueueing,
 * claim concurrency, full retry progression, real enrollment) lives in
 * test/integration/postAppointmentEstimateSync.int.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function freshModule() {
  // Only the module under test — NOT its dependencies, which individual
  // tests stub via stub() above; clearing those here would immediately
  // undo the stub before this module's own require() of them runs.
  delete require.cache[require.resolve('../lib/postAppointmentEstimateSync')];
  return require('../lib/postAppointmentEstimateSync');
}

test('RETRY_OFFSET_HOURS: exactly 3h, 24h, 48h, 72h, then daily through day 7 (168h)', () => {
  const m = freshModule();
  assert.deepStrictEqual(m.RETRY_OFFSET_HOURS, [3, 24, 48, 72, 96, 120, 144, 168]);
  assert.strictEqual(m.WINDOW_DAYS, 7);
  // Confirm the last offset exactly matches the 7-day window.
  assert.strictEqual(m.RETRY_OFFSET_HOURS[m.RETRY_OFFSET_HOURS.length - 1], m.WINDOW_DAYS * 24);
});

test('computeAdvance: advances to the next offset when more remain', () => {
  const m = freshModule();
  const endAt = new Date('2026-01-01T12:00:00Z');
  const windowExpiresAt = new Date(endAt.getTime() + 7 * 24 * 3600 * 1000);
  const row = { attempt_number: 0, window_expires_at: windowExpiresAt.toISOString() };
  const advance = m.computeAdvance(row, endAt.toISOString());
  assert.strictEqual(advance.expired, false);
  assert.strictEqual(advance.attemptNumber, 1);
  assert.strictEqual(advance.nextAttemptAt.getTime(), endAt.getTime() + 24 * 3600 * 1000);
});

test('computeAdvance: expires once the last offset (day 7) has already been attempted', () => {
  const m = freshModule();
  const endAt = new Date('2026-01-01T12:00:00Z');
  const windowExpiresAt = new Date(endAt.getTime() + 7 * 24 * 3600 * 1000);
  const row = { attempt_number: 7, window_expires_at: windowExpiresAt.toISOString() }; // index 7 = 168h, the last one
  const advance = m.computeAdvance(row, endAt.toISOString());
  assert.strictEqual(advance.expired, true);
});

test('computeAdvance: expires if the next computed attempt would exceed window_expires_at (defense in depth)', () => {
  const m = freshModule();
  const endAt = new Date('2026-01-01T12:00:00Z');
  // Deliberately narrow window, shorter than the real 7 days, to prove the
  // window check is an independent guard, not derived solely from the
  // offset array length.
  const windowExpiresAt = new Date(endAt.getTime() + 30 * 3600 * 1000); // 30h
  const row = { attempt_number: 0, window_expires_at: windowExpiresAt.toISOString() };
  const advance = m.computeAdvance(row, endAt.toISOString()); // next would be 24h — still within 30h
  assert.strictEqual(advance.expired, false);
  const row2 = { attempt_number: 1, window_expires_at: windowExpiresAt.toISOString() };
  const advance2 = m.computeAdvance(row2, endAt.toISOString()); // next would be 48h — exceeds 30h window
  assert.strictEqual(advance2.expired, true);
});

test('attemptSync: a lead in a terminal-lost status is immediately stopped, never synced', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/FROM leads/.test(sql)) return { rows: [{ id: 'lead-1', status: 'Lost', email: 'a@test.com' }] };
      throw new Error('unexpected query: ' + sql);
    },
  });
  const restoreSync = stub('../lib/leadEstimateSync', { syncEstimatesForLead: async () => { throw new Error('must not be called'); } });
  try {
    const m = freshModule();
    const result = await m.attemptSync({ id: 'sync-1', lead_id: 'lead-1', handoff_estimate_id: null });
    assert.strictEqual(result.outcome, 'stopped');
    assert.strictEqual(result.lastResult, 'lead_ineligible');
    assert.match(result.stoppedReason, /lead_status:Lost/);
  } finally { restoreDb(); restoreSync(); }
});

test('attemptSync: no QB customer / zero estimates found -> not_found, stays pending for retry', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/FROM leads/.test(sql)) return { rows: [{ id: 'lead-1', status: 'New Lead', email: 'a@test.com' }] };
      throw new Error('unexpected query: ' + sql);
    },
  });
  const restoreSync = stub('../lib/leadEstimateSync', {
    syncEstimatesForLead: async () => ({ success: true, synced_estimate_ids: [] }),
  });
  try {
    const m = freshModule();
    const result = await m.attemptSync({ id: 'sync-1', lead_id: 'lead-1', handoff_estimate_id: null });
    assert.strictEqual(result.outcome, 'pending');
    assert.strictEqual(result.lastResult, 'not_found');
  } finally { restoreDb(); restoreSync(); }
});

test('attemptSync: estimate found but EmailStatus not yet EmailSent -> found_unverified, keeps retrying', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/FROM leads/.test(sql)) return { rows: [{ id: 'lead-1', status: 'New Lead', email: 'a@test.com' }] };
      if (/FROM handoff_estimates/.test(sql)) return { rows: [{ id: 'est-1', estimate_status: 'Pending', qb_email_status: 'NeedToSend', qb_email_delivery_time: null }] };
      throw new Error('unexpected query: ' + sql);
    },
  });
  const restoreSync = stub('../lib/leadEstimateSync', {
    syncEstimatesForLead: async () => ({ success: true, synced_estimate_ids: ['est-1'] }),
  });
  try {
    const m = freshModule();
    const result = await m.attemptSync({ id: 'sync-1', lead_id: 'lead-1', handoff_estimate_id: null });
    assert.strictEqual(result.outcome, 'pending');
    assert.strictEqual(result.lastResult, 'found_unverified');
    assert.strictEqual(result.handoffEstimateId, 'est-1');
  } finally { restoreDb(); restoreSync(); }
});

test('attemptSync: EmailSent confirmed -> enrolls via estimateFollowupEngine.enroll and completes', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/FROM leads/.test(sql)) return { rows: [{ id: 'lead-1', status: 'New Lead', email: 'a@test.com' }] };
      if (/FROM handoff_estimates/.test(sql)) return { rows: [{ id: 'est-1', estimate_status: 'Pending', qb_email_status: 'EmailSent', qb_email_delivery_time: '2026-01-02T00:00:00Z' }] };
      throw new Error('unexpected query: ' + sql);
    },
  });
  const restoreSync = stub('../lib/leadEstimateSync', {
    syncEstimatesForLead: async () => ({ success: true, synced_estimate_ids: ['est-1'] }),
  });
  let enrollArgs = null;
  const restoreEngine = stub('../lib/estimateFollowupEngine', {
    enroll: async (args) => { enrollArgs = args; return { sequence: { id: 'seq-1' } }; },
  });
  try {
    const m = freshModule();
    const result = await m.attemptSync({ id: 'sync-1', lead_id: 'lead-1', handoff_estimate_id: null });
    assert.strictEqual(result.outcome, 'completed');
    assert.strictEqual(result.lastResult, 'found_verified_enrolled');
    assert.strictEqual(result.handoffEstimateId, 'est-1');
    assert.strictEqual(enrollArgs.leadId, 'lead-1');
    assert.strictEqual(enrollArgs.handoffEstimateId, 'est-1');
    assert.strictEqual(enrollArgs.method, 'auto_post_appointment_sync');
    assert.strictEqual(enrollArgs.confirmedBy, 'system:auto_post_appointment_sync');
    assert.strictEqual(enrollArgs.sentAt, '2026-01-02T00:00:00Z');
  } finally { restoreDb(); restoreSync(); restoreEngine(); }
});

test('attemptSync: enroll() reports a competing sequence already active -> treated as already-enrolled success, not an error', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/FROM leads/.test(sql)) return { rows: [{ id: 'lead-1', status: 'New Lead', email: 'a@test.com' }] };
      if (/FROM handoff_estimates/.test(sql)) return { rows: [{ id: 'est-1', estimate_status: 'Pending', qb_email_status: 'EmailSent', qb_email_delivery_time: '2026-01-02T00:00:00Z' }] };
      throw new Error('unexpected query: ' + sql);
    },
  });
  const restoreSync = stub('../lib/leadEstimateSync', {
    syncEstimatesForLead: async () => ({ success: true, synced_estimate_ids: ['est-1'] }),
  });
  const restoreEngine = stub('../lib/estimateFollowupEngine', {
    enroll: async () => {
      const err = new Error('lead is not eligible for enrollment: competing_sequence_already_active');
      err.code = 'not_eligible';
      err.reasons = ['competing_sequence_already_active'];
      throw err;
    },
  });
  try {
    const m = freshModule();
    const result = await m.attemptSync({ id: 'sync-1', lead_id: 'lead-1', handoff_estimate_id: null });
    assert.strictEqual(result.outcome, 'completed');
    assert.strictEqual(result.lastResult, 'found_verified_enrolled');
  } finally { restoreDb(); restoreSync(); restoreEngine(); }
});

test('attemptSync: enroll() reports the lead became disqualified mid-search -> stopped as lead_ineligible', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/FROM leads/.test(sql)) return { rows: [{ id: 'lead-1', status: 'New Lead', email: 'a@test.com' }] };
      if (/FROM handoff_estimates/.test(sql)) return { rows: [{ id: 'est-1', estimate_status: 'Pending', qb_email_status: 'EmailSent', qb_email_delivery_time: '2026-01-02T00:00:00Z' }] };
      throw new Error('unexpected query: ' + sql);
    },
  });
  const restoreSync = stub('../lib/leadEstimateSync', {
    syncEstimatesForLead: async () => ({ success: true, synced_estimate_ids: ['est-1'] }),
  });
  const restoreEngine = stub('../lib/estimateFollowupEngine', {
    enroll: async () => {
      const err = new Error('lead is not eligible for enrollment: lead_status_disqualifying:Sold');
      err.code = 'not_eligible';
      err.reasons = ['lead_status_disqualifying:Sold'];
      throw err;
    },
  });
  try {
    const m = freshModule();
    const result = await m.attemptSync({ id: 'sync-1', lead_id: 'lead-1', handoff_estimate_id: null });
    assert.strictEqual(result.outcome, 'stopped');
    assert.strictEqual(result.lastResult, 'lead_ineligible');
  } finally { restoreDb(); restoreSync(); restoreEngine(); }
});

test('attemptSync: a genuine QuickBooks/network failure propagates (never silently swallowed as not_found)', async () => {
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/FROM leads/.test(sql)) return { rows: [{ id: 'lead-1', status: 'New Lead', email: 'a@test.com' }] };
      throw new Error('unexpected query: ' + sql);
    },
  });
  const restoreSync = stub('../lib/leadEstimateSync', {
    syncEstimatesForLead: async () => { throw new Error('QB proxy /estimates/by-customer/123 failed 503'); },
  });
  try {
    const m = freshModule();
    await assert.rejects(
      () => m.attemptSync({ id: 'sync-1', lead_id: 'lead-1', handoff_estimate_id: null }),
      /failed 503/
    );
  } finally { restoreDb(); restoreSync(); }
});
