#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * dealModel.unit.test.js — pure-logic unit tests for lib/dealModel.js.
 *
 * No database, no external requires. Run from src/proxy-server/:
 *   node test/dealModel.unit.test.js
 *
 * Covers the Railway-native model: UUID lead_id, Base44 IDs as metadata,
 * migration resolution (planDealMigration), and the target-business-rule RBAC
 * (delete admin-only; manager read/create/update; sales_rep own).
 *
 * Exits 0 on full pass, 1 on any failure. Prints a JSON report.
 */
const m = require('../lib/dealModel');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Serialization ────────────────────────────────────────────────────────────
test('serializeDeal round-trips core fields (UUID lead_id + legacy metadata)', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111', lead_id: '22222222-2222-4222-8222-222222222222',
    legacy_base44_id: 'b44id', legacy_base44_lead_id: 'b44lead', name: 'Joann Gregg',
    amount: '4724.00', stage: 'Sold / Estimate Approved', pipeline: 'Default Pipeline',
    deposit_amount: '0', total_paid: '0', balance_due: '4724', payment_status: 'unpaid',
    stage_override: false, financial_revenue_source: 'quickbooks', lead_cost_type: 'percentage',
    lead_cost_calculation_base: 'total_contract', created_by: 'y@x.com',
    created_at: '2026-08-11', updated_at: '2026-08-11',
  };
  const d = m.serializeDeal(row);
  return d.id === '11111111-1111-4111-8111-111111111111'
    && d.lead_id === '22222222-2222-4222-8222-222222222222'
    && d.legacy_base44_id === 'b44id' && d.legacy_base44_lead_id === 'b44lead'
    && d.name === 'Joann Gregg' && d.amount === 4724 && d.stage === 'Sold / Estimate Approved'
    && d.payment_status === 'unpaid' && d.stage_override === false && d.deposit_amount === 0
    && d.created_date === '2026-08-11';
});

// ── Validation ───────────────────────────────────────────────────────────────
test('validateDealPayload: create requires name + lead_id', () => {
  const r = m.validateDealPayload({ amount: 100 }, { partial: false });
  return !r.ok && r.errors.includes('name is required') && r.errors.includes('lead_id is required');
});

test('validateDealPayload: create rejects non-UUID lead_id', () => {
  const r = m.validateDealPayload({ name: 'X', lead_id: 'b44lead-notuuid' }, { partial: false });
  return !r.ok && r.errors.includes('lead_id must be a valid Railway UUID');
});

test('validateDealPayload: create accepts valid UUID lead_id + legacy metadata', () => {
  const r = m.validateDealPayload({ name: 'X', lead_id: '22222222-2222-4222-8222-222222222222', legacy_base44_id: 'b44d', legacy_base44_lead_id: 'b44l' }, { partial: false });
  return r.ok && r.cleaned.lead_id === '22222222-2222-4222-8222-222222222222'
    && r.cleaned.legacy_base44_id === 'b44d' && r.cleaned.legacy_base44_lead_id === 'b44l';
});

test('validateDealPayload: invalid stage rejected', () => {
  const r = m.validateDealPayload({ name: 'X', lead_id: '22222222-2222-4222-8222-222222222222', stage: 'Bogus' }, { partial: false });
  return !r.ok && r.errors.includes('invalid stage') && r.cleaned.stage === undefined;
});

test('validateDealPayload: valid create accepted + numerics coerced', () => {
  const r = m.validateDealPayload({ name: 'X', lead_id: '22222222-2222-4222-8222-222222222222', stage: 'Deposit Paid', amount: '5000', deposit_amount: 1000 }, { partial: false });
  return r.ok && r.cleaned.stage === 'Deposit Paid' && r.cleaned.amount === 5000 && r.cleaned.deposit_amount === 1000;
});

test('validateDealPayload: partial update ignores lead_id + legacy fields (immutable)', () => {
  const r = m.validateDealPayload({ stage: 'Job Completed', lead_id: '33333333-3333-4333-8333-333333333333', legacy_base44_id: 'x' }, { partial: true });
  return r.ok && r.cleaned.stage === 'Job Completed' && r.cleaned.lead_id === undefined && r.cleaned.legacy_base44_id === undefined;
});

test('validateDealPayload: invalid payment_status / revenue_source / lead_cost_type rejected', () => {
  const r = m.validateDealPayload({ name: 'X', lead_id: '22222222-2222-4222-8222-222222222222', payment_status: 'bogus', financial_revenue_source: 'bogus', lead_cost_type: 'bogus' }, { partial: false });
  return !r.ok && r.errors.includes('invalid payment_status') && r.errors.includes('invalid financial_revenue_source') && r.errors.includes('invalid lead_cost_type');
});

