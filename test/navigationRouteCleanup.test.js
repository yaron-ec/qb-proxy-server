/* eslint-disable no-undef */
'use strict';

/**
 * navigationRouteCleanup.test.js — regression guard for the route/navigation
 * cleanup performed during the CRM-wide visual/UX pass.
 *
 * FINDINGS (verified against source before removal, not assumed):
 *   - pages/AutomationCenter.jsx called apiCall('/api/v1/automations...') —
 *     no such backend route exists anywhere in routes/ or server.js. 100%
 *     non-functional, and shaped exactly like the "generic workflow builder"
 *     explicitly out of scope for this codebase. Removed, not wired into nav.
 *   - pages/EstimatesModern.jsx + EstimateDetail.jsx called
 *     apiCall('/api/v1/estimates...') — the real backend route is mounted at
 *     '/api/v1/handoff-estimates' (routes/handoffEstimates.js). 100%
 *     non-functional and fully superseded by the working
 *     HandoffEstimatesPanel embedded in Lead/Deal detail. Removed.
 *   - pages/DailyActionCenter.jsx was imported in App.jsx but never routed
 *     or linked anywhere — dead weight in the bundle. Removed.
 *   - '/my-day' (MobileDayView) was routed and reachable from the mobile
 *     bottom nav (components/MobileNav.jsx) but absent from the desktop
 *     sidebar (components/Layout.jsx) — a genuine orphaned-from-desktop-nav
 *     gap. Added to the desktop nav.
 *   - NAV_ITEMS_ALL and NAV_ITEMS_SALES_REP in Layout.jsx were two
 *     separately-maintained arrays with byte-identical contents (scaffolded
 *     role differentiation that was never implemented) — consolidated into
 *     one NAV_ITEMS array; this changes nothing a user sees, it just stops
 *     pretending two arrays reflect a real decision.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

function readFile(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), 'utf8');
}

test('the four confirmed-broken/dead pages are removed from disk', () => {
  for (const rel of [
    'pages/AutomationCenter.jsx',
    'pages/EstimatesModern.jsx',
    'pages/EstimateDetail.jsx',
    'pages/DailyActionCenter.jsx',
    'components/EstimateCard.jsx',
  ]) {
    assert.ok(!fs.existsSync(path.join(frontendSrc, rel)), rel + ' must be removed (confirmed non-functional or unreferenced)');
  }
});

test('App.jsx no longer imports or routes the removed pages', () => {
  const src = readFile('App.jsx');
  for (const name of ['AutomationCenter', 'EstimatesModern', 'EstimateDetail', 'DailyActionCenter']) {
    assert.ok(!src.includes(name), 'App.jsx must not reference ' + name);
  }
  assert.ok(!src.includes('path="/automations"'));
  assert.ok(!src.includes('path="/estimates"'));
});

test('Layout.jsx has one canonical NAV_ITEMS list (no duplicate identical arrays)', () => {
  const src = readFile('components/Layout.jsx');
  assert.ok(!/const NAV_ITEMS_ALL\s*=/.test(src), 'the old duplicate array declaration must be gone');
  assert.ok(!/const NAV_ITEMS_SALES_REP\s*=/.test(src), 'the old duplicate array declaration must be gone');
  assert.ok(src.includes('const NAV_ITEMS ='), 'must define one NAV_ITEMS array');
});

test('Layout.jsx desktop nav includes My Day (previously mobile-only)', () => {
  const src = readFile('components/Layout.jsx');
  assert.ok(/path:\s*"\/my-day"/.test(src), 'desktop sidebar must link to /my-day, matching mobile nav');
});

test('remaining routed pages in App.jsx all resolve to an existing file', () => {
  const src = readFile('App.jsx');
  const importLines = [...src.matchAll(/^import\s+(\w+)\s+from\s+['"]\.\/pages\/([\w/-]+)['"];?$/gm)];
  assert.ok(importLines.length > 5, 'sanity check: expected several page imports');
  for (const [, , rel] of importLines) {
    const candidates = [`${rel}.jsx`, `${rel}.js`, `${rel}/index.jsx`];
    const exists = candidates.some((c) => fs.existsSync(path.join(frontendSrc, 'pages', c)));
    assert.ok(exists, `App.jsx imports pages/${rel} but no matching file exists on disk`);
  }
});
