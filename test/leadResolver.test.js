/* eslint-disable no-undef */
'use strict';

/**
 * leadResolver.test.js — unit coverage for lib/leadResolver.js, the shared
 * identifier-resolution helper at the center of the Charles Carlson
 * "invalid_id" production defect trace (PUT /api/v1/leads/:id requires a
 * real Railway UUID; legacy/external identifiers must go through
 * /by-external/:externalRef, which uses this module).
 *
 * These are pure, DB-independent tests of leadIdWhere() (the pg-injection-
 * safe WHERE-clause builder) — the actual bug was NOT in this module (it
 * was a stale `railway_id` shadow field in the frontend — see
 * LeadDetailModern.jsx's setLeadSafe), but this module is the canonical,
 * reusable answer to "how do you safely accept either identifier shape",
 * and it deserves direct regression coverage independent of any one route.
 */
const test = require('node:test');
const assert = require('node:assert');
const { UUID_RE, leadIdWhere } = require('../lib/leadResolver');

const REAL_UUID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const LEGACY_EXTERNAL_REF = 'ec-website-lead-12345';
const BASE44_STYLE_ID = '68abf3c1f9e2a40012345678';

test('UUID_RE matches a canonical Railway UUID', () => {
  assert.ok(UUID_RE.test(REAL_UUID));
});

test('UUID_RE rejects legacy external_ref formats (website-intake and Base44-style ids)', () => {
  assert.ok(!UUID_RE.test(LEGACY_EXTERNAL_REF));
  assert.ok(!UUID_RE.test(BASE44_STYLE_ID));
});

test('leadIdWhere: a valid UUID identifier queries BOTH external_ref and id, with separately-typed params', () => {
  const { whereSql, params } = leadIdWhere(REAL_UUID);
  assert.strictEqual(whereSql, 'external_ref = $1 OR id = $2::uuid');
  assert.deepStrictEqual(params, [REAL_UUID, REAL_UUID]);
});

test('leadIdWhere: a non-UUID identifier queries external_ref ONLY — never compares a non-UUID string against the uuid column', () => {
  const { whereSql, params } = leadIdWhere(LEGACY_EXTERNAL_REF);
  assert.strictEqual(whereSql, 'external_ref = $1');
  assert.deepStrictEqual(params, [LEGACY_EXTERNAL_REF]);
  assert.ok(!/id = /.test(whereSql), 'must never generate an id= comparison for a non-UUID identifier (would throw invalid input syntax for type uuid)');
});

test('leadIdWhere: respects an optional table alias', () => {
  const { whereSql } = leadIdWhere(REAL_UUID, 'l.');
  assert.strictEqual(whereSql, 'l.external_ref = $1 OR l.id = $2::uuid');
});

test('leadIdWhere: a Base44-style legacy id (24 hex chars, not a UUID) resolves via external_ref only, matching the website-lead-intake shape', () => {
  const { whereSql, params } = leadIdWhere(BASE44_STYLE_ID);
  assert.strictEqual(whereSql, 'external_ref = $1');
  assert.deepStrictEqual(params, [BASE44_STYLE_ID]);
});
