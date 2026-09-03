/* eslint-disable no-undef */
/**
 * Merge Duplicate Leads regression tests.
 *
 * Verifies that the Railway-native merge endpoint:
 *   1. Uses an atomic transaction (BEGIN/COMMIT/ROLLBACK)
 *   2. Reassigns ALL FK-dependent records
 *   3. Handles appointments (SET NULL FK, not CASCADE)
 *   4. Handles TEXT lead_id tables (reminder_claims, qb_invoice_sale_map)
 *   5. Writes a merge audit activity
 *   6. Soft-deletes the merged lead (status='DNQ', not physical delete)
 *   7. Admin-only authorization
 *   8. Validates UUID format for both lead IDs
 *   9. Rejects self-merge
 *  10. No Base44 references
 */
'use strict';
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Test 1: Atomic transaction ────────────────────────────────────────────
test('Merge leads: uses atomic transaction (BEGIN/COMMIT/ROLLBACK)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes('BEGIN'), 'must start with BEGIN');
  assert.ok(src.includes('COMMIT'), 'must end with COMMIT');
  assert.ok(src.includes('ROLLBACK'), 'must have ROLLBACK on error');
  assert.ok(/ROLLBACK.*catch/.test(src), 'ROLLBACK must be in catch block');
});

// ── Test 2: Reassigns all FK-dependent records ──────────────────────────────
test('Merge leads: reassigns ALL FK-dependent records', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  const tables = [
    'activities', 'tasks', 'deals', 'invoices', 'estimates',
    'properties', 'lead_attachments', 'lead_submissions', 'appointments',
    'signnow_documents', 'handoff_estimates',
  ];
  for (const table of tables) {
    assert.ok(src.includes(`UPDATE ${table}`), `must reassign ${table}`);
  }
});

// ── Test 3: Handles TEXT lead_id tables ────────────────────────────────────
test('Merge leads: handles TEXT lead_id tables (reminder_claims, qb_invoice_sale_map)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes('UPDATE reminder_claims'), 'must reassign reminder_claims');
  assert.ok(src.includes('UPDATE qb_invoice_sale_map'), 'must reassign qb_invoice_sale_map');
  // Must cast to text for TEXT columns
  assert.ok(/reminder_claims SET lead_id = \$1.*String\(survivorId\)/.test(src),
    'must use String(survivorId) for TEXT lead_id columns');
});

// ── Test 4: Appointments are updated (not deleted) ─────────────────────────
test('Merge leads: appointments are updated (not deleted)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes('UPDATE appointments SET lead_id'), 'must UPDATE appointments');
  assert.ok(!/DELETE FROM appointments/.test(src), 'must NOT DELETE appointments (immutable)');
});

// ── Test 5: Writes merge audit activity ────────────────────────────────────
test('Merge leads: writes merge audit activity to survivor', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes('INSERT INTO activities'), 'must write audit activity');
  assert.ok(src.includes('Merged lead'), 'activity must mention merge');
});

// ── Test 6: Soft-deletes merged lead (DNQ, not physical delete) ───────────
test('Merge leads: soft-deletes merged lead (status=DNQ, not physical DELETE)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes("status = 'DNQ'"), 'must set status to DNQ');
  assert.ok(src.includes('duplicate_merged = true'), 'must set duplicate_merged flag');
  assert.ok(src.includes('last_merge_date = NOW()'), 'must set last_merge_date');
  assert.ok(src.includes('merge_count'), 'must increment merge_count');
  assert.ok(!/DELETE FROM leads/.test(src), 'must NOT physically DELETE the merged lead');
});

// ── Test 7: Admin-only authorization ────────────────────────────────────────
test('Merge leads: admin-only authorization', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes("requireRole('admin')"), 'must require admin role');
});

// ── Test 8: UUID validation ────────────────────────────────────────────────
test('Merge leads: validates UUID format for both lead IDs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes('UUID_RE.test'), 'must validate UUID format');
  assert.ok(src.includes('Both IDs must be valid Railway UUIDs'), 'must return clear error');
});

// ── Test 9: Rejects self-merge ─────────────────────────────────────────────
test('Merge leads: rejects self-merge', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes('Cannot merge a lead with itself'), 'must reject self-merge');
});

// ── Test 10: No Base44 references ──────────────────────────────────────────
test('Merge leads: no Base44 references', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(!src.includes('@base44/sdk'), 'must not import @base44/sdk');
  assert.ok(!src.includes('base44.asServiceRole'), 'must not use base44.asServiceRole');
  assert.ok(!src.includes('base44.functions'), 'must not use base44.functions');
});

// ── Test 11: FOR UPDATE lock on both leads ─────────────────────────────────
test('Merge leads: uses FOR UPDATE to prevent concurrent modification', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes('FOR UPDATE'), 'must lock both leads with FOR UPDATE');
});

// ── Test 12: Deterministic survivor selection (oldest by crm_created_date) ─
test('Merge leads: deterministic survivor selection (oldest by crm_created_date)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'mergeLeads.js'), 'utf8');
  assert.ok(src.includes('crm_created_date'), 'must use crm_created_date for survivor selection');
  assert.ok(src.includes('survivorIsKeep'), 'must determine survivor deterministically');
});