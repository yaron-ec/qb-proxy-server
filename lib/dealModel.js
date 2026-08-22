/* eslint-disable no-undef */
'use strict';
/**
 * dealModel — pure-JS Sales (Deal) model helpers for the Railway CRM.
 *
 * NO external requires. Shared by:
 *   - routes/deals.js          (CRUD endpoint)
 *   - scripts/dryRunDeals.js   (isolated DB validation)
 *   - test/dealModel.unit.test.js (pure-logic unit tests)
 *
 * RAILWAY-NATIVE MODEL (post-correction):
 *   * deals.id        UUID (Railway-native)
 *   * deals.lead_id   UUID — canonical FK to leads(id). NEVER a Base44 ObjectId.
 *   * legacy_base44_id / legacy_base44_lead_id — migration metadata ONLY.
 *
 * MIGRATION RESOLUTION:
 *   Base44 Deal.lead_id → resolve Railway Lead by leads.external_ref →
 *   deals.lead_id = Railway leads.id (UUID). Unresolved → reported, not inserted.
 *
 * RBAC (target business rules — NOT a blind copy of Base44 Deal RLS):
 *   read:   admin all, manager all, sales_rep own (assigned_rep/created_by),
 *           office denied
 *   create: admin, manager, sales_rep
 *   update: admin, manager (all), sales_rep (own)
 *   delete: ADMIN ONLY  (unless a verified business requirement says otherwise)
 */

