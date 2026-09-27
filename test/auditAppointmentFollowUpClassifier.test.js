/* eslint-disable no-undef */
'use strict';

/**
 * auditAppointmentFollowUpClassifier.test.js — DB-independent unit coverage
 * for scripts/auditAppointmentFollowUp.js#classify(), the pure classification
 * function behind the historical-data identification rule for the
 * "Overdue follow-up — Meeting" production investigation (Charles Carlson).
 *
 * classify() takes only a lead row (or a plain object shaped like one) and an
 * array of that lead's active appointment rows — no database access — yet its
 * only prior coverage (test/integration/appointmentFollowUp.int.test.js) is
 * gated behind TEST_DATABASE_URL and therefore NEVER runs in CI (CLAUDE.md:
 * "No DATABASE_URL is set" in .github/workflows/ci.yml). This file gives the
 * classifier itself unconditional regression coverage under plain `npm test`.
 *
 * Background: routes/metaWebhook.js's with-appointment branch used to run
 * `UPDATE leads SET follow_up_type = 'Meeting', meeting_stage = 'First
 * Meeting', ...` unconditionally on every booked lead — never touching
 * follow_up_date/time/notes/status (fixed in commit 4e02692, "Fix invalid_id
 * on Lead status save..."). Any lead created through that path before the fix
 * carries the exact signature this test locks down: follow_up_type set,
 * follow_up_date null — a combination lib/followUp.js#normalizeFollowUp's own
 * validation ("follow_up_date is required for a follow-up") makes impossible
 * to produce through any validated, app-driven save.
 */
const test = require('node:test');
const assert = require('node:assert');
const { classify } = require('../scripts/auditAppointmentFollowUp');

const ACTIVE_APPT = {
  id: 'a1', start_at: '2031-01-10T00:00:00Z', end_at: '2031-01-10T01:00:00Z', status: 'scheduled',
  busy_range: '["2031-01-09 23:00:00+00","2031-01-10 02:00:00+00")', timezone: 'America/Los_Angeles',
};

test('ORPHANED_TYPE: follow_up_type set with follow_up_date null — the exact pre-fix metaWebhook residue signature', () => {
  const c = classify({ follow_up_type: 'Meeting', follow_up_date: null }, []);
  assert.strictEqual(c.cls, 'ORPHANED_TYPE');
});

test('ORPHANED_TYPE fires regardless of whether the lead separately has a real active appointment', () => {
  const c = classify({ follow_up_type: 'Meeting', follow_up_date: null }, [ACTIVE_APPT]);
  assert.strictEqual(c.cls, 'ORPHANED_TYPE');
});

test('ORPHANED_TYPE is not specific to "Meeting" — any type with no date is equally invalid', () => {
  assert.strictEqual(classify({ follow_up_type: 'Phone Call', follow_up_date: null }, []).cls, 'ORPHANED_TYPE');
  assert.strictEqual(classify({ follow_up_type: 'Text', follow_up_date: null }, []).cls, 'ORPHANED_TYPE');
});

test('a lead with neither field set is not flagged by any class', () => {
  assert.strictEqual(classify({ follow_up_type: null, follow_up_date: null }, []), null);
});

test('a real, dated follow-up of type Meeting with no appointment is FOLLOWUP_ONLY, never ORPHANED_TYPE', () => {
  const c = classify({ follow_up_type: 'Meeting', follow_up_date: '2031-01-12' }, []);
  assert.strictEqual(c.cls, 'FOLLOWUP_ONLY');
});

test('MIRROR: dated follow-up whose date/time/kind exactly equal the active appointment, no notes', () => {
  const c = classify({ follow_up_date: '2031-01-09', follow_up_time: '16:00', follow_up_type: 'Meeting' }, [ACTIVE_APPT]);
  assert.strictEqual(c.cls, 'MIRROR');
});

test('DIVERGENT: an exact mirror that also carries notes is never auto-repairable', () => {
  const c = classify({ follow_up_date: '2031-01-09', follow_up_time: '16:00', follow_up_type: 'Meeting', follow_up_notes: 'Call to confirm scope' }, [ACTIVE_APPT]);
  assert.strictEqual(c.cls, 'DIVERGENT');
});

test('DIVERGENT: same kind, different date than the active appointment', () => {
  const c = classify({ follow_up_date: '2031-01-12', follow_up_time: '16:00', follow_up_type: 'Meeting' }, [ACTIVE_APPT]);
  assert.strictEqual(c.cls, 'DIVERGENT');
});

test('MULTI_ACTIVE: more than one active appointment is always reported, never auto-repaired', () => {
  const c = classify({ follow_up_date: '2031-01-12', follow_up_type: 'Text' }, [ACTIVE_APPT, ACTIVE_APPT]);
  assert.strictEqual(c.cls, 'MULTI_ACTIVE');
});

test('a plain, non-Meeting/Phone-Call follow-up alongside an appointment is not flagged at all (nothing to reconcile)', () => {
  assert.strictEqual(classify({ follow_up_date: '2031-01-12', follow_up_type: 'Text' }, [ACTIVE_APPT]), null);
});

// ── Provenance rules for --apply (historical cleanup) ───────────────────────
const { assess, assessMigratedKind, migrationStartMs, SEPARATION_CUTOVER } = require('../scripts/auditAppointmentFollowUp');

