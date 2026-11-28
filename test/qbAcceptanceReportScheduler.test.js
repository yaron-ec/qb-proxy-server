/* eslint-disable no-undef */
'use strict';

/**
 * qbAcceptanceReportScheduler.test.js — November 2026 final-acceptance
 * follow-up, item 1 (durable automatic acceptance reporting). Pure/DB-
 * stubbed unit coverage; real-Postgres end-to-end coverage lives in
 * test/integration/qbAcceptanceReportScheduler.int.test.js.
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

function freshScheduler() {
  delete require.cache[require.resolve('../lib/qbAcceptanceReportScheduler')];
  return require('../lib/qbAcceptanceReportScheduler');
}

test('startSchedule: supersedes any existing active schedule, then inserts a fresh one anchored on the given recoveredAt', async () => {
  const calls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO qb_acceptance_report_schedule/.test(sql)) return { rows: [{ id: 'sched-1' }] };
      return { rows: [] };
    },
  });
  try {
    const scheduler = freshScheduler();
    const recoveredAt = new Date('2026-12-01T00:00:00.000Z');
    const id = await scheduler.startSchedule(recoveredAt);
    assert.strictEqual(id, 'sched-1');
    const supersede = calls.find((c) => /UPDATE qb_acceptance_report_schedule SET superseded_at/.test(c.sql));
    assert.ok(supersede, 'must supersede any existing active schedule first');
    const insert = calls.find((c) => /INSERT INTO qb_acceptance_report_schedule/.test(c.sql));
    assert.strictEqual(insert.params[0], recoveredAt.toISOString());
  } finally { restoreDb(); }
});

test('supersedeActiveSchedule: never throws even when the query fails', async () => {
  const restoreDb = stub('../db/client', { query: async () => { throw new Error('connection reset'); } });
  try {
    const scheduler = freshScheduler();
    await scheduler.supersedeActiveSchedule(); // must not throw
  } finally { restoreDb(); }
});

test('processDueReports: no active schedule -> reports no_active_schedule, never calls sendFn', async () => {
  const restoreDb = stub('../db/client', { query: async () => ({ rows: [] }) });
  try {
    const scheduler = freshScheduler();
    let called = false;
    const result = await scheduler.processDueReports(async () => { called = true; });
    assert.strictEqual(result.processed, false);
    assert.strictEqual(result.reason, 'no_active_schedule');
    assert.strictEqual(called, false);
  } finally { restoreDb(); }
});

test('processDueReports: a window already sent is skipped, never re-sent', async () => {
  const now = Date.now();
  const recoveredAt = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h ago -> 24h window is due
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT \* FROM qb_acceptance_report_schedule/.test(sql)) {
        return { rows: [{ id: 'sched-1', recovery_verified_at: recoveredAt, report_24h_sent_at: new Date().toISOString(), report_72h_sent_at: null, report_7d_sent_at: null }] };
      }
      return { rows: [] };
    },
  });
  const restoreReportScript = stub('../scripts/qbPostRecoveryAcceptanceReport', { buildReport: async () => ({ verdict: {} }) });
  try {
    const scheduler = freshScheduler();
    const sent = [];
    const result = await scheduler.processDueReports(async (payload) => { sent.push(payload.windowKey); });
    assert.strictEqual(result.processed, true);
    assert.deepStrictEqual(sent, [], 'the 24h window is already sent — must never re-send');
    const skip24h = result.skipped.find((s) => s.windowKey === 'report_24h');
    assert.strictEqual(skip24h.reason, 'already_sent');
  } finally { restoreDb(); restoreReportScript(); }
});

test('processDueReports: a due, not-yet-sent window calls sendFn and marks it sent — a not-yet-due window is skipped', async () => {
  const now = Date.now();
  const recoveredAt = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h ago: 24h due, 72h/7d not yet
  const sqlCalls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      sqlCalls.push({ sql, params });
      if (/SELECT \* FROM qb_acceptance_report_schedule/.test(sql)) {
        return { rows: [{ id: 'sched-1', recovery_verified_at: recoveredAt, report_24h_sent_at: null, report_72h_sent_at: null, report_7d_sent_at: null }] };
      }
      return { rows: [] };
    },
  });
  const restoreReportScript = stub('../scripts/qbPostRecoveryAcceptanceReport', { buildReport: async () => ({ verdict: { breaker_closed: true } }) });
  try {
    const scheduler = freshScheduler();
    const sent = [];
    const result = await scheduler.processDueReports(async (payload) => { sent.push(payload); });
    assert.deepStrictEqual(sent.map((s) => s.windowKey), ['report_24h']);
    assert.strictEqual(sent[0].report.verdict.breaker_closed, true);
    assert.deepStrictEqual(result.sent, ['report_24h']);
    const notDue = result.skipped.filter((s) => s.reason === 'not_due_yet').map((s) => s.windowKey).sort();
    assert.deepStrictEqual(notDue, ['report_72h', 'report_7d']);
    const markSent = sqlCalls.find((c) => /UPDATE qb_acceptance_report_schedule SET report_24h_sent_at = NOW\(\)/.test(c.sql));
    assert.ok(markSent, 'must mark report_24h_sent_at after a successful send');
    assert.strictEqual(markSent.params[0], 'sched-1');
  } finally { restoreDb(); restoreReportScript(); }
});

test('processDueReports: all three windows due at once (e.g. a long gap) sends all three, independently', async () => {
  const now = Date.now();
  const recoveredAt = new Date(now - 200 * 60 * 60 * 1000).toISOString(); // 200h ago: all three windows due
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT \* FROM qb_acceptance_report_schedule/.test(sql)) {
        return { rows: [{ id: 'sched-1', recovery_verified_at: recoveredAt, report_24h_sent_at: null, report_72h_sent_at: null, report_7d_sent_at: null }] };
      }
      return { rows: [] };
    },
  });
  const restoreReportScript = stub('../scripts/qbPostRecoveryAcceptanceReport', { buildReport: async () => ({ verdict: {} }) });
  try {
    const scheduler = freshScheduler();
    const sent = [];
    const result = await scheduler.processDueReports(async (payload) => { sent.push(payload.windowKey); });
    assert.deepStrictEqual(sent.sort(), ['report_24h', 'report_72h', 'report_7d']);
    assert.deepStrictEqual(result.sent.sort(), ['report_24h', 'report_72h', 'report_7d']);
  } finally { restoreDb(); restoreReportScript(); }
});

test('processDueReports: a sendFn failure never marks the window sent — it is retried on a later tick', async () => {
  const now = Date.now();
  const recoveredAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const sqlCalls = [];
  const restoreDb = stub('../db/client', {
    query: async (sql, params) => {
      sqlCalls.push({ sql, params });
      if (/SELECT \* FROM qb_acceptance_report_schedule/.test(sql)) {
        return { rows: [{ id: 'sched-1', recovery_verified_at: recoveredAt, report_24h_sent_at: null, report_72h_sent_at: null, report_7d_sent_at: null }] };
      }
      return { rows: [] };
    },
  });
  const restoreReportScript = stub('../scripts/qbPostRecoveryAcceptanceReport', { buildReport: async () => ({ verdict: {} }) });
  try {
    const scheduler = freshScheduler();
    const result = await scheduler.processDueReports(async () => { throw new Error('smtp down'); });
    assert.deepStrictEqual(result.sent, []);
    const skip = result.skipped.find((s) => s.windowKey === 'report_24h');
    assert.strictEqual(skip.reason, 'send_failed');
    const markSent = sqlCalls.find((c) => /UPDATE qb_acceptance_report_schedule SET report_24h_sent_at/.test(c.sql));
    assert.strictEqual(markSent, undefined, 'must never mark sent when sendFn threw');
  } finally { restoreDb(); restoreReportScript(); }
});

test('processDueReports: a buildReport failure is skipped (not a crash), retried on a later tick', async () => {
  const now = Date.now();
  const recoveredAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const restoreDb = stub('../db/client', {
    query: async (sql) => {
      if (/SELECT \* FROM qb_acceptance_report_schedule/.test(sql)) {
        return { rows: [{ id: 'sched-1', recovery_verified_at: recoveredAt, report_24h_sent_at: null, report_72h_sent_at: null, report_7d_sent_at: null }] };
      }
      return { rows: [] };
    },
  });
  const restoreReportScript = stub('../scripts/qbPostRecoveryAcceptanceReport', { buildReport: async () => { throw new Error('db down'); } });
  try {
    const scheduler = freshScheduler();
    let called = false;
    const result = await scheduler.processDueReports(async () => { called = true; });
    assert.strictEqual(called, false, 'sendFn must never be called when the report itself failed to build');
    const skip = result.skipped.find((s) => s.windowKey === 'report_24h');
    assert.strictEqual(skip.reason, 'build_failed');
  } finally { restoreDb(); restoreReportScript(); }
});

test('renderReportEmailHtml: never throws and includes the not-verified-consumption caveat', async () => {
  const scheduler = freshScheduler();
  const html = scheduler.renderReportEmailHtml({
    windowKey: 'report_24h',
    hoursSinceRecovery: 24,
    recoveryVerifiedAt: '2026-12-01T00:00:00.000Z',
    report: {
      verdict: { breaker_closed: true, sync_verified_caught_up: true },
      locally_measured_usage: { last_24h_approx: { total: 12 }, last_72h_approx: { total: 30 }, last_7d_approx: { total: 60 } },
      duplicate_detection: { duplicate_invoice_doc_numbers: [], duplicate_payment_doc_numbers: [] },
      cdc_item_failures: { unresolved_total: 0, unresolved_stale_over_48h: [] },
    },
  });
  assert.match(html, /24 hours/);
  assert.match(html, /NOT been[\s\S]*confirmed against Intuit/);
  assert.match(html, /breaker_closed/);
});
