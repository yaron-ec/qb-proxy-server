/* eslint-disable no-undef */
'use strict';

/**
 * leadsPageDesignPass.test.js — regression coverage for the LeadsModern.jsx
 * and LeadDetailModern.jsx hierarchy improvements made during the
 * page-level CRM design pass.
 *
 * LeadsModern.jsx (Leads list): added an overdue-follow-up count in the
 * header, a Project Type line on each card (previously absent entirely),
 * and de-emphasized Owner/Created/Source as secondary metadata relative to
 * directly-actionable Phone/Email/City.
 *
 * LeadDetailModern.jsx (Lead Detail, the flagship screen): added a
 * NextActionBanner — a single deterministic "what should I do next" summary
 * derived from existing follow_up_date/appointment_date fields (overdue /
 * today / upcoming / no-follow-up-scheduled), rendered directly under the
 * status badges at the top of the identity block. No new business rule —
 * purely a display-layer summary of data already shown in the Schedule
 * section further down the page.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

function readFile(rel) {
  return fs.readFileSync(path.join(frontendSrc, 'pages', rel), 'utf8');
}

test('LeadsModern.jsx: header surfaces an overdue-follow-up count', () => {
  const src = readFile('LeadsModern.jsx');
  assert.ok(src.includes('overdueCount'), 'must compute an overdue count');
  assert.ok(src.includes('overdue follow-up'), 'must render it in the header');
});

test('LeadsModern.jsx: lead cards show project_type (previously absent)', () => {
  const src = readFile('LeadsModern.jsx');
  assert.ok(src.includes('lead.project_type'), 'must render the lead\'s project type on the card');
});

test('LeadsModern.jsx: Owner/Created/Source are visually secondary to Phone/Email/City', () => {
  const src = readFile('LeadsModern.jsx');
  // The secondary metadata row uses a muted, smaller text class than the
  // actionable-contact row above it.
  assert.ok(/text-\[11px\] text-slate-400/.test(src), 'secondary metadata row must be visually muted');
});

test('LeadDetailModern.jsx: defines nextActionFor() as a pure function of existing fields (no new business rule)', () => {
  const src = readFile('LeadDetailModern.jsx');
  assert.ok(src.includes('function nextActionFor(lead)'), 'must define the next-action helper');
  assert.ok(src.includes('function NextActionBanner'), 'must define the banner component');
  assert.ok(src.includes('<NextActionBanner lead={lead} />'), 'must render it in the identity block');
});

test('LeadDetailModern.jsx: nextActionFor covers overdue, today, upcoming, and no-schedule cases', () => {
  const src = readFile('LeadDetailModern.jsx');
  for (const tone of ['overdue', 'today', 'upcoming', 'action']) {
    assert.ok(src.includes(`tone: "${tone}"`), `must handle the "${tone}" case`);
  }
});

test('LeadDetailModern.jsx: reuses the canonical date helpers from lib/sortActiveLeads (no duplicated date-math)', () => {
  const src = readFile('LeadDetailModern.jsx');
  assert.ok(src.includes(`from "@/lib/sortActiveLeads"`), 'must import parseFollowUpDate/getTodayLocal rather than reimplementing them');
});