// ── RBAC (target business rules) ────────────────────────────────────────────
test('canAccessDeal: admin/manager true; office false', () => {
  const deal = { assigned_rep: 'Yaron', created_by: 'a@x.com' };
  return m.canAccessDeal({ role: 'admin', email: 'a@x.com' }, deal) === true
    && m.canAccessDeal({ role: 'manager', email: 'b@x.com' }, deal) === true
    && m.canAccessDeal({ role: 'office', email: 'c@x.com' }, deal) === false;
});

test('canAccessDeal: sales_rep by assigned_rep email match (case-insensitive)', () => {
  const deal = { assigned_rep: 'yaron@ecconstructiongroup.com', created_by: 'other@x.com' };
  return m.canAccessDeal({ role: 'sales_rep', email: 'YARON@ecconstructiongroup.com', id: 'u2' }, deal) === true;
});

test('canAccessDeal: sales_rep by full_name match', () => {
  const deal = { assigned_rep: 'Yaron Drilevich', created_by: 'other@x.com' };
  return m.canAccessDeal({ role: 'sales_rep', email: 'yaron@ecconstructiongroup.com', full_name: 'Yaron Drilevich', id: 'u2' }, deal) === true;
});

test('canAccessDeal: sales_rep denied for other rep', () => {
  const deal = { assigned_rep: 'Michelle', created_by: 'm@x.com' };
  return m.canAccessDeal({ role: 'sales_rep', email: 'yaron@ecconstructiongroup.com', id: 'u2' }, deal) === false;
});

test('canAccessDeal: sales_rep by created_by email match', () => {
  const deal = { assigned_rep: 'Michelle', created_by: 'yaron@ecconstructiongroup.com' };
  return m.canAccessDeal({ role: 'sales_rep', email: 'yaron@ecconstructiongroup.com', id: 'u2' }, deal) === true;
});

test('canWriteDeal: create allowed for admin/manager/sales_rep; office denied', () => {
  return m.canWriteDeal({ role: 'admin' }, null, 'create') === true
    && m.canWriteDeal({ role: 'manager' }, null, 'create') === true
    && m.canWriteDeal({ role: 'sales_rep' }, null, 'create') === true
    && m.canWriteDeal({ role: 'office' }, null, 'create') === false;
});

test('canWriteDeal: update — admin yes, manager YES (target rule), sales_rep own yes, office no', () => {
  const deal = { assigned_rep: 'yaron@ecconstructiongroup.com', created_by: 'y@x.com' };
  return m.canWriteDeal({ role: 'admin' }, deal, 'update') === true
    && m.canWriteDeal({ role: 'manager' }, deal, 'update') === true
    && m.canWriteDeal({ role: 'sales_rep', email: 'yaron@ecconstructiongroup.com', id: 'u' }, deal, 'update') === true
    && m.canWriteDeal({ role: 'office' }, deal, 'update') === false;
});

test('canWriteDeal: delete — ADMIN ONLY (manager/sales_rep/office denied)', () => {
  const own = { assigned_rep: 'Yaron', created_by: 'yaron@ecconstructiongroup.com' };
  return m.canWriteDeal({ role: 'admin' }, own, 'delete') === true
    && m.canWriteDeal({ role: 'manager' }, own, 'delete') === false
    && m.canWriteDeal({ role: 'sales_rep', email: 'yaron@ecconstructiongroup.com', id: 'u' }, own, 'delete') === false
    && m.canWriteDeal({ role: 'office' }, own, 'delete') === false;
});

// ── Payment status ───────────────────────────────────────────────────────────
test('computePaymentStatus', () => {
  return m.computePaymentStatus(0, 5000) === 'unpaid'
    && m.computePaymentStatus(2500, 5000) === 'partial'
    && m.computePaymentStatus(5000, 5000) === 'paid'
    && m.computePaymentStatus(5000, 0) === 'unpaid';
});

// ── Lead→Deal sync guard ─────────────────────────────────────────────────────
test('applyDealUpdateGuard: job-owned fields never overwritten; assigned_rep applies to all', () => {
  const lead = { first_name: 'Joann', last_name: 'Gregg', assigned_rep: 'Yaron', estimated_value: 999, project_type: 'BOGUS', property_address: '999 X', sold_date: '2099-01-01' };
  const deals = [{ id: 'd1' }, { id: 'd2' }];
  const r1 = m.applyDealUpdateGuard(lead, deals, ['estimated_value', 'project_type', 'property_address', 'sold_date']);
  const r2 = m.applyDealUpdateGuard(lead, deals, ['assigned_rep']);
  const noJobOwned1 = Object.keys(r1.updates).every((k) => !m.JOB_OWNED_FIELDS.includes(k));
  const noJobOwned2 = Object.keys(r2.updates).every((k) => !m.JOB_OWNED_FIELDS.includes(k));
  return noJobOwned1 && r1.targets.length === 2 && r2.updates.assigned_rep === 'Yaron' && noJobOwned2;
});

