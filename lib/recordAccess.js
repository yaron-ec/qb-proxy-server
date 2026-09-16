/* eslint-disable no-undef */
'use strict';

/**
 * recordAccess — canonical row-level ownership/access-control layer for
 * record routes scoped by lead_id or deal_id.
 *
 * This does NOT replace the three existing role/ownership models — it
 * consolidates the missing piece they didn't cover:
 *   - lib/authorization.js#canAccessLead   (kept — still used by routes/emails.js)
 *   - routes/leads.js#resolveOwnerScope    (the real DB-level lead filter —
 *     reused here verbatim, exported so it has one implementation instead
 *     of two)
 *   - lib/dealModel.js#canAccessDeal/canWriteDeal (deal ownership — reused
 *     here, not reimplemented)
 *
 * It adds row-level checks for records that hang off a lead_id or deal_id
 * (tasks, activities, invoices, deal sub-resources) by resolving the
 * PARENT lead's or deal's ownership via those exact existing rules — no new
 * permission model, no new role semantics.
 *
 * Role semantics (unchanged from existing code):
 *   admin, manager  -> full access to every lead/deal-scoped record.
 *   office          -> read-only access to lead-scoped records (tasks,
 *                      activities, invoices) — matches routes/leads.js's
 *                      existing office={ownerFilter:null, readOnly:true}.
 *                      Denied entirely for deal-scoped records (deals carry
 *                      financial data; dealModel.resolveDealScope already
 *                      denies office there — unchanged here).
 *   sales_rep       -> scoped to leads owned via the owners-table match
 *                      (lead_id-scoped records), or deals matched via
 *                      assigned_rep/created_by (deal_id-scoped records).
 */

const { query } = require('../db/client');
const { canonicalEmail } = require('./authorization');
const dealModel = require('./dealModel');

const NO_MATCH_SENTINEL = '00000000-0000-0000-0000-000000000000';

// ── Lead-based scope ─────────────────────────────────────────────────────────
// Identical logic to routes/leads.js#resolveOwnerScope (single implementation
// going forward — routes/leads.js should import this rather than keep its
// own copy, see the follow-up note in that file).
async function resolveOwnerScope(user) {
  const role = String((user && user.role) || '').toLowerCase();
  if (!role) return { denied: true };
  if (role === 'admin' || role === 'manager') return { ownerFilter: null };
  if (role === 'office') return { ownerFilter: null, readOnly: true };
  if (role === 'sales_rep') {
    const email = canonicalEmail(user.email);
    if (!email) return { denied: true };
    const r = await query('SELECT id FROM owners WHERE lower(email) = lower($1) AND is_active = true', [email]);
    if (!r.rows[0]) return { ownerFilter: NO_MATCH_SENTINEL }; // no matching owner -> empty, fail closed
    return { ownerFilter: r.rows[0].id };
  }
  return { denied: true };
}

async function getLeadOwnerId(leadId) {
  if (!leadId) return undefined;
  const r = await query('SELECT owner_id FROM leads WHERE id = $1', [leadId]);
  return r.rows[0] ? r.rows[0].owner_id : undefined; // undefined = lead not found
}

/**
 * Can this user access a record scoped by lead_id?
 * @returns {{allowed:boolean, readOnly?:boolean, reason?:string}}
 *   reason is one of: 'role_denied' | 'missing_lead_id' | 'lead_not_found' | 'not_owner'
 */
async function checkLeadScope(user, leadId) {
  const scope = await resolveOwnerScope(user);
  if (scope.denied) return { allowed: false, reason: 'role_denied' };
  if (!leadId) return { allowed: false, reason: 'missing_lead_id' };
  if (scope.ownerFilter === null) return { allowed: true, readOnly: !!scope.readOnly }; // admin/manager/office
  const ownerId = await getLeadOwnerId(leadId);
  if (ownerId === undefined) return { allowed: false, reason: 'lead_not_found' };
  if (String(ownerId) !== String(scope.ownerFilter)) return { allowed: false, reason: 'not_owner' };
  return { allowed: true, readOnly: false };
}

