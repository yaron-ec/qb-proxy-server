/* eslint-disable no-undef */
'use strict';

/**
 * followUpCompletedNotOverdue.test.js — a follow-up marked completed is
 * history and must never show as Overdue (production: a migrated 2025
 * follow-up marked completed still showed a red Overdue badge on the Leads
 * list, because the badge read follow_up_date only). FollowUpsWidget already
 * skipped completed follow-ups; the Leads list, Kanban card and My Day
 * overdue counter now apply the same rule.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'crm-frontend', 'src', f), 'utf8');

test('Leads list: getFollowUpStatus returns completed (never overdue) for a completed follow-up, at every call site', () => {
  const s = src('pages/LeadsModern.jsx');
  const fn = s.match(/function getFollowUpStatus\(date, status\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'getFollowUpStatus takes the follow-up status');
  // Evaluate the real function with a fixed "today".
  const getFollowUpStatus = new Function('parseFollowUpDate', 'getTodayLocal', `${fn[0]}; return getFollowUpStatus;`)(
    (d) => Number(String(d).slice(0, 10).replace(/-/g, '')), () => 20260928);
  assert.strictEqual(getFollowUpStatus('2025-06-03', 'completed'), 'completed');
  assert.strictEqual(getFollowUpStatus('2025-06-03', null), 'overdue');
  assert.strictEqual(getFollowUpStatus('2025-06-03', 'pending'), 'overdue');
  assert.strictEqual(getFollowUpStatus('2026-09-28', 'pending'), 'today');
  assert.doesNotMatch(s, /getFollowUpStatus\((l|lead)\.follow_up_date\)/, 'every caller passes follow_up_status');
});

test('Kanban card and My Day overdue counter skip completed follow-ups (same rule as FollowUpsWidget)', () => {
  assert.match(src('pages/KanbanBoard.jsx'), /const isOverdue = !done && fuNum !== null && fuNum < todayNum/);
  assert.match(src('pages/MobileDayView.jsx'), /l\.follow_up_date < today && l\.follow_up_status !== 'completed'/);
  assert.match(src('components/FollowUpsWidget.jsx'), /l\.follow_up_status === 'completed'\) continue/);
});
