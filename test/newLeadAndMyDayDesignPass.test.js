/* eslint-disable no-undef */
'use strict';

/**
 * newLeadAndMyDayDesignPass.test.js — regression coverage for the New Lead
 * (LeadCapture.jsx) and My Day (MobileDayView.jsx) design-pass changes.
 *
 * LeadCapture.jsx: the 9-card intake form had no progress indication beyond
 * a single stray "Step 1:" prefix on the first card's title. Added a
 * step/totalSteps prop to FormCard (a numbered badge + "N / 9" indicator)
 * and applied it consistently across all 9 cards. No scheduling/business
 * rule touched — purely a numbering/progress affordance.
 *
 * MobileDayView.jsx ("My Day"): added (a) an overdue-follow-ups count in
 * the header, computed from the already-fetched allLeads list (no new API
 * call, no fabricated data), and (b) a "Next Up" visual treatment on the
 * first appointment in the today view, so the single most important
 * appointment is visually distinct from the rest of the list. No travel-
 * time/ETA was invented — this codebase has no existing travel-time
 * calculation to preserve, and fabricating one would need a new maps API
 * integration, out of scope for a design pass.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

function readPage(rel) {
  return fs.readFileSync(path.join(frontendSrc, 'pages', rel), 'utf8');
}

test('LeadCapture.jsx: FormCard supports numbered steps', () => {
  const src = readPage('LeadCapture.jsx');
  assert.ok(src.includes('function FormCard({ title, icon, children, step, totalSteps })'), 'FormCard must accept step/totalSteps');
  assert.ok(src.includes('{step} / {totalSteps}'), 'must render the progress indicator');
});

test('LeadCapture.jsx: all 9 form cards are numbered 1 through 9', () => {
  const src = readPage('LeadCapture.jsx');
  for (let i = 1; i <= 9; i++) {
    assert.ok(src.includes(`step={${i}} totalSteps={9}`), `expected step={${i}} totalSteps={9} on some FormCard`);
  }
});

test('LeadCapture.jsx: scheduling/appointment logic untouched (same availability fetch + override flow)', () => {
  const src = readPage('LeadCapture.jsx');
  assert.ok(src.includes('fetchCaptureAvailability'), 'availability fetch must still be present');
  assert.ok(src.includes('canOverride'), 'admin override flow must still be present');
});

test('MobileDayView.jsx: computes overdue follow-ups from already-fetched leads (no new API call)', () => {
  const src = readPage('MobileDayView.jsx');
  assert.ok(src.includes('const overdueFollowUps = allLeads.filter'), 'must derive from the existing allLeads state, not a new fetch');
  assert.ok(src.includes('overdue follow-up'), 'must render the count in the header');
});

test('MobileDayView.jsx: the first today appointment gets a "Next Up" treatment', () => {
  const src = readPage('MobileDayView.jsx');
  assert.ok(src.includes('isNext={idx === 0 && dateFilter === "today"}'), 'must flag only the first today appointment as next');
  assert.ok(src.includes('Next Up'), 'must render a Next Up label');
});

test('MobileDayView.jsx: no fabricated travel-time/ETA calculation was introduced', () => {
  const src = readPage('MobileDayView.jsx');
  assert.ok(!/travel.?time|eta\b|drivingDuration/i.test(src), 'must not invent a travel-time estimate the backend does not provide');
});
