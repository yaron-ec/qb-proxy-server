/* eslint-disable no-undef */
'use strict';

/**
 * kanbanCardDesignPass.test.js — regression coverage for the Kanban card
 * consistency fixes made during the page-level design pass. The board
 * structure itself (columns, drag-and-drop, horizontal scroll) was judged
 * fundamentally good and left untouched — only card-level content gaps
 * were fixed:
 *
 *   - Deal value (estimated_value) was not shown on cards at all — added,
 *     reusing the same field/format LeadsModern.jsx already displays.
 *   - The follow-up date badge was always blue regardless of how overdue
 *     it was — now uses the same overdue/today/upcoming color logic
 *     (parseFollowUpDate/getTodayLocal from lib/sortActiveLeads) already
 *     established on the Leads list and My Day.
 *
 * NOT added: a stage-age / "days in this column" indicator. There is no
 * status-change timestamp field in the data model (only updated_date,
 * which changes on ANY edit, not just a status move) — fabricating an age
 * indicator from the wrong field would misrepresent staleness, which is
 * exactly the kind of invented signal this pass was told not to introduce.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.resolve(__dirname, '..', 'crm-frontend', 'src', 'pages', 'KanbanBoard.jsx'),
  'utf8'
);

test('KanbanBoard.jsx: cards show deal value when present', () => {
  assert.ok(src.includes('lead.estimated_value > 0'), 'must check for a positive estimated_value');
  assert.ok(src.includes('${lead.estimated_value.toLocaleString()}'), 'must render the formatted value');
});

test('KanbanBoard.jsx: follow-up badge color reflects overdue/today/upcoming, not a flat blue', () => {
  assert.ok(src.includes('const isOverdue = fuNum !== null && fuNum < todayNum'));
  assert.ok(src.includes('const isToday = fuNum !== null && fuNum === todayNum'));
  assert.ok(src.includes('text-red-700 bg-red-50'), 'overdue must render in red');
  assert.ok(src.includes('text-amber-700 bg-amber-50'), 'today must render in amber');
});

test('KanbanBoard.jsx: reuses the canonical date helpers (no duplicated date-math)', () => {
  assert.ok(src.includes(`from "@/lib/sortActiveLeads"`));
});

test('KanbanBoard.jsx: no fabricated stage-age/staleness field was introduced', () => {
  assert.ok(!/days.?in.?(column|stage|status)|stageAge|status_changed/i.test(src), 'must not invent an age signal from a field that does not track it');
});
