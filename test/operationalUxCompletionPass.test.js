/* eslint-disable no-undef */
'use strict';

/**
 * operationalUxCompletionPass.test.js — regression coverage for the
 * "final operational + UX completion pass":
 *
 *   1. My Day defaults to Map (which already shows map + list together via
 *      DailyMap's own "split" default) instead of List.
 *   2. Lead Detail's Contact Info: one coherent card with ONE Edit action
 *      (not eight independent pencil-icon rows), Save Changes / Cancel.
 *   3. Contact (name/phone/email/address) is visually separated from
 *      Lead/Project metadata (owner/job type/budget/source).
 *   4. Address verification: the existing addressPipeline's verified/
 *      needs_review/error/not_found classification is now exposed to the
 *      frontend (previously computed and stored but never serialized to
 *      the API response) and surfaced as a badge, never silently treated
 *      as confirmed.
 *   5. Directions / View Property (Street View) actions reuse the SAME
 *      resolved coordinates the backend geocoding pipeline already
 *      computed — no second geocoding system.
 *   6. Deal Overview: Client + Project Info side by side on desktop
 *      (previously a single narrow vertical stack), still within the
 *      existing PAGE_WIDTH_STANDARD token, not stretched to 1600px.
 *   7. Company sidebar region label is sourced from an admin-configured
 *      company_region field, never hardcoded or employee-derived.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const frontendSrc = path.resolve(__dirname, '..', 'crm-frontend', 'src');
function readFe(rel) { return fs.readFileSync(path.join(frontendSrc, rel), 'utf8'); }
function readRepo(rel) { return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8'); }

// ── 1. My Day default view ──────────────────────────────────────────────────

test('MobileDayView.jsx: Map is the default view; ?view=list still opts into List', () => {
  const src = readFe('pages/MobileDayView.jsx');
  const stateInit = src.slice(src.indexOf('const [view, setView]'), src.indexOf('const [view, setView]') + 300);
  assert.ok(stateInit.includes('"list"') && stateInit.includes('"map"'), 'both view states must still be reachable');
  assert.ok(/get\("view"\)\s*===\s*"list"\s*\?\s*"list"\s*:\s*"map"/.test(stateInit), 'default must resolve to "map" unless ?view=list is explicit');
});

test('DailyMap.jsx (the canonical Map view My Day renders) defaults to split (map + list together)', () => {
  const src = readFe('pages/DailyMap.jsx');
  assert.ok(src.includes('useState("split")'), 'DailyMap must default to the split view so Map mode shows both the map and the appointment/route list');
});

test('DailyMap.jsx: routing/travel-time logic is not duplicated — still the single getDailySchedule call', () => {
  const src = readFe('pages/DailyMap.jsx');
  const matches = src.match(/routingApi\.getDailySchedule/g) || [];
  assert.strictEqual(matches.length, 1, 'exactly one canonical routing call site — no second implementation introduced');
});

// ── 2, 3. Contact card redesign + Contact/Lead-Project separation ──────────

test('ContactInfoEditor.jsx: ONE Edit action puts all contact fields into one edit state (no per-field pencil wall)', () => {
  const src = readFe('components/ContactInfoEditor.jsx');
  const pencilMatches = src.match(/<Pencil/g) || [];
  assert.strictEqual(pencilMatches.length, 1, 'exactly one Edit affordance for the whole card, not one per field');
  assert.ok(src.includes('Save Changes'), 'must have a single coherent Save Changes action');
  assert.ok(src.includes('Cancel'), 'must have a Cancel action');
  assert.ok(src.includes('first_name:') && src.includes('last_name:') && src.includes('phone:') && src.includes('email:') &&
    src.includes('property_address:') && src.includes('city:') && src.includes('state:') && src.includes('zip:'),
    'the edit form must cover all eight contact fields at minimum');
});

test('ContactInfoEditor.jsx: Save is one coherent update call, not eight separate PUTs', () => {
  const src = readFe('components/ContactInfoEditor.jsx');
  const editForm = src.slice(src.indexOf('function ContactEditForm'), src.indexOf('function ContactView'));
  const updateCalls = editForm.match(/railwayLeads\.update\(/g) || [];
  assert.strictEqual(updateCalls.length, 1, 'exactly one railwayLeads.update call in the save handler');
});

test('ContactInfoEditor.jsx: preserves validation, error, saving, and success behavior', () => {
  const src = readFe('components/ContactInfoEditor.jsx');
  assert.ok(src.includes('isEmailValid'), 'email validation preserved');
  assert.ok(src.includes('isPhoneValid'), 'phone validation preserved');
  assert.ok(src.includes('setSaving(true)') || src.includes('saving,'), 'saving state preserved');
  assert.ok(src.includes("status === 409") && src.includes('conflict'), 'duplicate-conflict handling preserved');
  assert.ok(src.includes("toast({ title: 'Contact info saved."), 'success feedback preserved');
});

test('ContactInfoEditor.jsx: never creates a new Lead — always updates the existing lead id', () => {
  const src = readFe('components/ContactInfoEditor.jsx');
  assert.ok(!/railwayLeads\.create\(/.test(src), 'must never call the lead-creation endpoint');
  assert.ok(src.includes('lead.railway_id || lead.id'), 'must update the existing lead by its own id');
});

test('LeadDetailModern.jsx: Contact and Lead/Project are two separate sections, not one merged "Contact Info" block', () => {
  const src = readFe('pages/LeadDetailModern.jsx');
  assert.ok(src.includes('SidebarSection title="Contact"'), 'a dedicated Contact section must exist');
  assert.ok(src.includes('SidebarSection title="Lead / Project"'), 'a dedicated Lead / Project section must exist');
  assert.ok(!src.includes('SidebarSection title="Contact Info"'), 'the old merged section must be gone');
  const leadProjectSection = src.slice(src.indexOf('SidebarSection title="Lead / Project"'));
  assert.ok(leadProjectSection.includes('label="Owner"') && leadProjectSection.includes('label="Job Type"') &&
    leadProjectSection.includes('label="Budget"') && leadProjectSection.includes('label="Source"'),
    'Owner/Job Type/Budget/Source must live in Lead / Project, not Contact');
});

// ── 4, 5. Address verification + one source of truth ───────────────────────

test('routes/leads.js: serializeLead exposes the address-verification fields computed by the one canonical pipeline', () => {
  const src = readRepo('routes/leads.js');
  const serializeFn = src.slice(src.indexOf('function serializeLead'), src.indexOf('function serializeActivity'));
  for (const field of ['property_geocode_status', 'verified_property_address', 'property_lat', 'property_lng', 'google_place_id']) {
    assert.ok(serializeFn.includes(field), `serializeLead must expose ${field} — it was computed by lib/addressPipeline.js but never returned to the frontend before this pass`);
  }
});

test('lib/addressActions.js: Directions/View Property URLs are built from the lead\'s own resolved coordinates, never re-geocoded client-side', () => {
  const src = readFe('lib/addressActions.js');
  assert.ok(src.includes('property_lat') && src.includes('property_lng'), 'must use the coordinates already computed by the backend pipeline');
  assert.ok(!/fetch\(/.test(src), 'must not make its own geocoding network call — no second geocoding system');
});

test('lib/addressActions.js: View Property is never offered without real coordinates (no fabricated Street View availability)', () => {
  const src = readFe('lib/addressActions.js');
  const fn = src.slice(src.indexOf('export function getPropertyViewUrl'));
  assert.ok(/if\s*\(lead\?\.property_lat == null \|\| lead\?\.property_lng == null\)\s*return null/.test(fn), 'must return null rather than a guessed link when coordinates are unknown');
});

test('ContactInfoEditor.jsx: address needing review is surfaced, never silently replaced', () => {
  const src = readFe('components/ContactInfoEditor.jsx');
  assert.ok(src.includes('Address needs review'), 'must show a review state, not silently accept the geocoded guess');
  assert.ok(src.includes('Use suggested address'), 'must require an explicit user action to accept the suggestion');
  assert.ok(src.includes("property_geocode_status !== 'needs_review'"), 'the suggestion banner must be gated on the real pipeline status, not always shown');
});

test('ContactInfoEditor.jsx: confirming a suggested address reuses the canonical PUT /:id address pipeline (no second geocode path)', () => {
  const src = readFe('components/ContactInfoEditor.jsx');
  const banner = src.slice(src.indexOf('function AddressReviewBanner'), src.indexOf('function AddressMapActions'));
  assert.ok(banner.includes('railwayLeads.update'), 'must go through the same lead-update endpoint every other edit uses');
  assert.ok(banner.includes('property_address: lead.verified_property_address'), 'must submit the pipeline\'s own suggested formatted address back through itself for re-verification');
});

// ── 6. Deal Overview desktop composition ────────────────────────────────────

test('OverviewTab.jsx: Client and Project Info render side by side on desktop, not a single vertical stack', () => {
  const src = readFe('components/dealdetail/OverviewTab.jsx');
  const gridMatches = src.match(/grid grid-cols-1 lg:grid-cols-2 gap-5/g) || [];
  assert.ok(gridMatches.length >= 1, 'must introduce a responsive 2-column grid for the top row');
  const firstGridIdx = src.indexOf('grid grid-cols-1 lg:grid-cols-2 gap-5');
  const topRow = src.slice(firstGridIdx, src.indexOf('typography-section-header mb-2">NOTES'));
  assert.ok(topRow.includes('CLIENT') && topRow.includes('PROJECT INFO'), 'Client and Project Info must be in the same responsive row');
});

test('OverviewTab.jsx: stays within the existing PAGE_WIDTH_STANDARD measure, not stretched to the 1600px data-table width', () => {
  const src = readFe('components/dealdetail/OverviewTab.jsx');
  assert.ok(src.includes('max-w-4xl mx-auto'), 'must keep the existing standard reading-width container');
  assert.ok(!src.includes('max-w-[1600px]'), 'must not solve this by stretching to the wide data-table container');
});

test('OverviewTab.jsx: existing data bindings and save handlers are preserved exactly (no business-logic change)', () => {
  const src = readFe('components/dealdetail/OverviewTab.jsx');
  for (const marker of ['railwayLeads.update(lead.id', 'railwayDeals.update(deal.id', 'updateField("property_address"', 'updateField("stage", stage)', 'PIPELINE_STAGES.map']) {
    assert.ok(src.includes(marker), `must preserve existing behavior: ${marker}`);
  }
});

// ── 7. Company / region branding ────────────────────────────────────────────

test('routes/companySettings.js: company_region is a real, admin-settable field (additive, not tenancy)', () => {
  const src = readRepo('routes/companySettings.js');
  assert.ok(src.includes("'company_region'"), 'company_region must be in the writable FIELDS allowlist');
  assert.ok(src.includes('company_region: row.company_region'), 'company_region must be serialized in GET responses');
});

test('db/migrations: company_region column is additive and idempotent', () => {
  const migrationFiles = fs.readdirSync(path.resolve(__dirname, '..', 'db', 'migrations'));
  const match = migrationFiles.find(f => f.includes('company-settings-region'));
  assert.ok(match, 'a migration adding company_region must exist');
  const sql = fs.readFileSync(path.resolve(__dirname, '..', 'db', 'migrations', match), 'utf8');
  assert.ok(/ADD COLUMN IF NOT EXISTS company_region/.test(sql), 'must be an idempotent additive column');
});

test('CompanySettingsTab.jsx: admin can set the operational region label', () => {
  const src = readFe('components/CompanySettingsTab.jsx');
  assert.ok(src.includes('company_region'), 'Company Setup must expose the region field for editing');
});

test('Layout.jsx: sidebar prefers the configured region over city/state when set', () => {
  const src = readFe('components/Layout.jsx');
  const effectBlock = src.slice(src.indexOf('setCompanyIdentity({'), src.indexOf('setCompanyIdentity({') + 400);
  assert.ok(effectBlock.includes('settings.company_region'), 'region must take priority when configured');
  assert.ok(effectBlock.includes('company_city') && effectBlock.includes('company_state'), 'city/state must remain the fallback when no region is configured');
});
