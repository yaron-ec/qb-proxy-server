/* eslint-disable no-undef */
'use strict';

/**
 * crmVisualConsistencyPass.test.js — regression coverage for the "final CRM
 * visual consistency + workspace completion" pass.
 *
 * AUDIT FINDINGS this pass confirmed (not re-litigated, just verified):
 *   - Lead status badges were ALREADY unified via lib/design-system.js's
 *     statusBadgeClass(), shared by Dashboard, LeadsModern, LeadDetailModern,
 *     FollowUpsWidget, and DealsPanel — no rework needed there.
 *   - components/ContactActions.jsx was ALREADY a shared Call/SMS/Email
 *     component with sm/md/lg size variants, used by LeadsModern,
 *     FollowUpsWidget, and LeadDetailModern.
 *
 * REAL gaps found and fixed:
 *   - Active Leads and Deals both rendered one full-1600px-wide card per
 *     row (`grid gap-3` with no column count) — large cards, wasted
 *     horizontal space. Fixed to a responsive multi-column grid.
 *   - ContactInfoEditor.jsx (built in the prior pass) used a bespoke
 *     Call/SMS/Email implementation instead of the existing canonical
 *     ContactActions component — exactly the kind of drift this pass is
 *     meant to prevent. Fixed to reuse it.
 *   - Action colors disagreed across pages for the same action: My Day's
 *     Email tile was violet (everywhere else amber) and its Navigate tile
 *     was amber (colliding with Email's canonical color elsewhere).
 *     Established one canonical mapping (Call=green, SMS=blue, Email=amber,
 *     Navigate/Directions/View Property=indigo) and aligned every site.
 *   - The sidebar truncated "EC Construction Group" to "EC Construction
 *     Grou…" (nowrap + ellipsis on the brand text container). Fixed to
 *     wrap onto two lines, with the sidebar widened slightly (224→240px)
 *     for room — collapsed (icon-only) width is unchanged.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');
function read(rel) { return fs.readFileSync(path.join(frontendSrc, rel), 'utf8'); }

// ── Canonical status badge system (audit — confirm still shared, not re-forked) ──

test('Dashboard/LeadsModern/LeadDetailModern/FollowUpsWidget/DealsPanel all import the ONE shared statusBadgeClass', () => {
  for (const rel of ['pages/Dashboard.jsx', 'pages/LeadsModern.jsx', 'pages/LeadDetailModern.jsx', 'components/FollowUpsWidget.jsx', 'components/DealsPanel.jsx']) {
    const src = read(rel);
    assert.ok(/from ["']@\/lib\/design-system["']/.test(src) && src.includes('statusBadgeClass'), `${rel} must use the shared statusBadgeClass, not a local status-color map`);
  }
});

// ── Canonical action-button system ──────────────────────────────────────────

test('ContactActions.jsx documents ONE canonical semantic color mapping for Call/SMS/Email/Navigate', () => {
  const src = read('components/ContactActions.jsx');
  assert.ok(/Call\s*→\s*green\/emerald/.test(src));
  assert.ok(/SMS[^\n]*→\s*blue/.test(src));
  assert.ok(/Email\s*→\s*amber/.test(src));
  assert.ok(/indigo/.test(src));
});

test('ContactInfoEditor.jsx (Lead Detail Contact card) reuses the shared ContactActions component, not a bespoke implementation', () => {
  const src = read('components/ContactInfoEditor.jsx');
  assert.ok(src.includes("import ContactActions from '@/components/ContactActions'"), 'must import the canonical shared component');
  assert.ok(src.includes('<ContactActions'), 'must render it');
  assert.ok(!/href=\{`tel:/.test(src), 'must not hand-roll its own tel: link — that duplicates ContactActions');
  assert.ok(!/href=\{`sms:/.test(src), 'must not hand-roll its own sms: link — that duplicates ContactActions');
});

test('ContactInfoEditor.jsx: Directions/View Property use the canonical indigo location-action color, not an ad hoc blue/slate', () => {
  const src = read('components/ContactInfoEditor.jsx');
  const fn = src.slice(src.indexOf('function AddressMapActions'), src.indexOf('function AddressMapActions') + 900);
  assert.ok(fn.includes('text-indigo-700') && fn.includes('bg-indigo-50'), 'Directions/View Property must use the canonical indigo family');
});

test('MobileDayView.jsx QuickActions: Email is amber and Navigate is indigo, matching the canonical mapping (was violet/amber — a collision with Email)', () => {
  const src = read('pages/MobileDayView.jsx');
  const quickActions = src.slice(src.indexOf('function QuickActions'), src.indexOf('function QuickActions') + 2200);
  assert.ok(quickActions.includes('bg-amber-50') && quickActions.includes('text-amber-600') && quickActions.includes('>Email<'), 'Email tile must be amber');
  assert.ok(quickActions.includes('bg-indigo-50') && quickActions.includes('text-indigo-600') && quickActions.includes('>Navigate<'), 'Navigate tile must be indigo, not colliding with Email\'s amber');
  assert.ok(!quickActions.includes('violet'), 'the old off-canon violet Email tile must be gone');
});

test('MobileDayView.jsx QuickActions: tile grid layout/size preserved (action-first density, not shrunk to Active Leads density)', () => {
  const src = read('pages/MobileDayView.jsx');
  const quickActions = src.slice(src.indexOf('function QuickActions'), src.indexOf('function QuickActions') + 2200);
  assert.ok(quickActions.includes('grid grid-cols-4 gap-2'), 'the larger 4-tile action grid must be unchanged');
});

// ── Active Leads / Deals — wide-desktop space usage ─────────────────────────

test('LeadsModern.jsx: Active Leads uses a responsive multi-column grid, not one full-width card per row', () => {
  const src = read('pages/LeadsModern.jsx');
  assert.ok(/grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3/.test(src), 'must define a responsive column count for the leads grid');
  assert.ok(!/<div className="grid gap-3">\s*\n\s*\{filteredLeads\.map/.test(src), 'the old columnless single-row-per-card grid must be gone');
});

test('Deals.jsx: deal list also uses a responsive multi-column grid (same defect, cross-product consistency)', () => {
  const src = read('pages/Deals.jsx');
  assert.ok(/grid grid-cols-1 lg:grid-cols-2 gap-3/.test(src), 'must define a responsive column count for the deals grid');
});

test('LeadsModern.jsx: preserves search/filters/sort/New Lead/Website Leads/overdue indicator (no functionality removed)', () => {
  const src = read('pages/LeadsModern.jsx');
  for (const marker of ['isGlobalSearch', 'New Lead', 'STATUS_STYLES', 'ContactActions']) {
    assert.ok(src.includes(marker), `must preserve existing functionality: ${marker}`);
  }
});

// ── Sidebar company name truncation fix ─────────────────────────────────────

test('Layout.jsx: full company name is never truncated with an ellipsis in expanded mode', () => {
  const src = read('components/Layout.jsx');
  const nameIdx = src.indexOf('companyIdentity.name');
  const brandBlock = src.slice(Math.max(0, nameIdx - 500), nameIdx + 200);
  assert.ok(!/textOverflow:\s*['"]ellipsis['"]/.test(brandBlock), 'the brand name container must not force ellipsis truncation');
  assert.ok(!/whiteSpace:\s*['"]nowrap['"]/.test(brandBlock), 'the brand name container must not force a single line that clips the name');
  assert.ok(brandBlock.includes('break-words'), 'must allow the name to wrap onto a second line instead of clipping');
});

test('Layout.jsx: expanded sidebar width was adjusted (slightly) to give the full name room; collapsed width is untouched', () => {
  const src = read('components/Layout.jsx');
  assert.ok(/collapsed \? 64 : 240/.test(src), 'expanded width should be modestly widened (224→240); collapsed icon-only width (64) must be unchanged');
});

test('Layout.jsx: still sources identity from company_settings, not a literal hardcoded name in the fix', () => {
  const src = read('components/Layout.jsx');
  assert.ok(src.includes('companyIdentity.name') && src.includes('companyIdentity.location'), 'must still render from fetched/fallback state, not a literal string');
});
