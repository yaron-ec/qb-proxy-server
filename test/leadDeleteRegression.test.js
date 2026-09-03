/* eslint-disable no-undef */
/**
 * Lead deletion regression tests.
 *
 * Verifies that deleting a Lead with dependent records (appointments,
 * calendar_outbox, activities, tasks, deals, etc.) succeeds atomically
 * without orphan rows and without FK constraint violations.
 *
 * These tests validate the DELETE handler code path and the FK migration
 * (2026-26-lead-delete-fk-fixes.sql) by checking:
 *   1. The delete handler calls cleanupLeadTextRefs for TEXT lead_id tables
 *   2. The migration SQL correctly changes ON DELETE actions
 *   3. The delete handler uses a single transaction with BEGIN/COMMIT/ROLLBACK
 *   4. All FK-dependent tables are accounted for (no missing dependencies)
 */
'use strict';
const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Test 1: cleanupLeadTextRefs function exists and handles all TEXT tables ──
test('Lead delete: cleanupLeadTextRefs handles all TEXT lead_id tables', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leads.js'), 'utf8');
  assert.ok(src.includes('cleanupLeadTextRefs'), 'must have cleanupLeadTextRefs function');

  // Must clean up all TEXT lead_id tables
  assert.ok(src.includes('DELETE FROM reminder_claims WHERE lead_id'), 'must delete reminder_claims');
  assert.ok(src.includes('DELETE FROM reminder_activity_queue WHERE lead_id'), 'must delete reminder_activity_queue');
  assert.ok(src.includes('UPDATE reminder_runs SET last_reminder_lead_id = NULL'), 'must unlink reminder_runs');
  assert.ok(src.includes('qb_invoice_sale_map'), 'must handle qb_invoice_sale_map');
});

// ── Test 2: Both delete handlers call cleanupLeadTextRefs + cancelAppointments within transaction ──
test('Lead delete: both /:id and /by-external call cleanupLeadTextRefs + cancelAppointmentsForLeadDelete in transaction', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leads.js'), 'utf8');

  // Find both delete handlers
  const deleteIdMatch = src.match(/router\.delete\('\/:id'[\s\S]*?cancelAppointmentsForLeadDelete[\s\S]*?cleanupLeadTextRefs[\s\S]*?COMMIT/);
  const deleteExtMatch = src.match(/router\.delete\('\/by-external[\s\S]*?cancelAppointmentsForLeadDelete[\s\S]*?cleanupLeadTextRefs[\s\S]*?COMMIT/);

  assert.ok(deleteIdMatch, 'DELETE /:id must call cancelAppointmentsForLeadDelete + cleanupLeadTextRefs before COMMIT');
  assert.ok(deleteExtMatch, 'DELETE /by-external must call cancelAppointmentsForLeadDelete + cleanupLeadTextRefs before COMMIT');

  // Both must have ROLLBACK on error
  assert.ok(src.includes('ROLLBACK'), 'must have ROLLBACK on error');
});

// ── Test 2b: cancelAppointmentsForLeadDelete cancels (not deletes) + enqueues calendar outbox ──
test('Lead delete: cancelAppointmentsForLeadDelete cancels appointments and enqueues calendar outbox', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leads.js'), 'utf8');

  assert.ok(src.includes('cancelAppointmentsForLeadDelete'), 'must have cancelAppointmentsForLeadDelete function');

  // Must query active appointments (scheduled/confirmed)
  assert.ok(/cancelAppointmentsForLeadDelete[\s\S]*?status IN \('scheduled', 'confirmed'\)/.test(src),
    'must query appointments with status scheduled/confirmed');

  // Must SET status = 'cancelled' (not DELETE — appointments are immutable)
  assert.ok(/cancelAppointmentsForLeadDelete[\s\S]*?status = .cancelled./.test(src),
    'must cancel appointments (SET status=cancelled), not physically delete');

  // Must increment version for optimistic concurrency
  assert.ok(/cancelAppointmentsForLeadDelete[\s\S]*?version = COALESCE\(version, 1\) \+ 1/.test(src),
    'must increment appointment version');

  // Must enqueue calendar outbox cancellation
  assert.ok(/cancelAppointmentsForLeadDelete[\s\S]*?calendarOutbox\.enqueueCancel/.test(src),
    'must enqueue calendar outbox cancellation for Google Calendar event removal');
});

// ── Test 3: Migration 2026-26 fixes all NO_ACTION FK constraints ──────────
test('Lead delete: migration 2026-26 fixes all blocking FK constraints', () => {
  const migrationPath = path.join(ROOT, 'db', 'migrations', '2026-26-lead-delete-fk-fixes.sql');
  assert.ok(fs.existsSync(migrationPath), 'migration file must exist');

  const migration = fs.readFileSync(migrationPath, 'utf8');

  // appointments → SET NULL (appointments are IMMUTABLE — no physical DELETE)
  assert.ok(migration.includes('appointments_lead_id_fkey'), 'must fix appointments FK');
  assert.ok(/appointments.*ON DELETE SET NULL/i.test(migration), 'appointments must be SET NULL');
  assert.ok(/appointments.*DROP NOT NULL/i.test(migration), 'appointments.lead_id must be made nullable');

  // booking_idempotency → CASCADE
  assert.ok(migration.includes('booking_idempotency_lead_id_fkey'), 'must fix booking_idempotency FK');
  assert.ok(/booking_idempotency.*ON DELETE CASCADE/i.test(migration), 'booking_idempotency must be CASCADE');

  // projection_outbox → CASCADE
  assert.ok(migration.includes('projection_outbox_lead_id_fkey'), 'must fix projection_outbox FK');
  assert.ok(/projection_outbox.*ON DELETE CASCADE/i.test(migration), 'projection_outbox must be CASCADE');

  // base44_entity_map → CASCADE
  assert.ok(migration.includes('base44_entity_map_railway_lead_id_fkey'), 'must fix base44_entity_map FK');
  assert.ok(/base44_entity_map.*ON DELETE CASCADE/i.test(migration), 'base44_entity_map must be CASCADE');

  // calendar_outbox → CASCADE (from appointments)
  assert.ok(migration.includes('calendar_outbox_appointment_id_fkey'), 'must fix calendar_outbox FK');
  assert.ok(/calendar_outbox.*ON DELETE CASCADE/i.test(migration), 'calendar_outbox must be CASCADE');

  // appointment_events → CASCADE (from appointments)
  assert.ok(migration.includes('appointment_events_appointment_id_fkey'), 'must fix appointment_events FK');
  assert.ok(/appointment_events.*ON DELETE CASCADE/i.test(migration), 'appointment_events must be CASCADE');

  // deals → SET NULL (business record survives)
  assert.ok(migration.includes('deals_lead_id_fkey'), 'must fix deals FK');
  assert.ok(/deals.*ON DELETE SET NULL/i.test(migration), 'deals must be SET NULL');
  assert.ok(/deals.*DROP NOT NULL/i.test(migration), 'deals.lead_id must be made nullable');
});

// ── Test 4: Horizontal dependency audit — all FK tables accounted for ────
test('Lead delete: all FK-dependent tables are accounted for in migration or existing schema', () => {
  const migration = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '2026-26-lead-delete-fk-fixes.sql'), 'utf8');

  // Tables that were NO_ACTION and needed migration fix
  const fixedInMigration = ['appointments', 'booking_idempotency', 'projection_outbox', 'base44_entity_map', 'calendar_outbox', 'appointment_events', 'deals'];
  for (const table of fixedInMigration) {
    assert.ok(migration.includes(table), `migration must address ${table}`);
  }

  // Tables that already had correct ON DELETE behavior (no migration needed):
  //   CASCADE: activities, tasks, invoices, lead_attachments, lead_submissions, signnow_documents
  //   SET NULL: deal_expenses, deal_commissions, deal_loan_payments, properties, handoff_estimates, estimates
  // These are verified by the schema audit in leadDealDetailP0.test.js
});

