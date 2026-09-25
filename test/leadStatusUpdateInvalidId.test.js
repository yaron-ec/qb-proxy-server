/* eslint-disable no-undef */
'use strict';

/**
 * leadStatusUpdateInvalidId.test.js — regression coverage for the
 * production defect: on Lead Detail for an existing, valid lead (Charles
 * Carlson), changing Status to "Lost" and clicking Save produced
 * `invalid_id`, even though the lead genuinely existed.
 *
 * ROOT CAUSE (frontend, not this route): routes/leads.js's PUT /:id has
 * always correctly required a real Railway UUID (`lead.id`) — that is
 * intentional (see the UPDATABLE_FIELDS comment above: "it NEVER creates
 * duplicate leads (unlike PUT /by-external, which INSERTs...)"). The bug
 * was that crm-frontend/src/pages/LeadDetailModern.jsx passed the raw
 * `setLead` React state setter directly as `onLeadUpdate` to ~9 sibling
 * panels (HandoffEstimatesPanel, DealsPanel, PartialInvoiceFlow,
 * SignNowPanel, CalendarSyncPanel, GoogleContactSyncPanel, ProposalPanel,
 * MobileIntegrationActions, LeftSidebarContent). Any of those panels
 * calling onLeadUpdate(res.lead) with a raw backend response (which always
 * has `.id` but not the legacy `.railway_id` convenience alias) silently
 * wiped `railway_id` from React state. The NEXT field save then fell back
 * to the raw URL param, which can legitimately be a non-UUID external_ref
 * for a lead opened via its legacy identifier — producing `invalid_id`
 * against a perfectly valid, existing lead.
 *
 * FIX (LeadDetailModern.jsx): a single `setLeadSafe` wrapper that
 * re-stamps `railway_id = id` on every state update, used everywhere
 * `onLeadUpdate`/`setLead` touches state — plus defense-in-depth fallback
 * reordering (`lead.id || lead.railway_id || id`, `.id` always preferred)
 * at every direct railwayLeads.update/remove call site.
 *
 * This file locks down the BACKEND half of the contract that fix depends
 * on: PUT /:id's UUID guard returns a controlled 400 (never a crash or
 * 500) for a non-UUID, 'status' is a normal UPDATABLE_FIELDS column with
 * no special-cased/duplicate write path, the update is scoped to the exact
 * row (never an INSERT), and the response is the freshly re-read,
 * re-serialized row (so "renders immediately" and "persists after
 * refresh" can never drift apart, since GET uses the same serializeLead).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const leadsSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'leads.js'), 'utf8');

function extractHandler(routeSignature) {
  const start = leadsSrc.indexOf(routeSignature);
  assert.ok(start >= 0, `route not found: ${routeSignature}`);
  const nextRoute = leadsSrc.indexOf('router.', start + routeSignature.length);
  return leadsSrc.slice(start, nextRoute > 0 ? nextRoute : undefined);
}

test('PUT /:id rejects a non-UUID identifier with a controlled 400 invalid_id — never a 500/crash', () => {
  const handler = extractHandler("router.put('/:id'");
  assert.ok(/if \(!UUID_RE\.test\(String\(id\)\)\)/.test(handler), 'must guard the :id param against non-UUID input before touching the DB');
  assert.ok(/status\(400\)\.json\(\{ error: 'invalid_id'/.test(handler), 'must return a controlled 400 with a stable error code');
  assert.ok(/Use \/by-external\/:externalRef for legacy identifiers/.test(handler), 'the error message must point callers to the correct route for a legacy identifier');
});

test('PUT /:id: the UUID guard runs BEFORE any DB query — an invalid id can never reach/duplicate a real row', () => {
  const handler = extractHandler("router.put('/:id'");
  const guardIdx = handler.indexOf('UUID_RE.test');
  const firstQueryIdx = handler.indexOf('await query(');
  assert.ok(guardIdx >= 0 && firstQueryIdx > guardIdx, 'UUID guard must precede the first database query');
});

test("'status' is a plain UPDATABLE_FIELDS column — no separate/special-cased status-only write path exists", () => {
  const fieldsBlock = leadsSrc.slice(leadsSrc.indexOf('const UPDATABLE_FIELDS = ['), leadsSrc.indexOf('];', leadsSrc.indexOf('const UPDATABLE_FIELDS = [')));
  assert.ok(/'status'/.test(fieldsBlock), "'status' must be in UPDATABLE_FIELDS");
  // No dedicated PUT /:id/status (or similar) route exists to diverge from this path.
  assert.ok(!/router\.(put|patch)\('\/:id\/status'/.test(leadsSrc), 'must not have a second, divergent status-only endpoint');
});

test('PUT /:id builds and runs exactly one UPDATE ... WHERE id = $ ... RETURNING * — never an INSERT', () => {
  const handler = extractHandler("router.put('/:id'");
  assert.ok(/UPDATE leads SET \$\{updates\.join/.test(handler), 'must build a single dynamic UPDATE statement');
  assert.ok(/WHERE id = \$\$\{p\}/.test(handler), 'the UPDATE must be scoped to the exact lead id');
  assert.ok(/RETURNING \*/.test(handler), 'must RETURNING * so the update result reflects the true persisted row');
  assert.ok(!/INSERT INTO leads/.test(handler), 'PUT /:id must never INSERT — that is exactly what would create a duplicate lead');
});

