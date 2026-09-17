/* eslint-disable no-undef */
'use strict';

/**
 * dealTimeline.test.js — behavioral coverage for the Deal Activity project
 * timeline (lib/dealTimeline.js#buildDealTimeline) and the completed_at
 * auto-stamp (lib/dealModel.js#computeCompletionFields).
 *
 * These are pure functions — real inputs, real assertions on the derived
 * output, not source-string checks — covering the exact scenarios the task
 * required: historical deals, new deals, contract signing, payment
 * milestones, work started, project completion (including the "no provable
 * date" case), completion-form uploads (including multiple), and that
 * re-deriving from the same input never produces duplicates.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildDealTimeline, dateOnlyLiteral } = require('../lib/dealTimeline');
const { computeCompletionFields, JOB_COMPLETED_STAGE } = require('../lib/dealModel');

function baseDeal(overrides = {}) {
  return {
    id: 'deal-1',
    lead_id: 'lead-1',
    amount: '50000',
    stage: 'Sold / Estimate Approved',
    sold_date: '2026-08-23T00:00:00.000Z',
    created_at: '2026-08-23T00:00:00.000Z',
    assigned_rep: 'Yaron Drilevich',
    created_by: 'yaron@ecconstructiongroup.com',
    work_start_date: null,
    deposit_amount: '0', deposit_paid: '0', deposit_paid_date: null,
    progress_payment_amount: '0', progress_payment_paid: '0', progress_payment_paid_date: null,
    final_payment_amount: '0', final_payment_paid: '0', final_payment_paid_date: null,
    completed_at: null, completed_by: null, close_date: null,
    ...overrides,
  };
}

// ── A/B: historical + new deal ──────────────────────────────────────────────
test('B: a brand-new deal produces exactly one event — Deal Sold', () => {
  const events = buildDealTimeline(baseDeal());
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].id, 'deal_sold');
  assert.strictEqual(events[0].category, 'milestone');
  assert.strictEqual(events[0].amount, 50000);
});

test('A: an existing deal with historical sold_date + deposit_paid_date + work_start_date produces all three, no fabricated events', () => {
  const deal = baseDeal({
    work_start_date: '2026-08-28',
    deposit_amount: '5000', deposit_paid: '5000', deposit_paid_date: '2026-08-25',
  });
  const events = buildDealTimeline(deal);
  const ids = events.map(e => e.id).sort();
  assert.deepStrictEqual(ids, ['deal_sold', 'deposit_paid', 'work_started']);
});

test('deal with NO sold_date falls back to created_at rather than omitting the Deal Sold event', () => {
  const deal = baseDeal({ sold_date: null });
  const events = buildDealTimeline(deal);
  const sold = events.find(e => e.id === 'deal_sold');
  assert.ok(sold);
  assert.strictEqual(sold.date, new Date(deal.created_at).toISOString());
});

// ── C: contract signed ──────────────────────────────────────────────────────
test('C: a signed SignNow document produces exactly one Contract Signed event', () => {
  const deal = baseDeal();
  const docs = [
    { id: 'doc-1', status: 'signed', created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T12:00:00Z', pdf_url: 'https://signnow/doc-1.pdf', document_name: 'Contract' },
  ];
  const events = buildDealTimeline(deal, docs);
  const contractEvents = events.filter(e => e.category === 'contract');
  assert.strictEqual(contractEvents.length, 1);
  assert.strictEqual(contractEvents[0].id, 'contract_signed:doc-1');
  assert.strictEqual(contractEvents[0].document.url, 'https://signnow/doc-1.pdf');
});

test('multiple signed SignNow documents pick the EARLIEST as Contract Signed, not the most recent', () => {
  const deal = baseDeal();
  const docs = [
    { id: 'doc-later', status: 'completed', created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z' },
    { id: 'doc-earliest', status: 'signed', created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z' },
  ];
  const events = buildDealTimeline(deal, docs);
  const contractEvents = events.filter(e => e.category === 'contract');
  assert.strictEqual(contractEvents.length, 1);
  assert.strictEqual(contractEvents[0].id, 'contract_signed:doc-earliest');
});

test('a SignNow document that never reached signed/completed produces no Contract Signed event', () => {
  const deal = baseDeal();
  const docs = [{ id: 'doc-1', status: 'sent', created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z' }];
  const events = buildDealTimeline(deal, docs);
  assert.strictEqual(events.filter(e => e.category === 'contract').length, 0);
});

// ── payment milestones: only PAID variants, never "Due" ─────────────────────
test('Due-only payment fields (no *_paid_date) produce NO payment event — only genuinely paid milestones are historical facts', () => {
  const deal = baseDeal({ deposit_amount: '5000', deposit_paid: '0', deposit_paid_date: null });
  const events = buildDealTimeline(deal);
  assert.strictEqual(events.filter(e => e.category === 'payment').length, 0);
});

test('all three payment milestones (deposit/progress/final) appear when paid+dated', () => {
  const deal = baseDeal({
    deposit_paid: '5000', deposit_paid_date: '2026-08-25',
    progress_payment_paid: '20000', progress_payment_paid_date: '2026-09-05',
    final_payment_paid: '25000', final_payment_paid_date: '2026-09-20',
  });
  const events = buildDealTimeline(deal);
  const paymentIds = events.filter(e => e.category === 'payment').map(e => e.id).sort();
  assert.deepStrictEqual(paymentIds, ['deposit_paid', 'final_payment_paid', 'progress_payment_paid']);
});

// ── E: work started ──────────────────────────────────────────────────────────
test('E: Work Started appears only when work_start_date is set', () => {
  assert.strictEqual(buildDealTimeline(baseDeal({ work_start_date: null })).some(e => e.id === 'work_started'), false);
  assert.strictEqual(buildDealTimeline(baseDeal({ work_start_date: '2026-08-28' })).some(e => e.id === 'work_started'), true);
});

// ── F: project completion — first-class event, but never fabricated ────────
test('F: Project Completed appears when stage is Job Completed AND completed_at is set', () => {
  const deal = baseDeal({ stage: JOB_COMPLETED_STAGE, completed_at: '2026-09-12T00:00:00Z', completed_by: 'yaron@ecconstructiongroup.com' });
  const events = buildDealTimeline(deal);
  const completion = events.find(e => e.category === 'completion');
  assert.ok(completion, 'expected a Project Completed event');
  assert.strictEqual(completion.by, 'yaron@ecconstructiongroup.com');
});

test('F: Project Completed falls back to close_date for a historical deal with no completed_at', () => {
  const deal = baseDeal({ stage: JOB_COMPLETED_STAGE, completed_at: null, close_date: '2026-07-01' });
  const events = buildDealTimeline(deal);
  const completion = events.find(e => e.category === 'completion');
  assert.ok(completion, 'expected a Project Completed event derived from close_date');
});

test('F: a Job Completed deal with NEITHER completed_at NOR close_date shows NO fabricated completion event', () => {
  const deal = baseDeal({ stage: JOB_COMPLETED_STAGE, completed_at: null, close_date: null });
  const events = buildDealTimeline(deal);
  assert.strictEqual(events.some(e => e.category === 'completion'), false);
});

test('a deal NOT at Job Completed never shows a completion event even if close_date happens to be set', () => {
  const deal = baseDeal({ stage: 'Work Started', close_date: '2026-07-01' });
  const events = buildDealTimeline(deal);
  assert.strictEqual(events.some(e => e.category === 'completion'), false);
});

// ── G/H: completion form uploads (PDF + image), multiple preserved ─────────
test('G: a completion form PDF upload produces a document event with file metadata', () => {
  const deal = baseDeal();
  const attachments = [{ id: 'att-1', file_name: 'completion.pdf', file_url: 'https://r2/completion.pdf', file_type: 'application/pdf', uploaded_by: 'yaron@ecconstructiongroup.com', uploaded_at: '2026-09-12T10:00:00Z' }];
  const events = buildDealTimeline(deal, [], attachments);
  const docEvent = events.find(e => e.category === 'document');
  assert.ok(docEvent);
  assert.strictEqual(docEvent.document.fileType, 'application/pdf');
  assert.strictEqual(docEvent.by, 'yaron@ecconstructiongroup.com');
});

test('H: a completion form JPG upload is treated the same as PDF (type-agnostic event derivation)', () => {
  const deal = baseDeal();
  const attachments = [{ id: 'att-2', file_name: 'completion.jpg', file_url: 'https://r2/completion.jpg', file_type: 'image/jpeg', uploaded_by: 'yaron@ecconstructiongroup.com', uploaded_at: '2026-09-12T10:00:00Z' }];
  const events = buildDealTimeline(deal, [], attachments);
  const docEvent = events.find(e => e.category === 'document');
  assert.ok(docEvent);
  assert.strictEqual(docEvent.document.fileType, 'image/jpeg');
});

test('multiple completion-form uploads are each preserved as their OWN historical event — a re-upload does not erase the earlier one', () => {
  const deal = baseDeal();
  const attachments = [
    { id: 'att-1', file_name: 'v1.pdf', file_url: 'https://r2/v1.pdf', file_type: 'application/pdf', uploaded_by: 'a@x.com', uploaded_at: '2026-09-10T00:00:00Z' },
    { id: 'att-2', file_name: 'v2.pdf', file_url: 'https://r2/v2.pdf', file_type: 'application/pdf', uploaded_by: 'b@x.com', uploaded_at: '2026-09-12T00:00:00Z' },
  ];
  const events = buildDealTimeline(deal, [], attachments);
  const docEvents = events.filter(e => e.category === 'document');
  assert.strictEqual(docEvents.length, 2);
});

// ── financial activity classification ───────────────────────────────────────
test('a change-order revenue edit is classified as category "change_order", a manual revenue adjustment stays generic "financial"', () => {
  const deal = baseDeal();
  const activities = [
    { id: 'act-1', content: 'Change orders updated to 750', author: 'y@x.com', created_at: '2026-09-05T00:00:00Z', metadata: { action: 'revenue_adjusted', category: 'financial' } },
    { id: 'act-2', content: 'Manual revenue adjustment updated to 200', author: 'y@x.com', created_at: '2026-09-06T00:00:00Z', metadata: { action: 'revenue_adjusted', category: 'financial' } },
  ];
  const events = buildDealTimeline(deal, [], [], activities);
  const changeOrder = events.find(e => e.id === 'activity:act-1');
  const manualAdj = events.find(e => e.id === 'activity:act-2');
  assert.strictEqual(changeOrder.category, 'change_order');
  assert.strictEqual(manualAdj.category, 'financial');
});

test('every mapped financial action produces a real (non-generic) title', () => {
  const deal = baseDeal();
  const actions = ['expense_added', 'expense_edited', 'expense_deleted', 'expense_payment_added', 'commission_added', 'commission_edited', 'commission_approved', 'commission_paid', 'commission_deleted', 'loan_payment_added', 'loan_payment_edited', 'loan_payment_deleted', 'lead_cost_changed'];
  const activities = actions.map((action, i) => ({ id: `act-${i}`, content: 'x', author: 'y@x.com', created_at: `2026-09-0${(i % 9) + 1}T00:00:00Z`, metadata: { action, category: 'financial' } }));
  const events = buildDealTimeline(deal, [], [], activities);
  for (const e of events.filter(ev => ev.category === 'financial')) {
    assert.notStrictEqual(e.title, 'Financial Update', `action should have a specific label, got generic fallback for ${e.id}`);
  }
});

// ── J: idempotency — re-deriving from the same input never duplicates ──────
test('J: calling buildDealTimeline twice with identical input produces identical output (no duplication on reload)', () => {
  const deal = baseDeal({ work_start_date: '2026-08-28', deposit_paid: '5000', deposit_paid_date: '2026-08-25' });
  const docs = [{ id: 'doc-1', status: 'signed', created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T00:00:00Z' }];
  const first = buildDealTimeline(deal, docs);
  const second = buildDealTimeline(deal, docs);
  assert.deepStrictEqual(first, second);
});

test('sorts newest-first and drops any event that ended up with no provable date', () => {
  const deal = baseDeal({ sold_date: '2026-08-23T00:00:00Z', work_start_date: '2026-08-28' });
  const events = buildDealTimeline(deal);
  for (let i = 1; i < events.length; i++) {
    assert.ok(new Date(events[i - 1].date) >= new Date(events[i].date), 'events must be sorted newest-first');
  }
});

// ── computeCompletionFields (lib/dealModel.js) ───────────────────────────────
test('computeCompletionFields stamps completed_at/completed_by on first transition to Job Completed', () => {
  const result = computeCompletionFields('Final Payment Paid', JOB_COMPLETED_STAGE, null, 'yaron@ecconstructiongroup.com');
  assert.ok(result);
  assert.strictEqual(result.completed_by, 'yaron@ecconstructiongroup.com');
  assert.ok(!Number.isNaN(new Date(result.completed_at).getTime()));
});

test('computeCompletionFields does NOT re-stamp if completed_at is already set (idempotent under retries)', () => {
  const result = computeCompletionFields('Job Completed', JOB_COMPLETED_STAGE, '2026-09-01T00:00:00Z', 'someone-else@x.com');
  assert.strictEqual(result, null);
});

test('computeCompletionFields does nothing when the new stage is not Job Completed', () => {
  const result = computeCompletionFields('Work Started', 'Progress Payment Due', null, 'y@x.com');
  assert.strictEqual(result, null);
});

test('computeCompletionFields does nothing on an unrelated field update where stage is already Job Completed (no-op re-save)', () => {
  const result = computeCompletionFields(JOB_COMPLETED_STAGE, JOB_COMPLETED_STAGE, null, 'y@x.com');
  assert.strictEqual(result, null, 'moving from Job Completed to Job Completed again should not re-stamp (already-completed guard)');
});

// ── K: authorization wiring (source-string — confirms the canonical layer is used) ──
function readRoot(rel) { return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8'); }

test('K: routes/dealTimeline.js uses the canonical checkDealScope authorization for both GET and POST', () => {
  const src = readRoot('routes/dealTimeline.js');
  const matches = src.match(/checkDealScope\(req\.user/g) || [];
  assert.ok(matches.length >= 2, 'expected checkDealScope on both the timeline GET and the completion-form POST');
});

test('K: routes/leadAttachments.js now authorizes every handler via checkLeadScope (closes the pre-existing gap this feature depends on)', () => {
  const src = readRoot('routes/leadAttachments.js');
  const matches = src.match(/checkLeadScope\(req\.user/g) || [];
  assert.ok(matches.length >= 5, `expected checkLeadScope on list/get/post/put/delete, found ${matches.length}`);
});

test('migration 2026-40 is additive only (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, no DROP/ALTER TYPE/RENAME)', () => {
  const src = readRoot('db/migrations/2026-40-deal-activity-timeline.sql');
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(src), 'migration must not drop anything');
  assert.ok(!/RENAME/i.test(src), 'migration must not rename anything');
  assert.ok(/ADD COLUMN IF NOT EXISTS completed_at/.test(src));
  assert.ok(/ADD COLUMN IF NOT EXISTS deal_id/.test(src));
});

// ═════════════════════════════════════════════════════════════════════════
// DATE-ONLY vs INSTANT semantics — regression coverage for the production
// defect: Deal Overview showed "Sold Date: Aug 23, 2026" while this
// timeline showed "Deal Sold: Aug 22, 2026" for the exact same underlying
// deals.sold_date value. Root cause: sold_date (and every other business
// date — work_start_date, the three *_paid_date fields, close_date) is
// stored as literal midnight UTC of the intended calendar day, but the
// timeline was running it through a real-instant formatter that explicitly
// converts to America/Los_Angeles — which always rolls UTC midnight back
// to the PREVIOUS Pacific calendar day. Fixed by tagging every event with
// dateKind ('date' | 'instant') and using dateOnlyLiteral() (no timezone
// math at all) for business dates. See lib/dealTimeline.js's header note.
// ═════════════════════════════════════════════════════════════════════════

test('dateOnlyLiteral extracts the literal calendar date with NO timezone conversion, from a Date object, an ISO string, or a bare date string', () => {
  assert.strictEqual(dateOnlyLiteral('2026-08-23'), '2026-08-23');
  assert.strictEqual(dateOnlyLiteral('2026-08-23T00:00:00.000Z'), '2026-08-23');
  assert.strictEqual(dateOnlyLiteral(new Date('2026-08-23T00:00:00.000Z')), '2026-08-23');
  assert.strictEqual(dateOnlyLiteral(null), null);
});

test('dateOnlyLiteral is stable across DST transition dates (no seasonal one-day drift)', () => {
  // 2026 US DST: spring-forward Mar 8, fall-back Nov 1. A literal-string
  // extraction has no seasonal dependence at all — verifying that is the
  // whole point of this helper existing instead of a Date-object timezone
  // conversion, which WOULD behave differently depending on whether PST
  // (-8) or PDT (-7) is in effect on either side of those dates.
  for (const d of ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']) {
    assert.strictEqual(dateOnlyLiteral(`${d}T00:00:00.000Z`), d, `expected ${d} to survive with no shift`);
  }
});

test('REGRESSION: Deal Sold for sold_date=2026-08-23 (August, PDT/UTC-7) is tagged dateKind "date" and keeps the literal 2026-08-23 — the exact production case that previously rendered as Aug 22', () => {
  const deal = baseDeal({ sold_date: '2026-08-23T00:00:00.000Z' });
  const events = buildDealTimeline(deal);
  const sold = events.find(e => e.id === 'deal_sold');
  assert.strictEqual(sold.dateKind, 'date');
  assert.strictEqual(sold.date, '2026-08-23');
});

test('REGRESSION: the same sold_date also holds in winter (PST/UTC-8) — the fix is timezone-season-independent, not a lucky August coincidence', () => {
  const deal = baseDeal({ sold_date: '2026-01-15T00:00:00.000Z' });
  const events = buildDealTimeline(deal);
  const sold = events.find(e => e.id === 'deal_sold');
  assert.strictEqual(sold.date, '2026-01-15');
});

test('Deal Sold falls back to created_at (a real instant) only when sold_date is absent, and is tagged dateKind "instant" in that case', () => {
  const deal = baseDeal({ sold_date: null, created_at: '2026-08-23T05:00:00.000Z' });
  const events = buildDealTimeline(deal);
  const sold = events.find(e => e.id === 'deal_sold');
  assert.strictEqual(sold.dateKind, 'instant');
  assert.strictEqual(sold.date, new Date(deal.created_at).toISOString());
});

test('Work Started and every paid payment milestone are tagged dateKind "date" and keep their literal calendar date', () => {
  const deal = baseDeal({
    work_start_date: '2026-08-28',
    deposit_paid: '5000', deposit_paid_date: '2026-08-25',
    progress_payment_paid: '20000', progress_payment_paid_date: '2026-09-05',
    final_payment_paid: '25000', final_payment_paid_date: '2026-09-20',
  });
  const events = buildDealTimeline(deal);
  const workStarted = events.find(e => e.id === 'work_started');
  const deposit = events.find(e => e.id === 'deposit_paid');
  const progress = events.find(e => e.id === 'progress_payment_paid');
  const final = events.find(e => e.id === 'final_payment_paid');
  assert.strictEqual(workStarted.dateKind, 'date');
  assert.strictEqual(workStarted.date, '2026-08-28');
  assert.strictEqual(deposit.dateKind, 'date');
  assert.strictEqual(deposit.date, '2026-08-25');
  assert.strictEqual(progress.dateKind, 'date');
  assert.strictEqual(progress.date, '2026-09-05');
  assert.strictEqual(final.dateKind, 'date');
  assert.strictEqual(final.date, '2026-09-20');
});

test('Contract Signed is tagged dateKind "instant" (a real SignNow e-signature timestamp, not a business date)', () => {
  const deal = baseDeal();
  const docs = [{ id: 'doc-1', status: 'signed', created_at: '2026-08-24T00:00:00Z', updated_at: '2026-08-24T12:00:00Z' }];
  const events = buildDealTimeline(deal, docs);
  const contract = events.find(e => e.category === 'contract');
  assert.strictEqual(contract.dateKind, 'instant');
  assert.strictEqual(contract.date, new Date(docs[0].updated_at).toISOString());
});

test('financial/change-order activity events and completion-form upload events are tagged dateKind "instant" (real created_at/uploaded_at timestamps)', () => {
  const deal = baseDeal();
  const activities = [{ id: 'act-1', content: 'x', author: 'y@x.com', created_at: '2026-09-05T00:00:00Z', metadata: { action: 'expense_added', category: 'financial' } }];
  const attachments = [{ id: 'att-1', file_name: 'completion.pdf', file_url: 'https://r2/completion.pdf', file_type: 'application/pdf', uploaded_by: 'y@x.com', uploaded_at: '2026-09-12T10:00:00Z' }];
  const events = buildDealTimeline(deal, [], attachments, activities);
  assert.strictEqual(events.find(e => e.category === 'financial').dateKind, 'instant');
  assert.strictEqual(events.find(e => e.category === 'document').dateKind, 'instant');
});

test('Project Completed is dateKind "instant" when completed_at (a real auto-stamped timestamp) is set, and dateKind "date" when it falls back to close_date (a business date) for a historical deal', () => {
  const withCompletedAt = buildDealTimeline(baseDeal({ stage: JOB_COMPLETED_STAGE, completed_at: '2026-09-12T00:00:00Z' }));
  const completionInstant = withCompletedAt.find(e => e.category === 'completion');
  assert.strictEqual(completionInstant.dateKind, 'instant');

  const withCloseDateOnly = buildDealTimeline(baseDeal({ stage: JOB_COMPLETED_STAGE, completed_at: null, close_date: '2026-07-01' }));
  const completionDate = withCloseDateOnly.find(e => e.category === 'completion');
  assert.strictEqual(completionDate.dateKind, 'date');
  assert.strictEqual(completionDate.date, '2026-07-01');
});