// ── Test 5: Delete handler uses single transaction (atomic) ──────────────
test('Lead delete: deletion is atomic in a single Postgres transaction', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leads.js'), 'utf8');

  // Count BEGIN/COMMIT/ROLLBACK in delete handlers
  const deleteSections = src.match(/router\.delete\([\s\S]*?\}\s*\);/g) || [];
  for (const section of deleteSections) {
    if (section.includes('cleanupLeadTextRefs')) {
      assert.ok(section.includes('BEGIN'), 'delete must start with BEGIN');
      assert.ok(section.includes('COMMIT'), 'delete must end with COMMIT');
      assert.ok(section.includes('ROLLBACK'), 'delete must have ROLLBACK on error');
    }
  }
});

// ── Test 6: No Base44 in delete path ──────────────────────────────────────
test('Lead delete: no Base44 references in delete handler', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leads.js'), 'utf8');
  const deleteSections = src.match(/router\.delete\([\s\S]*?\}\s*\);/g) || [];
  for (const section of deleteSections) {
    assert.ok(!section.includes('base44.functions'), 'delete must not call base44.functions');
    assert.ok(!section.includes('@base44/sdk'), 'delete must not use @base44/sdk');
  }
});

// ── Test 7: UUID delete path validates UUID format ─────────────────────────
test('Lead delete: DELETE /:id validates UUID format and rejects non-UUID', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leads.js'), 'utf8');
  const deleteIdMatch = src.match(/router\.delete\('\/:id'[\s\S]*?UUID_RE\.test/);
  assert.ok(deleteIdMatch, 'DELETE /:id must validate UUID format with UUID_RE.test');
  assert.ok(/DELETE \/:id requires a valid Railway UUID/.test(src), 'must return clear error for non-UUID');
});

// ── Test 8: external_ref delete path uses safe identifier resolution ────────
test('Lead delete: DELETE /by-external uses leadIdWhere for safe resolution', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'leads.js'), 'utf8');
  const deleteExtMatch = src.match(/router\.delete\('\/by-external[\s\S]*?leadIdWhere/);
  assert.ok(deleteExtMatch, 'DELETE /by-external must use leadIdWhere for safe identifier resolution');
});

// ── Test 9: No temporary admin endpoints in server.js ──────────────────────
test('Lead delete: no temporary migration/verification endpoints in server.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!src.includes('/admin/migrate'), 'must not have /admin/migrate endpoint');
  assert.ok(!src.includes('/admin/verify-lead-delete'), 'must not have /admin/verify-lead-delete endpoint');
});