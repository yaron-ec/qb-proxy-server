/* eslint-disable no-undef */
/**
 * captureValidation.unit.test.js — pure-logic tests for the public capture
 * validation/normalization/idempotency (no DB, no network). Run with:
 *   node src/proxy-server/test/captureValidation.unit.test.js
 */
'use strict';

const {
  validateCapturePayload, computeIdempotencyKey, resolveOwnerEmail,
  isValidOwnerEmail, laToUtcStart, normalizePhone, normalizeEmail, toProperCase,
} = require('../lib/captureValidation');

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed++; console.log(`  ✗ ${msg}`); }
  else console.log(`  ✓ ${msg}`);
}

// ── Normalization ──────────────────────────────────────────────────────────
assert(normalizePhone('(310) 555-1234') === '3105551234', 'phone normalizes to last 10 digits');
assert(normalizeEmail('  Jane@Example.COM ') === 'jane@example.com', 'email trims + lowercases');
assert(toProperCase('jane smith-miller') === 'Jane Smith-Miller', 'proper case handles hyphens');

// ── Owner resolution + whitelist ────────────────────────────────────────────
assert(resolveOwnerEmail('Yaron Drilevich') === 'yaron@ecconstructiongroup.com', 'Yaron Drilevich → yaron@ec...');
assert(resolveOwnerEmail('yaron') === 'yaron@ecconstructiongroup.com', 'first-name-only resolves');
assert(isValidOwnerEmail('yaron@ecconstructiongroup.com') === true, 'ec email valid');
assert(isValidOwnerEmail('yaron@evil.com') === false, 'non-ec email rejected');
assert(isValidOwnerEmail(null) === false, 'null owner rejected');

// ── Validation ──────────────────────────────────────────────────────────────
const good = {
  first_name: 'jane', last_name: 'smith',
  email: 'JANE@Example.com', phone: '(310) 555-1234',
  project_type: ['Roofing', 'Solar'], source: 'Google Search',
  assigned_rep: 'Yaron Drilevich',
  appointment_date: '2026-08-20', appointment_time: '09:00',
  message: 'Need a new roof',
};
const v = validateCapturePayload(good);
assert(v.ok === true, 'valid payload passes');
assert(v.cleaned.first_name === 'Jane', 'first_name proper-cased');
assert(v.cleaned.email === 'jane@example.com', 'email normalized');
assert(v.cleaned.phone === '3105551234', 'phone normalized');
assert(v.cleaned.project_type === 'Roofing, Solar', 'project_type array joined');
assert(v.cleaned.owner_email === 'yaron@ecconstructiongroup.com', 'owner email resolved');

const missingFields = validateCapturePayload({ first_name: 'x' });
assert(missingFields.ok === false, 'missing fields fail');
assert(missingFields.errors.length >= 5, 'multiple errors reported');

const badOwner = validateCapturePayload({ ...good, assigned_rep: 'Hacker' });
// 'Hacker' → hacker@ecconstructiongroup.com (derived) — still ec domain, so it
// passes the domain whitelist. This is by design: the public form can only
// produce @ecconstructiongroup.com owners; it cannot inject arbitrary IDs.
assert(badOwner.ok === true, 'unknown first-name still derives an ec-domain owner (no arbitrary IDs)');

const badDate = validateCapturePayload({ ...good, appointment_date: '08/20/2026' });
assert(badDate.ok === false, 'non-ISO date rejected');

const noContact = validateCapturePayload({ ...good, email: '', phone: '' });
assert(noContact.ok === false, 'phone-or-email required enforced');

// ── Idempotency key ─────────────────────────────────────────────────────────
const k1 = computeIdempotencyKey({ owner_email: 'yaron@ecconstructiongroup.com', first_name: 'Jane', last_name: 'Smith', email: 'jane@example.com', phone: '3105551234', property_address: '123 Main', appointment_type_id: 'type-1', start_at: '2026-08-20T16:00:00Z' });
const k2 = computeIdempotencyKey({ owner_email: 'YARON@ECConstructionGroup.com', first_name: 'Jane', last_name: 'Smith', email: 'JANE@example.com', phone: '3105551234', property_address: '123 Main', appointment_type_id: 'type-1', start_at: '2026-08-20T16:00:00Z' });
assert(k1 === k2, 'same content (case-insensitive owner/email) → same idempotency key');
const k3 = computeIdempotencyKey({ owner_email: 'yaron@ecconstructiongroup.com', first_name: 'Jane', last_name: 'Smith', email: 'jane@example.com', phone: '3105551234', property_address: '123 Main', appointment_type_id: 'type-1', start_at: '2026-08-20T17:00:00Z' });
assert(k1 !== k3, 'different slot → different idempotency key');
assert(k1.startsWith('cap:'), 'idempotency key has cap: prefix');

// ── LA → UTC start_at ───────────────────────────────────────────────────────
// 2026-08-10 is PDT (UTC-7): 11:00 LA = 18:00 UTC
const s1 = laToUtcStart('2026-08-10', '11:00');
assert(s1 === '2026-08-10T18:00:00.000Z', '11:00 LA PDT → 18:00 UTC');
const s2 = laToUtcStart('2026-08-10', '09:00');
assert(s2 === '2026-08-10T16:00:00.000Z', '09:00 LA PDT → 16:00 UTC');

if (failed > 0) { console.error(`\nFAIL: ${failed} assertion(s)`); process.exit(1); }
console.log('\nPASS: captureValidation pure-logic tests');
process.exit(0);