test('PUT /:id re-reads the FULL row and the LIVE active appointment, then serializes them the same way GET does — response and a fresh refresh can never drift apart', () => {
  const handler = extractHandler("router.put('/:id'");
  assert.ok(/fullRow = \(await client\.query\(/.test(handler), 'must re-SELECT the full row after the UPDATE, not trust the RETURNING clause\'s partial shape alone');
  assert.ok(/fetchActiveAppointment\(fullRow\.id\)/.test(handler), 'must recompute the canonical appointment exactly as GET does');
  assert.ok(/res\.json\(\{ lead: serializeLead\(fullRow, appt\) \}\)/.test(handler), 'must respond with the freshly re-read row through the same serializer GET uses');
});

test('PUT /:id commits the update and the reminder projection atomically (same transaction) — a status change can never partially apply', () => {
  const handler = extractHandler("router.put('/:id'");
  assert.ok(/await client\.query\('BEGIN'\)/.test(handler));
  assert.ok(/await syncLeadToReminders\(client, fullRow\)/.test(handler));
  assert.ok(/await client\.query\('COMMIT'\)/.test(handler));
  assert.ok(/await client\.query\('ROLLBACK'\)/.test(handler));
});

test('PUT /:id requires updates.length > 0 — an empty/no-op body returns a controlled 400, never silently no-ops or 500s', () => {
  const handler = extractHandler("router.put('/:id'");
  assert.ok(/if \(updates\.length === 0\)/.test(handler));
  assert.ok(/status\(400\)\.json\(\{ error: 'no fields to update' \}\)/.test(handler));
});

test('legacy identifiers have a dedicated, separate upsert route (/by-external/:externalRef) — PUT /:id intentionally does not also accept them', () => {
  assert.ok(/router\.put\('\/by-external\/:externalRef'/.test(leadsSrc), 'the legacy upsert-by-external-ref route must exist as the documented alternative for non-UUID identifiers');
});

test('GET /by-external/:externalRef/detail resolves EITHER a Railway UUID or a legacy external_ref (via resolveLeadByIdentifier) — Lead Detail can always load regardless of which identifier shape is in the URL', () => {
  const handler = extractHandler("router.get('/by-external/:externalRef/detail'");
  assert.ok(/resolveLeadByIdentifier\(externalRef\)/.test(handler), 'must use the shared dual-identifier resolver, not a UUID-only or external_ref-only lookup');
});
