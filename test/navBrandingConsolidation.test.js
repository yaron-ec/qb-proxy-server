/* eslint-disable no-undef */
'use strict';

/**
 * navBrandingConsolidation.test.js — regression coverage for the "My Day" /
 * "Appointment Map" nav consolidation and the sidebar company-branding fix.
 *
 * ORIGINAL DEFECT #1: production exposed "My Day" and "Appointment Map" as
 * two separate primary sidebar destinations for the same daily
 * scheduling/routing workflow, with My Day's map view being a simpler,
 * geocoding-only duplicate of the real traffic-aware routing implementation
 * in pages/DailyMap.jsx (backed by routes/routing.js). FIX: My Day is now
 * the single canonical destination; its Map view lazy-renders the real
 * DailyMap page directly (zero duplicated routing logic). '/daily-map'
 * remains a backward-compatible deep link that redirects into
 * '/my-day?view=map'.
 *
 * ORIGINAL DEFECT #2: the sidebar hardcoded "EC Construction" / "Los
 * Angeles, CA" directly in Layout.jsx. FIX: the shell now sources company
 * name/city/state from the canonical company_settings singleton (via
 * GET /api/v1/company-settings), falling back to "EC Construction Group" /
 * "Los Angeles, CA" until Company Setup has real data for a given
 * deployment — no employee name is used to infer a region.
 *
 * ORIGINAL DEFECT #3 (found investigating #2): CompanySettingsTab.jsx
 * treated the `{ settings: {...} | null }` GET/PUT envelope as if it were
 * the flat settings object itself, so `if (data)` was always true and every
 * field (`form.company_name`, etc.) read as undefined — Company Setup could
 * never actually display or persist real values. FIX: unwrap `.settings`
 * from both the GET and PUT responses.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');

function read(rel) {
  return fs.readFileSync(path.join(frontendSrc, rel), 'utf8');
}

test('Layout.jsx: sidebar has exactly one canonical My Day nav destination, no separate Appointment Map', () => {
  const src = read('components/Layout.jsx');
  const navItemsBlock = src.slice(src.indexOf('const NAV_ITEMS'), src.indexOf('];', src.indexOf('const NAV_ITEMS')));
  assert.ok(navItemsBlock.includes('"/my-day"'), 'My Day must be a primary nav item');
  assert.ok(!navItemsBlock.includes('/daily-map'), 'Appointment Map / daily-map must no longer be a separate primary nav item');
  assert.ok(!navItemsBlock.includes('Appointment Map'), 'the "Appointment Map" label must not appear in primary nav');
  const navItemMatches = navItemsBlock.match(/path:\s*"\/my-day"/g) || [];
  assert.strictEqual(navItemMatches.length, 1, 'exactly one My Day nav entry expected');
});

test('App.jsx: /daily-map is a backward-compatible redirect into My Day\'s map view, not a separately rendered page', () => {
  const src = read('App.jsx');
  assert.ok(!src.includes("import DailyMap from './pages/DailyMap'"), 'DailyMap must no longer be directly rendered as its own route');
  assert.ok(src.includes('path="/daily-map"'), 'the /daily-map route must still exist for deep-link compatibility');
  const dailyMapRoute = src.slice(src.indexOf('path="/daily-map"'), src.indexOf('path="/daily-map"') + 200);
  assert.ok(dailyMapRoute.includes('Navigate to="/my-day?view=map"'), '/daily-map must redirect into /my-day?view=map');
  assert.ok(dailyMapRoute.includes('replace'), 'the redirect must use replace (no back-button loop)');
});

test('MobileDayView.jsx: Map view lazily renders the canonical DailyMap page (no duplicate routing/geocoding implementation)', () => {
  const src = read('pages/MobileDayView.jsx');
  assert.ok(src.includes('React.lazy(() => import("@/pages/DailyMap"))'), 'My Day must lazy-load the real DailyMap page for its Map view');
  assert.ok(!src.includes('function MobileMapContainer'), 'the old geocoding-only MobileMapContainer duplicate must be removed');
  assert.ok(!src.includes('MAP_PANEL_HEIGHT'), 'the old fixed-height map panel from the duplicate implementation must be removed');
  assert.ok(src.includes('view === "map"') , 'My Day must still branch on a List/Map view state');
});

test('MobileDayView.jsx: initial view state supports the /my-day?view=map deep link', () => {
  const src = read('pages/MobileDayView.jsx');
  const stateInit = src.slice(src.indexOf('const [view, setView]'), src.indexOf('const [view, setView]') + 200);
  assert.ok(stateInit.includes('URLSearchParams'), 'view state must read the ?view= query param on mount');
  assert.ok(stateInit.includes('"map"'), 'view state must recognize ?view=map');
});

test('MobileNav.jsx: mobile bottom nav has no separate Appointment Map entry (unaffected by desktop nav change)', () => {
  const src = read('components/MobileNav.jsx');
  assert.ok(!src.includes('Appointment Map'), 'mobile nav must not have a duplicate Appointment Map entry');
  assert.ok(src.includes('/my-day'), 'mobile nav must still link to My Day');
});

test('Layout.jsx: sidebar company identity is configuration-driven, not a hardcoded employee-derived region', () => {
  const src = read('components/Layout.jsx');
  assert.ok(!src.includes('>EC Construction<'), 'the abbreviated hardcoded "EC Construction" must be removed from the rendered sidebar');
  assert.ok(src.includes('DEFAULT_COMPANY_NAME = "EC Construction Group"'), 'the full, correct company name must be the fallback default');
  assert.ok(src.includes('companySettings'), 'sidebar identity must be sourced from the company-settings API module');
  assert.ok(src.includes('companyIdentity.name') && src.includes('companyIdentity.location'), 'the rendered brand block must use fetched/fallback state, not literal strings');
  // Must not hardcode a region by employee identity/email.
  assert.ok(!/SoCal|NorCal/.test(src), 'no fabricated SoCal/NorCal region concept (no such data exists in company_settings today)');
  assert.ok(!/yaron@ecconstructiongroup\.com.*SoCal|ethan@ecconstructiongroup\.com.*NorCal/i.test(src), 'region must never be derived from a hardcoded employee identity');
});

test('CompanySettingsTab.jsx: unwraps the { settings } envelope from both GET and PUT instead of storing the wrapper', () => {
  const src = read('components/CompanySettingsTab.jsx');
  assert.ok(src.includes('res?.settings || null'), 'GET response must be unwrapped via its settings field');
  assert.ok(!/railwayCompanySettings\.get\(\)\.then\(data => \{\s*if \(data\)/.test(src), 'must not treat the raw GET envelope object as the flat settings record');
  const doSaveFn = src.slice(src.indexOf('const doSave'), src.indexOf('const set = '));
  assert.ok(doSaveFn.includes('res?.settings || null') || /const updated = res\?\.settings/.test(doSaveFn), 'PUT response must also be unwrapped via its settings field');
});
