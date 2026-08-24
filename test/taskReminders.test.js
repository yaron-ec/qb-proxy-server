/* eslint-disable no-undef */
/**
 * taskReminders.test.js — Railway task reminder engine.
 *
 * Verifies (no real email, no DB):
 *   - taskKey idempotency shape + determinism
 *   - taskBody renders the gold-header card
 *   - listDueSoonTasks filters to the 15-min window (mocked rda)
 *   - dry-run => no sends, returns stats
 *
 * Run: cd src/proxy-server && node --test test/taskReminders.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Mock railwayDataAccess before requiring the engine.
const rdaPath = require.resolve('../lib/railwayDataAccess');
const now = Date.now();
const soon = new Date(now + 5 * 60000);
const soonDate = soon.toISOString().slice(0, 10);
const soonTime = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;

const tasks = [
  { id: 't1', title: 'Call Jane', due_date: new Date(now + 5 * 60000).toISOString().slice(0, 10), due_time: '09:00', completed: false, assigned_to: 'rep@x.com' },
  { id: 't2', title: 'Past', completed: true, completed_at: new Date().toISOString() },
  { id: 't3', title: 'Send estimate', due_date: soonDate, due_time: soonTime, completed: false, assigned_to: 'rep@x.com' },
];

delete require.cache[rdaPath];
require.cache[rdaPath] = { id: rdaPath, filename: rdaPath, loaded: true, exports: {
  list: async () => tasks,
  get: async () => null,
} };

const task = require('../lib/taskReminderEngine');

test('taskKey is deterministic', () => {
  assert.strictEqual(task.taskKey('t1', '2026-08-03T09:00'), 'task-reminder:t1:2026-08-03T09:00');
  assert.strictEqual(task.taskKey('t1', '2026-08-03T09:00'), task.taskKey('t1', '2026-08-03T09:00'));
});

test('taskBody contains title + gold header', () => {
  const html = task.taskBody({ title: 'Call Jane', dueDate: 'Aug 3, 2026', dueTime: '9:00 AM', leadName: 'Jane Doe', notes: 'Follow up' });
  assert.ok(html.includes('⏰ Task Reminder'));
  assert.ok(html.includes('Call Jane'));
  assert.ok(html.includes('Jane Doe'));
  assert.ok(html.includes('Follow up'));
});

test('listDueSoonTasks filters to incomplete + 15-min window', async () => {
  const list = await task.listDueSoonTasks();
  assert.ok(list.some(t => t.id === 't3'), 't3 (near-future) included');
  assert.ok(!list.some(t => t.id === 't2'), 'completed task excluded');
});

test('dry-run returns stats without sending', async () => {
  const r = await task.processTaskReminders({ dryRun: true, triggeredBy: 'test' });
  assert.strictEqual(r.dryRun, true);
  assert.ok(r.stats);
  assert.ok(r.stats.eligible >= 0);
});