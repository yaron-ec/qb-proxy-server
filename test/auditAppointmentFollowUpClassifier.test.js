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