const STAGES = [
  'Sold / Estimate Approved', 'Deposit Due', 'Deposit Paid', 'Work Scheduled',
  'Work Started', 'Progress Payment Due', 'Progress Payment Paid',
  'Final Payment Due', 'Final Payment Paid', 'Job Completed',
];
const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'];
const REVENUE_SOURCES = ['quickbooks', 'manual'];
const LEAD_COST_TYPES = ['percentage', 'fixed'];
const LEAD_COST_BASES = ['total_contract', 'payments_received', 'gross_profit_before_lead_cost', 'custom'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(v) { return typeof v === 'string' && UUID_RE.test(v); }

// Fields a create/update payload may set. Everything else is ignored (whitelist).
// lead_id is writable on CREATE only (validated as UUID). Immutable on update.
// legacy_base44_id / legacy_base44_lead_id are writable on CREATE only.
const DEAL_WRITABLE_FIELDS = [
  'lead_id', 'legacy_base44_id', 'legacy_base44_lead_id',
  'name', 'amount', 'stage', 'pipeline', 'close_date', 'sold_date',
  'work_start_date', 'work_end_date', 'description', 'notes', 'project_type',
  'property_address', 'assigned_rep',
  'deposit_amount', 'deposit_paid', 'deposit_paid_date',
  'progress_payment_amount', 'progress_payment_paid', 'progress_payment_paid_date',
  'final_payment_amount', 'final_payment_paid', 'final_payment_paid_date',
  'contract_amount', 'total_paid', 'balance_due', 'paid_percentage', 'payment_status',
  'stage_override', 'financial_change_orders_amount', 'financial_manual_revenue_adjustment',
  'financial_revenue_source', 'financial_other_costs_amount',
  'lead_cost_type', 'lead_cost_percentage', 'lead_cost_fixed_amount',
  'lead_cost_calculation_base', 'lead_cost_custom_base_amount', 'lead_cost_amount',
  'lead_cost_notes', 'company_share_amount',
];

// Job-owned fields — a Lead→Deal sync NEVER overwrites these on an existing Deal.
const JOB_OWNED_FIELDS = ['amount', 'project_type', 'property_address', 'sold_date'];

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// snake_case DB row → camelCase API response. lead_id is a Railway UUID.
// legacy_base44_id / legacy_base44_lead_id are returned as metadata only.
function serializeDeal(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    legacy_base44_id: row.legacy_base44_id || null,
    legacy_base44_lead_id: row.legacy_base44_lead_id || null,
    name: row.name,
    amount: row.amount != null ? Number(row.amount) : null,
    stage: row.stage,
    pipeline: row.pipeline,
    close_date: row.close_date || null,
    sold_date: row.sold_date || null,
    work_start_date: row.work_start_date || null,
    work_end_date: row.work_end_date || null,
    description: row.description || null,
    notes: row.notes || null,
    project_type: row.project_type || null,
    property_address: row.property_address || null,
    assigned_rep: row.assigned_rep || null,
    deposit_amount: Number(row.deposit_amount || 0),
    deposit_paid: Number(row.deposit_paid || 0),
    deposit_paid_date: row.deposit_paid_date || null,
    progress_payment_amount: Number(row.progress_payment_amount || 0),
    progress_payment_paid: Number(row.progress_payment_paid || 0),
    progress_payment_paid_date: row.progress_payment_paid_date || null,
    final_payment_amount: Number(row.final_payment_amount || 0),
    final_payment_paid: Number(row.final_payment_paid || 0),
    final_payment_paid_date: row.final_payment_paid_date || null,
    contract_amount: row.contract_amount != null ? Number(row.contract_amount) : null,
    total_paid: Number(row.total_paid || 0),
    balance_due: Number(row.balance_due || 0),
    paid_percentage: Number(row.paid_percentage || 0),
    payment_status: row.payment_status,
    stage_override: !!row.stage_override,
    financial_change_orders_amount: Number(row.financial_change_orders_amount || 0),
    financial_manual_revenue_adjustment: Number(row.financial_manual_revenue_adjustment || 0),
    financial_revenue_source: row.financial_revenue_source,
    financial_other_costs_amount: Number(row.financial_other_costs_amount || 0),
    lead_cost_type: row.lead_cost_type,
    lead_cost_percentage: Number(row.lead_cost_percentage || 0),
    lead_cost_fixed_amount: Number(row.lead_cost_fixed_amount || 0),
    lead_cost_calculation_base: row.lead_cost_calculation_base,
    lead_cost_custom_base_amount: Number(row.lead_cost_custom_base_amount || 0),
    lead_cost_amount: Number(row.lead_cost_amount || 0),
    lead_cost_notes: row.lead_cost_notes || null,
    company_share_amount: Number(row.company_share_amount || 0),
    created_by: row.created_by || null,
    updated_by: row.updated_by || null,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

// Role-level scope (pure). admin/manager → all; sales_rep → scoped to own;
// office → denied (deals carry financial data; office has no deal access).
function resolveDealScope(user) {
  const role = String((user && user.role) || '').toLowerCase();
  if (!role) return { denied: true };
  if (role === 'admin') return { denied: false, role };
  if (role === 'manager') return { denied: false, role };
  if (role === 'sales_rep') return { denied: false, role, scoped: true };
  return { denied: true }; // office + unknown
}

// Candidate assigned_rep strings that grant a sales_rep access to a deal.
function repMatchCandidates(user) {
  const email = (user && user.email && String(user.email).trim().toLowerCase()) || null;
  const fullName = (user && user.full_name && String(user.full_name).trim()) || null;
  const first = fullName ? fullName.split(/\s+/)[0].toLowerCase() : null;
  const derived = first ? `${first}@ecconstructiongroup.com` : null;
  const out = [];
  if (email) out.push(email);
  if (fullName && fullName.toLowerCase() !== email) out.push(fullName.toLowerCase());
  if (derived && !out.includes(derived)) out.push(derived);
  return out;
}

// Row-level read access (pure). admin/manager → true. sales_rep → assigned_rep
// candidate match OR created_by match. office → false.
function canAccessDeal(user, deal) {
  if (!user || !deal) return false;
  const role = String(user.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (role !== 'sales_rep') return false;
  const candidates = repMatchCandidates(user);
  const rep = (deal.assigned_rep && String(deal.assigned_rep).trim().toLowerCase()) || null;
  if (rep && candidates.includes(rep)) return true;
  const userId = user.id || user.sub || null;
  if (userId && deal.created_by && String(deal.created_by) === String(userId)) return true;
  if (user.email && deal.created_by && String(deal.created_by).toLowerCase() === user.email.toLowerCase()) return true;
  return false;
}

// Write permission (target business rules — NOT a blind copy of Base44 Deal RLS):
//   create: admin / manager / sales_rep
//   update: admin / manager (all) / sales_rep (own). office denied.
//   delete: ADMIN ONLY. (manager/sales_rep/office denied unless a verified
//           business requirement restores one of them.)
function canWriteDeal(user, deal, op) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  if (op === 'create') return role === 'admin' || role === 'manager' || role === 'sales_rep';
  if (op === 'update') {
    if (role === 'admin' || role === 'manager') return true;
    if (role !== 'sales_rep') return false;
    return canAccessDeal(user, deal);
  }
  if (op === 'delete') {
    return role === 'admin'; // ADMIN ONLY
  }
  return false;
}

// Validate + clean a create/update payload.
//   partial=false (create): name + lead_id required; lead_id must be a UUID.
//   partial=true (update): lead_id / legacy_* ignored (immutable).
function validateDealPayload(body, { partial = false } = {}) {
  const errors = [];
  const cleaned = {};
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body required'], cleaned: {} };

  if (!partial) {
    if (!body.name || !String(body.name).trim()) errors.push('name is required');
    if (!body.lead_id || !String(body.lead_id).trim()) errors.push('lead_id is required');
    else if (!isValidUUID(body.lead_id)) errors.push('lead_id must be a valid Railway UUID');
  }

  if (body.name !== undefined) cleaned.name = String(body.name);
  // lead_id is only accepted on create (immutable on update; route strips it).
  if (!partial && body.lead_id !== undefined) cleaned.lead_id = String(body.lead_id);
  if (!partial && body.legacy_base44_id !== undefined) cleaned.legacy_base44_id = body.legacy_base44_id ? String(body.legacy_base44_id) : null;
  if (!partial && body.legacy_base44_lead_id !== undefined) cleaned.legacy_base44_lead_id = body.legacy_base44_lead_id ? String(body.legacy_base44_lead_id) : null;
  if (body.amount !== undefined) { const n = toNum(body.amount); if (n === undefined) errors.push('amount must be numeric'); else cleaned.amount = n; }
  if (body.stage !== undefined) { if (!STAGES.includes(body.stage)) errors.push('invalid stage'); else cleaned.stage = body.stage; }
  if (body.pipeline !== undefined) cleaned.pipeline = String(body.pipeline);
  if (body.close_date !== undefined) cleaned.close_date = body.close_date || null;
  if (body.sold_date !== undefined) cleaned.sold_date = body.sold_date || null;
  if (body.work_start_date !== undefined) cleaned.work_start_date = body.work_start_date || null;
  if (body.work_end_date !== undefined) cleaned.work_end_date = body.work_end_date || null;
  if (body.description !== undefined) cleaned.description = body.description ? String(body.description) : null;
  if (body.notes !== undefined) cleaned.notes = body.notes ? String(body.notes) : null;
  if (body.project_type !== undefined) cleaned.project_type = body.project_type ? String(body.project_type) : null;
  if (body.property_address !== undefined) cleaned.property_address = body.property_address ? String(body.property_address) : null;
  if (body.assigned_rep !== undefined) cleaned.assigned_rep = body.assigned_rep ? String(body.assigned_rep) : null;

  const numFields = [
    'deposit_amount', 'deposit_paid', 'progress_payment_amount', 'progress_payment_paid',
    'final_payment_amount', 'final_payment_paid', 'contract_amount', 'total_paid',
    'balance_due', 'paid_percentage', 'financial_change_orders_amount',
    'financial_manual_revenue_adjustment', 'financial_other_costs_amount',
    'lead_cost_percentage', 'lead_cost_fixed_amount', 'lead_cost_custom_base_amount',
    'lead_cost_amount', 'company_share_amount',
  ];
  for (const f of numFields) {
    if (body[f] !== undefined) { const n = toNum(body[f]); if (n === undefined) errors.push(f + ' must be numeric'); else cleaned[f] = n; }
  }
  const dateFields = ['deposit_paid_date', 'progress_payment_paid_date', 'final_payment_paid_date'];
  for (const f of dateFields) { if (body[f] !== undefined) cleaned[f] = body[f] || null; }

  if (body.payment_status !== undefined) { if (!PAYMENT_STATUSES.includes(body.payment_status)) errors.push('invalid payment_status'); else cleaned.payment_status = body.payment_status; }
  if (body.stage_override !== undefined) cleaned.stage_override = !!body.stage_override;
  if (body.financial_revenue_source !== undefined) { if (!REVENUE_SOURCES.includes(body.financial_revenue_source)) errors.push('invalid financial_revenue_source'); else cleaned.financial_revenue_source = body.financial_revenue_source; }
  if (body.lead_cost_type !== undefined) { if (!LEAD_COST_TYPES.includes(body.lead_cost_type)) errors.push('invalid lead_cost_type'); else cleaned.lead_cost_type = body.lead_cost_type; }
  if (body.lead_cost_calculation_base !== undefined) { if (!LEAD_COST_BASES.includes(body.lead_cost_calculation_base)) errors.push('invalid lead_cost_calculation_base'); else cleaned.lead_cost_calculation_base = body.lead_cost_calculation_base; }
  if (body.lead_cost_notes !== undefined) cleaned.lead_cost_notes = body.lead_cost_notes ? String(body.lead_cost_notes) : null;

  return { ok: errors.length === 0, errors, cleaned };
}

function computePaymentStatus(totalPaid, contractAmount) {
  const paid = Number(totalPaid) || 0;
  const total = Number(contractAmount) || 0;
  if (total > 0 && paid >= total) return 'paid';
  if (total > 0 && paid > 0) return 'partial';
  return 'unpaid'; // no contract amount → not partial/paid (matches frontend contract_amount===0 rule)
}

// Lead→Deal sync guard: job-owned fields are NEVER overwritten on an existing
// Deal. Only identity fields (name, assigned_rep) sync, applied to ALL deals.
function applyDealUpdateGuard(lead, deals, changedFields) {
  if (!deals || deals.length === 0) return { updates: {}, targets: [] };
  const updates = {};
  if (changedFields.includes('first_name') || changedFields.includes('last_name')) {
    updates.name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
  }
  if (changedFields.includes('assigned_rep')) {
    updates.assigned_rep = lead.assigned_rep != null ? lead.assigned_rep : null;
  }
  // job-owned fields explicitly ignored — no update produced
  return { updates, targets: deals.map((d) => d.id) };
}

// ── Base44 → Railway migration resolution ──────────────────────────────────
// Resolve a Railway Lead UUID from a Base44 Lead ObjectId via leads.external_ref.
async function resolveRailwayLeadIdByExternalRef(db, legacyBase44LeadId) {
  if (!legacyBase44LeadId) return null;
  const r = await db.query('SELECT id FROM leads WHERE external_ref = $1 LIMIT 1', [String(legacyBase44LeadId)]);
  return r && r.rows && r.rows[0] ? r.rows[0].id : null;
}

// Pure decision: given a Base44 Deal and the resolved Railway Lead UUID (or
// null), produce the migration plan. Never invents a lead. Never stores the
// legacy ObjectId as the ownership key. Unit-testable (no DB).
//   returns { status: 'migrated', railwayLeadId, legacyBase44LeadId,
//             legacyBase44DealId, dealPayload }
//        | { status: 'unresolved', reason, legacyBase44LeadId?, legacyBase44DealId? }
function planDealMigration(b44Deal, railwayLeadId) {
  const legacyDealId = b44Deal && b44Deal.id ? String(b44Deal.id) : null;
  const legacyLeadId = b44Deal && b44Deal.lead_id ? String(b44Deal.lead_id) : null;
  if (!legacyLeadId) {
    return { status: 'unresolved', reason: 'no_legacy_lead_id', legacyBase44DealId: legacyDealId };
  }
  if (!railwayLeadId) {
    return { status: 'unresolved', reason: 'railway_lead_not_found_by_external_ref', legacyBase44LeadId: legacyLeadId, legacyBase44DealId: legacyDealId };
  }
  // Ownership key = Railway UUID. Legacy IDs are metadata only.
  const dealPayload = { ...b44Deal };
  delete dealPayload.id;
  delete dealPayload.lead_id;
  dealPayload.lead_id = railwayLeadId;                 // canonical FK (UUID)
  dealPayload.legacy_base44_id = legacyDealId;        // metadata
  dealPayload.legacy_base44_lead_id = legacyLeadId;   // metadata
  return {
    status: 'migrated',
    railwayLeadId,
    legacyBase44LeadId: legacyLeadId,
    legacyBase44DealId: legacyDealId,
    dealPayload,
  };
}

// DB-backed migration: resolves the lead, then returns the plan. The caller
// (migration script) inserts dealPayload ONLY when status === 'migrated'.
async function migrateDealFromBase44(db, b44Deal, opts = {}) {
  const legacyLeadId = b44Deal && b44Deal.lead_id ? String(b44Deal.lead_id) : null;
  let railwayLeadId = null;
  if (legacyLeadId) {
    railwayLeadId = opts.resolveLead
      ? await opts.resolveLead(legacyLeadId)
      : await resolveRailwayLeadIdByExternalRef(db, legacyLeadId);
  }
  return planDealMigration(b44Deal, railwayLeadId);
}

module.exports = {
  STAGES, PAYMENT_STATUSES, REVENUE_SOURCES, LEAD_COST_TYPES, LEAD_COST_BASES,
  DEAL_WRITABLE_FIELDS, JOB_OWNED_FIELDS, UUID_RE, isValidUUID,
  serializeDeal, resolveDealScope, repMatchCandidates, canAccessDeal, canWriteDeal,
  validateDealPayload, computePaymentStatus, applyDealUpdateGuard,
  resolveRailwayLeadIdByExternalRef, planDealMigration, migrateDealFromBase44,
};