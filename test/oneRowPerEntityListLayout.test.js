/* eslint-disable no-undef */
'use strict';

/**
 * oneRowPerEntityListLayout.test.js — regression coverage for the "final
 * list layout correction": Active Leads and Deals were changed to a
 * multi-column card grid in the prior pass (2-3 cards per row), which felt
 * fragmented for an operational list. Corrected back to ONE entity per row,
 * with each row redesigned as a horizontal record using internal grid
 * regions (Identity/Project, Contact/Location, Ownership/Source, Next
 * Action, Actions for Leads; Identity, Project, Financial, Action for
 * Deals) so the wide desktop width is used INSIDE the row rather than by
 * tiling multiple cards across the screen.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');
function read(rel) { return fs.readFileSync(path.join(frontendSrc, rel), 'utf8'); }

// ── Exactly one Lead / one Deal per row ─────────────────────────────────────

test('LeadsModern.jsx: the leads list is single-column — one Lead occupies one full row', () => {
  const src = read('pages/LeadsModern.jsx');
  assert.ok(/<div className="grid grid-cols-1 gap-2\.5">\s*\{filteredLeads\.map/.test(src), 'the list container must be a plain single-column grid, not a multi-column card grid');
  assert.ok(!/lg:grid-cols-2 2xl:grid-cols-3/.test(src.slice(0, src.indexOf('function LeadCard'))), 'the multi-column grid from the prior pass must be gone from the list container');
});

test('Deals.jsx: the deals list is single-column — one Deal occupies one full row', () => {
  const src = read('pages/Deals.jsx');
  const listContainerRegion = src.slice(src.indexOf('export default function Deals'));
  assert.ok(/<div className="grid grid-cols-1 gap-2\.5">\s*\{sorted\.map/.test(listContainerRegion), 'the list container must be a plain single-column grid, not a multi-column card grid');
});

// ── Desktop: internal horizontal regions inside the row ─────────────────────

test('LeadsModern.jsx LeadCard: desktop row uses an internal grid of regions (Identity/Project, Contact/Location, Ownership/Source, Next Action, Actions)', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  assert.ok(/lg:grid lg:grid-cols-\[auto_[^\]]+\]/.test(cardFn), 'the row itself must define an internal multi-region grid at the lg breakpoint');
  assert.ok(cardFn.includes('Identity / Project') || cardFn.includes('Identity/Project'), 'must have an identity/project region');
  assert.ok(cardFn.includes('Contact / Location'), 'must have a contact/location region');
  assert.ok(cardFn.includes('Ownership / Source'), 'must have an ownership/source region');
  assert.ok(cardFn.includes('Next Action'), 'must have a next-action region');
  assert.ok(cardFn.includes('Actions — consistently grouped'), 'must have a dedicated actions region');
});

test('Deals.jsx DealCard: desktop row uses an internal grid of regions (Identity, Project, Financial, Action)', () => {
  const src = read('pages/Deals.jsx');
  const cardFn = src.slice(src.indexOf('function DealCard'), src.indexOf('export default function Deals'));
  assert.ok(/lg:grid lg:grid-cols-\[auto_[^\]]+\]/.test(cardFn), 'the row itself must define an internal multi-region grid at the lg breakpoint');
  assert.ok(cardFn.includes('Identity —'), 'must have an identity region');
  assert.ok(cardFn.includes('Project —'), 'must have a project region');
  assert.ok(cardFn.includes('Financial —'), 'must have a financial region');
});

test('Deals.jsx DealCard: financial values (Value/Paid/Remaining) use a consistent label+value row layout so they align vertically between deals', () => {
  const src = read('pages/Deals.jsx');
  const cardFn = src.slice(src.indexOf('function DealCard'), src.indexOf('export default function Deals'));
  const financialBlock = cardFn.slice(cardFn.indexOf('Financial —'));
  const rowMatches = financialBlock.match(/flex items-center justify-between gap-3/g) || [];
  assert.ok(rowMatches.length >= 3, 'Value, Paid, and Remaining/Status must each use the same label+value row shape');
});

test('Deals.jsx DealCard: financial calculations are unchanged (still uses displayContractAmount/displayTotalPaid/displayBalanceDue from the waterfall)', () => {
  const src = read('pages/Deals.jsx');
  const cardFn = src.slice(src.indexOf('function DealCard'), src.indexOf('export default function Deals'));
  assert.ok(cardFn.includes('financials?.paid != null ? financials.paid'), 'waterfall-authoritative paid calculation must be untouched');
  assert.ok(cardFn.includes('financials?.balance != null'), 'waterfall-authoritative balance calculation must be untouched');
});

// ── Responsive collapse (no horizontal scrolling) ───────────────────────────

test('LeadsModern.jsx LeadCard: collapses to a stacked single column below lg (no horizontal scroll)', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  assert.ok(cardFn.includes('flex flex-col gap-2.5 lg:grid'), 'mobile/tablet must stack regions vertically via flex-col, only becoming a grid at lg+');
  assert.ok(!/overflow-x-auto|overflow-x-scroll/.test(cardFn), 'must not rely on horizontal scrolling to preserve the desktop layout');
});

test('Deals.jsx DealCard: collapses to a stacked single column below lg (no horizontal scroll)', () => {
  const src = read('pages/Deals.jsx');
  const cardFn = src.slice(src.indexOf('function DealCard'), src.indexOf('export default function Deals'));
  assert.ok(cardFn.includes('flex flex-col gap-2.5 lg:grid'), 'mobile/tablet must stack regions vertically via flex-col, only becoming a grid at lg+');
  assert.ok(!/overflow-x-auto|overflow-x-scroll/.test(cardFn), 'must not rely on horizontal scrolling to preserve the desktop layout');
});

// ── Canonical badge/action components are still used (not re-forked) ───────

test('LeadsModern.jsx LeadCard: still uses statusBadgeClass and the shared ContactActions component', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  assert.ok(cardFn.includes('statusBadgeClass(lead.status)'), 'status badge must still use the canonical shared function');
  assert.ok(cardFn.includes('<ContactActions'), 'must still render the canonical shared Call/SMS/Email component');
});

// ── Row click / action-button interaction ───────────────────────────────────

test('LeadsModern.jsx: the whole row is a Link (click-to-open), and action buttons stop propagation so they never trigger row navigation', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  assert.ok(/<Link\s*\n\s*to=\{`\/leads\//.test(cardFn), 'the row itself must be the clickable Link to open the Lead');
  const actionsRegion = cardFn.slice(cardFn.indexOf('{/* Actions —'), cardFn.indexOf('{/* Actions —') + 2500);
  assert.ok(actionsRegion.includes('onClick={e => e.preventDefault()}'), 'the actions region must block the Link\'s default navigation so its buttons can act independently');
  assert.ok((actionsRegion.match(/e\.stopPropagation\(\)/g) || []).length >= 3, 'individual action buttons (Complete/Reschedule/Delete/etc.) must each stop propagation');
});

test('Deals.jsx: the whole row is a Link (click-to-open) to the same /deals/:id route as before', () => {
  const src = read('pages/Deals.jsx');
  const cardFn = src.slice(src.indexOf('function DealCard'), src.indexOf('export default function Deals'));
  assert.ok(/<Link\s*\n?\s*to=\{`\/deals\/\$\{deal\.id\}`\}/.test(cardFn), 'the row must still link to the same deal detail route — no route change');
});

// ── Filters / header area preserved ─────────────────────────────────────────

test('LeadsModern.jsx: search/status filter/sort/New Lead/overdue indicator are all still present', () => {
  const src = read('pages/LeadsModern.jsx');
  for (const marker of ['isGlobalSearch', 'New Lead', 'STATUS_STYLES']) {
    assert.ok(src.includes(marker), `must preserve existing header functionality: ${marker}`);
  }
});

test('Deals.jsx: search/owner/job-type/stage filters and KPI summary cards are all still present', () => {
  const src = read('pages/Deals.jsx');
  assert.ok(src.includes('filterOwner') && src.includes('filterJobType') && src.includes('filterStage'), 'existing filters must be preserved');
  assert.ok(src.includes('SummaryCard'), 'KPI summary cards must be preserved');
});

// ── Sidebar full company name (from the prior pass) remains intact ─────────

test('Layout.jsx: full company name is still never truncated (regression guard against re-breaking the prior fix)', () => {
  const src = read('components/Layout.jsx');
  const nameIdx = src.indexOf('companyIdentity.name');
  const brandBlock = src.slice(Math.max(0, nameIdx - 500), nameIdx + 200);
  assert.ok(!/textOverflow:\s*['"]ellipsis['"]/.test(brandBlock), 'must not have regressed to forced ellipsis truncation');
  assert.ok(brandBlock.includes('break-words'), 'must still allow the name to wrap');
});
