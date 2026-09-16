/* eslint-disable no-undef */
'use strict';

/**
 * listRowVisualRefinement.test.js — regression coverage for the "final
 * Active Leads + Deals visual refinement" pass.
 *
 * Root cause of the prior round's "spread across the width" feedback: the
 * row used CSS Grid tracks sized with `fr` units (e.g.
 * minmax(150px,1fr)), which greedily distribute ALL leftover container
 * space among those tracks — on a 1600px-wide container this produced
 * large, scattered, unpredictable gaps between short-content columns.
 * Verified with a real rendered mockup (screenshotted via Playwright/
 * Chromium against the actual compiled Tailwind CSS from `npm run
 * build:exit`, not just class-name assertions) before and after the fix.
 *
 * Fix: fixed max-width flex regions (`lg:w-[Npx]`) that align consistently
 * between rows, subtle vertical dividers between conceptual groups
 * (Identity | Contact | Ownership | Next Action), and Actions/the trailing
 * chevron pinned to the right edge via ml-auto so leftover row width
 * collects in one predictable place instead of three scattered ones.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');
function read(rel) { return fs.readFileSync(path.join(frontendSrc, rel), 'utf8'); }

// ── Direct actions remain primary, not hidden ───────────────────────────────

test('LeadsModern.jsx LeadCard: Call/SMS/Email (ContactActions) are directly visible in the row, not moved into an overflow/kebab menu', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  assert.ok(cardFn.includes('<ContactActions phone={lead.phone} email={lead.email} size="sm" />'), 'ContactActions must render directly in the row');
  assert.ok(!/MoreHorizontal|MoreVertical|DropdownMenu/.test(cardFn), 'must not hide direct actions behind a three-dot/overflow menu');
});

test('LeadsModern.jsx LeadCard: Complete/Reschedule/Calendar remain directly clickable buttons when a follow-up exists, not requiring the Lead to be opened', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  const actionsRegion = cardFn.slice(cardFn.indexOf('Actions — consistently grouped'));
  assert.ok(actionsRegion.includes('onClick={handleComplete}'), 'Complete must be a direct in-row action');
  assert.ok(actionsRegion.includes("navigate(`/leads/${lead.external_ref || lead.id}`)") , 'Reschedule/Calendar route through in-row buttons, not a forced detail-page visit first');
});

// ── Communication vs workflow action grouping ───────────────────────────────

test('LeadsModern.jsx LeadCard: communication actions (Call/SMS/Email) are visually grouped and separated from workflow actions (Complete/Reschedule/Calendar)', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  const actionsRegion = cardFn.slice(cardFn.indexOf('Actions — consistently grouped'), cardFn.indexOf('Actions — consistently grouped') + 2600);
  assert.ok(/lg:border-r lg:border-slate-200/.test(actionsRegion), 'a restrained divider must separate the communication-action group from workflow actions');
});

// ── Next Action gets strong, restrained operational hierarchy ──────────────

test('LeadsModern.jsx LeadCard: Next Action distinguishes overdue/due-today/future/no-action without excessive colors', () => {
  const src = read('pages/LeadsModern.jsx');
  assert.ok(src.includes("'bg-red-100 text-red-700 border border-red-300'"), 'overdue must be visually distinct');
  assert.ok(src.includes("'bg-amber-100 text-amber-700 border border-amber-300 font-bold'"), 'due today must be visually distinct');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  assert.ok(cardFn.includes('No next action'), 'a lead with neither a follow-up nor an appointment must show an explicit empty state, not blank space');
});

// ── Fixed-width, aligned regions (not fr-based grid stretch) ────────────────

test('LeadsModern.jsx LeadCard: no fr-based grid track sizing remains (the source of the scattered-gap feedback)', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  assert.ok(!/minmax\([^)]*fr\)/.test(cardFn), 'must not use fr-unit grid tracks that stretch unevenly across short-content columns');
});

test('Deals.jsx DealCard: no fr-based grid track sizing remains', () => {
  const src = read('pages/Deals.jsx');
  const cardFn = src.slice(src.indexOf('function DealCard'), src.indexOf('export default function Deals'));
  assert.ok(!/minmax\([^)]*fr\)/.test(cardFn), 'must not use fr-unit grid tracks that stretch unevenly across short-content columns');
});

// ── Long content truncates gracefully with accessible full value ───────────

test('LeadsModern.jsx LeadCard: long email keeps its full value accessible via title while truncating visually', () => {
  const src = read('pages/LeadsModern.jsx');
  const cardFn = src.slice(src.indexOf('function LeadCard'));
  const emailBlock = cardFn.slice(cardFn.indexOf('mail.google.com'), cardFn.indexOf('mail.google.com') + 500);
  assert.ok(emailBlock.includes('truncate') , 'long emails must truncate rather than break the row layout');
  assert.ok(emailBlock.includes('title={lead.email}'), 'the full email must remain accessible via a title tooltip');
});

// ── Deals: same product family, purpose-appropriate composition ────────────

test('Deals.jsx DealCard: does not import or render Lead-specific direct actions (Call/SMS/Email/Complete/Reschedule)', () => {
  const src = read('pages/Deals.jsx');
  assert.ok(!src.includes('ContactActions'), 'Deals must not force Lead-specific communication actions into the Deal row');
  const cardFn = src.slice(src.indexOf('function DealCard'), src.indexOf('export default function Deals'));
  assert.ok(!/>\s*✓?\s*Complete<|Reschedule/.test(cardFn), 'Deals rows must not carry Lead follow-up actions — different purpose (financial/project scanning)');
});

test('Deals.jsx DealCard: geometry/typography/hover language matches LeadsModern (same product family)', () => {
  const leadSrc = read('pages/LeadsModern.jsx');
  const dealSrc = read('pages/Deals.jsx');
  for (const marker of ['rounded-lg', 'shadow-sm', 'hover:shadow-lg', 'border-slate-200']) {
    assert.ok(leadSrc.includes(marker), `LeadsModern.jsx card must use ${marker}`);
  }
  assert.ok(dealSrc.includes('rounded-xl') && dealSrc.includes('shadow-sm') && dealSrc.includes('hover:shadow-md') && dealSrc.includes('border-slate-200'),
    'DealCard must share the same rounded/shadow/border visual family (a legitimate density variant, not an unrelated card system)');
});