const migAppt = (over = {}) => ({
  id: 'm1', idempotency_key: 'migration:appt:b44-1', type_name: 'General Meeting',
  start_at: '2025-06-03T07:00:00Z', end_at: '2025-06-03T08:00:00Z', status: 'scheduled',
  busy_range: '["2025-06-03 07:00:00+00","2025-06-03 08:00:00+00")', timezone: 'America/Los_Angeles',
  busy_start: '2025-06-03T07:00:00Z', ...over,
});

test('provenance: the migration formula reproduces the fixed -07:00 offset (winter dates land 1h off Pacific)', () => {
  assert.strictEqual(new Date(migrationStartMs('2025-06-03', '00:00')).toISOString(), '2025-06-03T07:00:00.000Z');
  assert.strictEqual(new Date(migrationStartMs('2025-01-15', '10:00 AM')).toISOString(), '2025-01-15T17:00:00.000Z');
  assert.strictEqual(new Date(migrationStartMs('2025-01-15', null)).toISOString(), '2025-01-15T07:00:00.000Z');
  assert.strictEqual(SEPARATION_CUTOVER.toISOString(), '2026-09-24T22:07:24.000Z');
});

test('DIV_MIGRATION_SOURCE (Charles Carlson shape): migration row built from this Meeting follow-up → provably safe', () => {
  const a = assess({ external_ref: 'b44-1', follow_up_date: '2025-06-03', follow_up_time: '00:00', follow_up_type: 'Meeting', follow_up_status: 'pending' }, [migAppt()]);
  assert.deepStrictEqual([a.cls, a.sub, a.apply], ['DIVERGENT', 'DIV_MIGRATION_SOURCE', true]);
  assert.strictEqual(a.appt.kind, 'Phone Call', 'kind reads Phone Call only because the migration stored no buffer');
});

test('never applied: notes, completed status, a different lead\'s migration row, or a type that does not match', () => {
  const base = { external_ref: 'b44-1', follow_up_date: '2025-06-03', follow_up_time: '00:00', follow_up_type: 'Meeting' };
  assert.strictEqual(assess({ ...base, follow_up_notes: 'x' }, [migAppt()]).apply, false);
  assert.strictEqual(assess({ ...base, follow_up_status: 'completed' }, [migAppt()]).apply, false);
  assert.strictEqual(assess({ ...base, external_ref: 'b44-2' }, [migAppt()]).sub, 'DIV_OTHER');
  assert.strictEqual(assess(base, [migAppt({ type_name: 'Consultation' })]).sub, 'DIV_OTHER');
  assert.strictEqual(assess({ ...base, follow_up_time: '09:00' }, [migAppt()]).sub, 'DIV_OTHER', 'start must equal the formula exactly');
});

test('MIRROR is applied only with proven legacy provenance; a post-separation identical pair is left alone', () => {
  const lead = { follow_up_date: '2031-01-09', follow_up_time: '16:00', follow_up_type: 'Meeting' };
  const appt = { ...ACTIVE_APPT, idempotency_key: 'k', created_event_at: '2026-09-01T00:00:00Z' };
  assert.deepStrictEqual([assess(lead, [appt]).sub, assess(lead, [appt]).apply], ['MIRROR', true]);
  const after = { ...appt, created_event_at: '2026-09-25T00:00:00Z' };
  assert.deepStrictEqual([assess(lead, [after]).sub, assess(lead, [after]).apply], ['MIRROR_UNPROVEN', false]);
  const unknown = { ...appt, created_event_at: null };
  assert.strictEqual(assess(lead, [unknown]).apply, false, 'no creation evidence → not provable');
});

test('DIV_PRE_SEPARATION_MIRROR: Phone Call booked before the fix + hard-coded Meeting follow-up at the same time', () => {
  const pc = { id: 'p', idempotency_key: 'k', start_at: '2031-01-10T00:00:00Z', end_at: '2031-01-10T01:00:00Z', status: 'scheduled',
    busy_range: '["2031-01-10 00:00:00+00","2031-01-10 01:00:00+00")', timezone: 'America/Los_Angeles', created_event_at: '2026-08-01T00:00:00Z' };
  const lead = { follow_up_date: '2031-01-09', follow_up_time: '16:00', follow_up_type: 'Meeting' };
  assert.deepStrictEqual([assess(lead, [pc]).sub, assess(lead, [pc]).apply], ['DIV_PRE_SEPARATION_MIRROR', true]);
  assert.strictEqual(assess({ ...lead, follow_up_time: '17:00' }, [pc]).sub, 'DIV_OTHER');
});

test('MIGRATED_KIND: only past, never-synced migration Meetings are re-kinded; future / Google-synced / Consultation are not', () => {
  const now = Date.parse('2026-09-27T00:00:00Z');
  assert.deepStrictEqual(assessMigratedKind(migAppt(), now), { sub: 'MIGRATED_KIND', apply: true, reason: "past migration Meeting stored without buffer (reads as 'Phone Call')" });
  assert.strictEqual(assessMigratedKind(migAppt({ end_at: '2031-01-01T00:00:00Z' }), now).apply, false);
  assert.strictEqual(assessMigratedKind(migAppt({ google_event_id: 'e' }), now).apply, false);
  assert.strictEqual(assessMigratedKind(migAppt({ type_name: 'Consultation' }), now), null);
  assert.strictEqual(assessMigratedKind(migAppt({ busy_start: '2025-06-03T06:00:00Z' }), now), null, 'already buffered');
  assert.strictEqual(assessMigratedKind(migAppt({ idempotency_key: 'booking-x' }), now), null);
});
