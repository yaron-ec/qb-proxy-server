/* eslint-disable no-undef */
'use strict';

/**
 * qbAcceptanceReportScheduler.int.test.js — real-Postgres proof of
 * lib/qbAcceptanceReportScheduler.js's full lifecycle (November 2026
 * final-acceptance follow-up, item 1): schedule creation anchored on a
 * genuine recovery timestamp, due-window detection at real time offsets,
 * duplicate prevention across repeated calls, and superseding an active
 * schedule on a fresh failure.
 *
 * Skipped without TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert');

const DB_URL = process.env.TEST_DATABASE_URL;
const skip = !DB_URL ? 'TEST_DATABASE_URL not set (needs a disposable, migrated Postgres)' : false;
if (DB_URL) {
  process.env.DATABASE_URL = DB_URL;
  if (!process.env.DATABASE_SSL) process.env.DATABASE_SSL = 'false';
}

let db;
if (DB_URL) db = require('../../db/client');

function stub(modPath, exportsObj) {
  const p = require.resolve(modPath);
  const prev = require.cache[p];
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
  return () => { if (prev) require.cache[p] = prev; else delete require.cache[p]; };
}

function freshScheduler() {
  delete require.cache[require.resolve('../../lib/qbAcceptanceReportScheduler')];
  return require('../../lib/qbAcceptanceReportScheduler');
}

test.beforeEach(async () => {
  if (!DB_URL) return;
  await db.query(`DELETE FROM qb_acceptance_report_schedule`);
});

test('startSchedule -> processDueReports: the 24h window fires at (and not before) 24h, never the 72h/7d windows early', { skip }, async () => {
  const scheduler = freshScheduler();
  const recoveredAt = new Date(Date.now() - 24 * 60 * 60 * 1000 - 60 * 1000); // just over 24h ago
  await scheduler.startSchedule(recoveredAt);

  const restoreReportScript = stub('../../scripts/qbPostRecoveryAcceptanceReport', { buildReport: async () => ({ verdict: { ok: true } }) });
  try {
    const sent = [];
    const result = await scheduler.processDueReports(async (p) => { sent.push(p.windowKey); });
    assert.deepStrictEqual(sent, ['report_24h']);
    assert.deepStrictEqual(result.sent, ['report_24h']);

    const { rows } = await db.query(`SELECT report_24h_sent_at, report_72h_sent_at, report_7d_sent_at FROM qb_acceptance_report_schedule`);
    assert.ok(rows[0].report_24h_sent_at, 'report_24h_sent_at must now be set in the real row');
    assert.strictEqual(rows[0].report_72h_sent_at, null);
    assert.strictEqual(rows[0].report_7d_sent_at, null);
  } finally { restoreReportScript(); }
});

test('processDueReports: calling it twice in a row never sends the same window twice (real DB-backed duplicate prevention)', { skip }, async () => {
  const scheduler = freshScheduler();
  const recoveredAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await scheduler.startSchedule(recoveredAt);

  const restoreReportScript = stub('../../scripts/qbPostRecoveryAcceptanceReport', { buildReport: async () => ({ verdict: {} }) });
  try {
    const sendCalls = [];
    const sendFn = async (p) => { sendCalls.push(p.windowKey); };
    await scheduler.processDueReports(sendFn);
    await scheduler.processDueReports(sendFn);
    assert.deepStrictEqual(sendCalls, ['report_24h'], 'the second call must see report_24h already sent and skip it — never a duplicate email');
  } finally { restoreReportScript(); }
});

test('a fresh failure (supersedeActiveSchedule) stops the schedule from ever firing a report for it again', { skip }, async () => {
  const scheduler = freshScheduler();
  const recoveredAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const scheduleId = await scheduler.startSchedule(recoveredAt);

  await scheduler.supersedeActiveSchedule();

  const { rows } = await db.query(`SELECT superseded_at FROM qb_acceptance_report_schedule WHERE id = $1`, [scheduleId]);
  assert.ok(rows[0].superseded_at, 'must be marked superseded');

  const result = await scheduler.processDueReports(async () => { throw new Error('must never be called'); });
  assert.strictEqual(result.processed, false);
  assert.strictEqual(result.reason, 'no_active_schedule', 'a superseded schedule must never be picked up as active');
});

test('startSchedule called a second time (a new recovery) supersedes the prior active schedule and anchors a fresh one', { skip }, async () => {
  const scheduler = freshScheduler();
  const firstRecoveredAt = new Date(Date.now() - 100 * 60 * 60 * 1000);
  const firstId = await scheduler.startSchedule(firstRecoveredAt);

  const secondRecoveredAt = new Date(Date.now() - 1 * 60 * 60 * 1000);
  const secondId = await scheduler.startSchedule(secondRecoveredAt);

  const { rows: firstRow } = await db.query(`SELECT superseded_at FROM qb_acceptance_report_schedule WHERE id = $1`, [firstId]);
  assert.ok(firstRow[0].superseded_at, 'the prior schedule must be superseded by a fresh recovery');

  const active = await scheduler.getActiveSchedule();
  assert.strictEqual(active.id, secondId);
  assert.strictEqual(new Date(active.recovery_verified_at).toISOString(), secondRecoveredAt.toISOString());
});

test('all three windows due at once (a long gap, e.g. a watchdog outage) sends all three and persists all three timestamps', { skip }, async () => {
  const scheduler = freshScheduler();
  const recoveredAt = new Date(Date.now() - 200 * 60 * 60 * 1000); // past all three thresholds
  await scheduler.startSchedule(recoveredAt);

  const restoreReportScript = stub('../../scripts/qbPostRecoveryAcceptanceReport', { buildReport: async () => ({ verdict: {} }) });
  try {
    const sent = [];
    await scheduler.processDueReports(async (p) => { sent.push(p.windowKey); });
    assert.deepStrictEqual(sent.sort(), ['report_24h', 'report_72h', 'report_7d']);

    const { rows } = await db.query(`SELECT report_24h_sent_at, report_72h_sent_at, report_7d_sent_at FROM qb_acceptance_report_schedule`);
    assert.ok(rows[0].report_24h_sent_at);
    assert.ok(rows[0].report_72h_sent_at);
    assert.ok(rows[0].report_7d_sent_at);
  } finally { restoreReportScript(); }
});