test('repMatchCandidates: email + full_name + derived', () => {
  const c = m.repMatchCandidates({ email: 'YARON@ecconstructiongroup.com', full_name: 'Yaron Drilevich' });
  return c.includes('yaron@ecconstructiongroup.com') && c.includes('yaron drilevich');
});

// ── Migration resolution (Railway-native) ────────────────────────────────────
test('planDealMigration: A — legacy lead id resolves → migrated, lead_id = Railway UUID', () => {
  const b44 = { id: 'b44deal-001', lead_id: 'b44lead-joann', name: 'Joann', amount: 4724 };
  const railwayLeadId = '22222222-2222-4222-8222-222222222222';
  const plan = m.planDealMigration(b44, railwayLeadId);
  return plan.status === 'migrated' && plan.railwayLeadId === railwayLeadId
    && plan.dealPayload.lead_id === railwayLeadId            // ownership = UUID
    && plan.dealPayload.legacy_base44_id === 'b44deal-001'   // metadata
    && plan.dealPayload.legacy_base44_lead_id === 'b44lead-joann'; // metadata
});

test('planDealMigration: B — deal payload stores Railway UUID as lead_id, not legacy id', () => {
  const b44 = { id: 'b44deal-b', lead_id: 'b44lead-b', name: 'B' };
  const railwayLeadId = '33333333-3333-4333-8333-333333333333';
  const plan = m.planDealMigration(b44, railwayLeadId);
  return plan.dealPayload.lead_id === railwayLeadId && plan.dealPayload.lead_id !== 'b44lead-b';
});

test('planDealMigration: C — unresolved legacy Lead reported, no invented lead', () => {
  const b44 = { id: 'b44deal-c', lead_id: 'b44lead-NOWHERE', name: 'C' };
  const plan = m.planDealMigration(b44, null);
  return plan.status === 'unresolved' && plan.reason === 'railway_lead_not_found_by_external_ref'
    && plan.legacyBase44LeadId === 'b44lead-NOWHERE' && plan.dealPayload === undefined;
});

test('planDealMigration: D — no legacy lead_id → unresolved (never invents)', () => {
  const b44 = { id: 'b44deal-d', name: 'D' }; // no lead_id
  const plan = m.planDealMigration(b44, null);
  return plan.status === 'unresolved' && plan.reason === 'no_legacy_lead_id' && plan.dealPayload === undefined;
});

test('planDealMigration: E — multiple deals same legacy lead → same Railway UUID', () => {
  const railwayLeadId = '44444444-4444-4444-8444-444444444444';
  const p1 = m.planDealMigration({ id: 'b44-1', lead_id: 'b44lead-shared', name: 'J1' }, railwayLeadId);
  const p2 = m.planDealMigration({ id: 'b44-2', lead_id: 'b44lead-shared', name: 'J2' }, railwayLeadId);
  return p1.status === 'migrated' && p2.status === 'migrated'
    && p1.dealPayload.lead_id === railwayLeadId && p2.dealPayload.lead_id === railwayLeadId
    && p1.dealPayload.legacy_base44_id === 'b44-1' && p2.dealPayload.legacy_base44_id === 'b44-2';
});

test('planDealMigration: F — ownership is lead_id UUID; legacy_base44_id is metadata, not ownership', () => {
  const railwayLeadId = '55555555-5555-4555-8555-555555555555';
  const plan = m.planDealMigration({ id: 'b44-f', lead_id: 'b44lead-f', name: 'F' }, railwayLeadId);
  return plan.dealPayload.lead_id === railwayLeadId
    && plan.dealPayload.legacy_base44_id === 'b44-f'
    && plan.dealPayload.legacy_base44_lead_id === 'b44lead-f';
});

test('isValidUUID', () => {
  return m.isValidUUID('22222222-2222-4222-8222-222222222222') === true
    && m.isValidUUID('b44lead-notuuid') === false
    && m.isValidUUID(null) === false;
});

// Run
let pass = 0;
let fail = 0;
const failures = [];
for (const t of tests) {
  try {
    const ok = !!t.fn();
    if (ok) pass++;
    else { fail++; failures.push({ name: t.name }); }
  } catch (e) { fail++; failures.push({ name: t.name, error: e.message }); }
}
const report = { total: tests.length, pass, fail, failures };
console.log(JSON.stringify(report, null, 2));
process.exit(fail === 0 ? 0 : 1);