// ── Deal-based scope ─────────────────────────────────────────────────────────
async function getDealForAccessCheck(dealId) {
  if (!dealId) return undefined;
  const r = await query('SELECT id, assigned_rep, created_by, lead_id FROM deals WHERE id = $1', [dealId]);
  return r.rows[0] || null; // null = not found
}

/**
 * Can this user access a record scoped by deal_id? Reuses dealModel's
 * existing resolveDealScope/canAccessDeal verbatim.
 * @returns {{allowed:boolean, reason?:string}}
 *   reason is one of: 'role_denied' | 'missing_deal_id' | 'deal_not_found' | 'not_owner'
 */
async function checkDealScope(user, dealId) {
  const scope = dealModel.resolveDealScope(user);
  if (scope.denied) return { allowed: false, reason: 'role_denied' };
  if (!dealId) return { allowed: false, reason: 'missing_deal_id' };
  if (!scope.scoped) return { allowed: true }; // admin/manager
  const deal = await getDealForAccessCheck(dealId);
  if (deal === undefined || deal === null) return { allowed: false, reason: 'deal_not_found' };
  if (!dealModel.canAccessDeal(user, deal)) return { allowed: false, reason: 'not_owner' };
  return { allowed: true };
}

// ── Express middleware factories ────────────────────────────────────────────

/**
 * requireLeadScope(getLeadId, opts) — Express middleware factory.
 * getLeadId(req) -> leadId | Promise<leadId>. Called AFTER any route-specific
 * lookup the handler needs to do (e.g. fetching an existing row to find its
 * lead_id) — pass an async function that does that lookup and returns the id.
 *
 * opts.allowReadOnly (default true): whether an office-role read-only match
 * is sufficient. Pass { allowReadOnly: false } on PUT/DELETE routes so office
 * (read-only) is denied write access while still allowed on GET.
 *
 * On success, sets req.leadScope and calls next(). On failure: 404 if the
 * parent lead doesn't exist (never leaks existence to an unauthorized
 * caller beyond "not found"), otherwise 403.
 */
function requireLeadScope(getLeadId, { allowReadOnly = true } = {}) {
  return async function (req, res, next) {
    try {
      const leadId = await getLeadId(req);
      const result = await checkLeadScope(req.user, leadId);
      if (!result.allowed) {
        const status = result.reason === 'lead_not_found' ? 404 : 403;
        return res.status(status).json({ error: status === 404 ? 'not_found' : 'forbidden' });
      }
      if (result.readOnly && !allowReadOnly) {
        return res.status(403).json({ error: 'forbidden', message: 'read-only role' });
      }
      req.leadScope = result;
      next();
    } catch (e) {
      console.error('[recordAccess] requireLeadScope error:', e.message);
      res.status(500).json({ error: 'authorization_check_failed' });
    }
  };
}

/**
 * requireDealScope(getDealId) — Express middleware factory, deal_id analog
 * of requireLeadScope. No readOnly concept — office is denied outright by
 * dealModel.resolveDealScope, matching existing deal-route behavior.
 */
function requireDealScope(getDealId) {
  return async function (req, res, next) {
    try {
      const dealId = await getDealId(req);
      const result = await checkDealScope(req.user, dealId);
      if (!result.allowed) {
        const status = result.reason === 'deal_not_found' ? 404 : 403;
        return res.status(status).json({ error: status === 404 ? 'not_found' : 'forbidden' });
      }
      req.dealScope = result;
      next();
    } catch (e) {
      console.error('[recordAccess] requireDealScope error:', e.message);
      res.status(500).json({ error: 'authorization_check_failed' });
    }
  };
}

module.exports = {
  NO_MATCH_SENTINEL,
  resolveOwnerScope,
  getLeadOwnerId,
  checkLeadScope,
  getDealForAccessCheck,
  checkDealScope,
  requireLeadScope,
  requireDealScope,
};
