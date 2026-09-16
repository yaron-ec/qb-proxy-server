/* eslint-disable no-undef */
'use strict';

/**
 * productionVisualCorrection.test.js — regression coverage for the
 * production visual-acceptance correction: root-caused a lack of any
 * shared page-width system (every page hardcoded its own "max-w-7xl" or,
 * on Financials, "max-w-4xl"), causing large desktop viewports to show
 * data-dense screens floating in unused space while Financials was
 * compressed into a narrow column. Also fixes the specific hierarchy
 * findings from a real production visual inspection: a vertical KPI stack
 * competing with Dashboard's "Today's Work," an oversized blue "Open
 * Handoff" button dominating Lead Detail's center column over the
 * customer's own identity/next-action, and a sidebar defaulting to its
 * collapsed icon-only state as the permanent desktop shell.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

function read(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), 'utf8');
}

test('lib/design-system.js defines canonical page-width tokens', () => {
  const src = read('lib/design-system.js');
  assert.ok(src.includes('export const PAGE_WIDTH_WIDE'));
  assert.ok(src.includes('export const PAGE_WIDTH_STANDARD'));
});

test('Dashboard/Leads/Reports/Deals use the wide container instead of max-w-7xl', () => {
  for (const rel of ['pages/Dashboard.jsx', 'pages/LeadsModern.jsx', 'pages/Reports.jsx', 'pages/Deals.jsx']) {
    const src = read(rel);
    assert.ok(!src.includes('max-w-7xl'), `${rel} must not use the old narrower max-w-7xl container`);
    assert.ok(src.includes('max-w-[1600px]'), `${rel} must use the wide page container`);
  }
});

test('FinancialsTab.jsx uses the wide container and a side-by-side grid for Collections + Cost Breakdown', () => {
  const src = read('components/financials/FinancialsTab.jsx');
  assert.ok(!src.includes('max-w-4xl mx-auto px-4 md:px-6 py-5 space-y-5'), 'the old narrow single-column wrapper must be gone from the main render paths');
  assert.ok(src.includes('max-w-[1600px] mx-auto'), 'must use the wide page container');
  assert.ok(src.includes('grid grid-cols-1 lg:grid-cols-2 gap-5'), 'Collections and CostBreakdown must sit side-by-side on desktop');
  // Detail/configuration sections stay at a comfortable reading width so
  // they do not visually compete with the headline financial picture.
  assert.ok(src.includes('max-w-4xl mx-auto w-full space-y-5'), 'detail/config sections must be narrower than the headline area');
});

test('index.css: .fin-figure-lg (the Financials hero numbers) is genuinely large, not merely text-2xl', () => {
  const src = fs.readFileSync(path.join(frontendSrc, 'index.css'), 'utf8');
  assert.ok(/\.fin-figure-lg\s*\{[^}]*text-2xl sm:text-3xl lg:text-4xl/.test(src), 'hero figures must scale up to text-4xl on large screens');
});

test('FollowUpsWidget.jsx: KPI summary is a horizontal strip, not a narrow fixed-width vertical column', () => {
  const src = read('components/FollowUpsWidget.jsx');
  assert.ok(!src.includes('lg:w-52'), 'the old fixed 208px vertical KPI column must be removed');
  assert.ok(src.includes('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5'), 'summary cards must render as a responsive horizontal row');
});

test('FollowUpsWidget.jsx: zero-value metrics are visually de-emphasized, not hidden', () => {
  const src = read('components/FollowUpsWidget.jsx');
  assert.ok(src.includes('const isZero ='), 'must detect zero-value metrics');
  assert.ok(src.includes("'bg-slate-50 border-slate-200 text-slate-400'"), 'zero metrics must render muted, not full-color');
});

test('LeadDetailModern.jsx: customer identity (avatar + name) is sized to lead visually', () => {
  const src = read('pages/LeadDetailModern.jsx');
  assert.ok(src.includes('w-14 h-14 rounded-xl'), 'avatar must be enlarged from the old w-11 h-11');
  assert.ok(src.includes('text-xl font-bold text-slate-900 flex-1 min-w-0 leading-tight break-words'), 'customer name must be enlarged from the old text-base');
});

test('LeadDetailModern.jsx: NextActionBanner is a full-width block, not a small inline pill', () => {
  const src = read('pages/LeadDetailModern.jsx');
  const bannerFn = src.slice(src.indexOf('function NextActionBanner'));
  assert.ok(bannerFn.includes('text-sm font-bold px-3 py-2.5'), 'banner text must be sized up from the old text-xs pill');
  assert.ok(!bannerFn.slice(0, 400).includes('inline-flex'), 'banner must no longer be a small inline-flex pill');
});

test('ProposalPanel.jsx: Open Handoff is a secondary action, not a dominant solid-blue block button', () => {
  const src = read('components/ProposalPanel.jsx');
  assert.ok(!src.includes('bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"'), 'must not render as a solid full-width blue block anymore');
  assert.ok(src.includes('border border-blue-200'), 'must render as an outlined secondary action instead');
});

test('Layout.jsx: sidebar defaults to expanded, not permanently collapsed to icon-only', () => {
  const src = read('components/Layout.jsx');
  assert.ok(!src.includes('useState(true)'), 'the sidebar must not hardcode collapsed=true as its default state');
  assert.ok(src.includes("localStorage.getItem('sidebar_collapsed')"), 'must read a persisted user preference instead of always starting collapsed');
});

test('mobile bottom nav and safe-area handling are untouched (responsive safety)', () => {
  const mobileNav = read('components/MobileNav.jsx');
  assert.ok(mobileNav.includes("fixed bottom-0 left-0 right-0"), 'mobile bottom nav must be unaffected by the desktop width/sidebar changes');
});
