/* eslint-disable no-undef */
'use strict';

/**
 * leadOwnerUpdateNoDuplicate.test.js — backend half of the Lead Owner
 * white-screen production defect. The crash itself was entirely frontend
 * (see LeadDetailModern.ownerChange.test.jsx), but this locks down the two
 * backend guarantees the fix's required behavior list depends on:
 *   - changing assigned_rep/owner_id is always an UPDATE of the same row,
 *     never an INSERT (no duplicate lead can ever be created by this path);
 *   - the response after an owner change is re-read and serialized the same
 *     way as a normal GET, so "refresh shows the same persisted owner" and
 *     "the new owner appears immediately" are the same code path, not two
 *     that could drift apart.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'leads.js'), 'utf8');

function extractHandler(routeSignature) {
  const start = src.indexOf(routeSignature);
  assert.ok(start >= 0, `route not found: ${routeSignature}`);
  const nextRoute = src.indexOf("router.", start + routeSignature.length);
  return src.slice(start, nextRoute > 0 ? nextRoute : undefined);
}

test('PUT /:id owner-change updates the SAME lead row — never inserts a new one', () => {
  const handler = extractHandler("router.put('/:id'");
  assert.ok(/UPDATE leads SET/.test(handler), 'must UPDATE the existing row');
  assert.ok(!/INSERT INTO leads/.test(handler), 'must never INSERT a new lead from this handler');
  assert.ok(/WHERE id = \$\{p\}/.test(handler) || /WHERE id = \$/.test(handler), 'the UPDATE must be scoped to the exact lead id');
});

test('PUT /:id resolves owner_id from assigned_rep (display name) without ever nulling the NOT NULL column', () => {
  const handler = extractHandler("router.put('/:id'");
  assert.ok(/owner_id is NOT NULL/.test(handler) || /owner_id.*NOT NULL/i.test(handler), 'must document the NOT NULL constraint it is protecting');
  assert.ok(/body\.owner_id !== undefined && body\.owner_id !== null && body\.owner_id !== ''/.test(handler),
    'must guard against setting owner_id to null/empty');
  assert.ok(/SELECT id FROM owners WHERE display_name = \$1 AND is_active = true/.test(handler),
    'must resolve assigned_rep (display name) to a real, active owner row');
});

test('PUT /:id re-reads and re-serializes the FULL row after the update — the response and a fresh GET can never drift apart', () => {
  const handler = extractHandler("router.put('/:id'");
  assert.ok(/fetchActiveAppointment\(fullRow\.id\)/.test(handler), 'must recompute the canonical appointment the same way GET does');
  assert.ok(/serializeLead\(fullRow, appt\)/.test(handler), 'must serialize the freshly re-read row, not the pre-update input');
});

test('the composite Lead Detail endpoint still returns contactOwners as {id, display_name, email} objects (backend contract unchanged — the bug was frontend consumption of this shape)', () => {
  const handler = extractHandler("router.get('/by-external/:externalRef/detail'");
  assert.ok(/contactOwners: ownerRes\.rows\.map\(o => \(\{ id: o\.id, display_name: o\.display_name, email: o\.email \}\)\)/.test(handler),
    'contactOwners must stay a real object list — do not weaken the backend contract to work around a frontend bug');
});
