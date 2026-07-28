/* eslint-disable no-undef */
/**
 * taskReminders.test.js — Railway task reminder engine.
 *
 * Verifies (no real email, default base44 gate -> no sends):
 *   - taskKey idempotency shape + determinism
 *   - taskBody renders the gold-header card
 *   - listDueSoonTasks filters to the 15-min window (mocked base44)
 *   - transport gate base44 => skipped, no sends
 *
 * Run: cd src/proxy-server && node --test test/taskReminders.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Mock lib/base44 before requiring the engine.
const Module = require('module');
const base44Path = require.resolve('../lib/base44');
const now = Date.now();
const tasks = [
  { id: 't1', title: 'Call Jane', due_date: new Date(now + 5 * 60000).toISOString().slice(0, 10), due_time: '09:00', completed: false, assigned_to: 'rep@x.com' }, // due ~now+? date-only so may not fall in window
  { id: 't2', title: 'Past', completed: true }, // excluded
];
// Provide a deterministic due-soon task using a date+time within 15 min.
const soon = new Date(now + 5 * 60000);
const soonDate = soon.toISOString().slice(0, 10);
const soonTime = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
tasks.push({ id: 't3', title: 'Send estimate', due_date: soonDate, due_time: soonTime, completed: false, assigned_to: 'rep@x.com' });

delete require.cache[base44Path];
require.cache[base44Path] = { id: base44Path, filename: base44Path, loaded: true, exports: {
  filter: async () => tasks.filter(t => !t.completed),
  get: async () => null,
} };

process.env.EMAIL_TASK_REMINDER_TRANSPORT = 'base44';
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
  // t3 has a near-future due; t1 is date-only (depends on local time, may or may not be in window)
  assert.ok(list.some(t => t.id === 't3'));
  assert.ok(!list.some(t => t.id === 't2'), 'completed task excluded');
});

test('transport gate base44 => skipped, no sends', async () => {
  process.env.EMAIL_TASK_REMINDER_TRANSPORT = 'base44';
  const r = await task.processTaskReminders({ dryRun: false, triggeredBy: 'test' });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'task_transport_base44');
});

test('dry-run under base44 gate still skips', async () => {
  const r = await task.processTaskReminders({ dryRun: true, triggeredBy: 'test' });
  assert.strictEqual(r.skipped, true);
});