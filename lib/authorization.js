/* eslint-disable no-undef */
/**
 * authorization — stable-identity lead authorization for Railway routes.
 *
 * Replaces the fragile `assigned_rep === user.full_name` display-name check
 * with a deterministic ownership resolution:
 *   - admin / manager: always allowed (matches existing CRM RLS).
 *   - otherwise: resolve the lead's owner to a CANONICAL EMAIL and compare
 *     it to the authenticated Railway user's email (case-insensitive, trimmed).
 *     Display-name equality alone NEVER grants access.
 *
 * Owner resolution (temporary, until leads carry an `assigned_user_id`):
 *   - if `lead.assigned_rep` is itself an email, use it directly;
 *   - else resolve `<firstname>@<company domain>` from the first token.
 *     PRODUCTIZATION PHASE 2: `domain` is an optional param (default
 *     EC_DOMAIN, matching lib/captureValidation.js's identical pattern) —
 *     the async caller (routes/emails.js) resolves
 *     lib/companyConfig.js#getCompanyEmailDomain() and passes it explicitly,
 *     so this stays synchronous while a fresh installation's own domain is
 *     what's actually enforced, not EC's (otherwise every non-admin/manager
 *     sales_rep would be denied every lead, since their resolved owner
 *     email would never match their own real address).
 *
 * Stage B target: add `assigned_user_id` (Railway user UUID) to the leads
 * table and authorize by exact UUID match. This module is the single place
 * to change at that point.
 */
'use strict';

const EC_DOMAIN = 'ecconstructiongroup.com';

function canonicalEmail(v) {
  if (!v || typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

function resolveOwnerEmail(assignedRep, domain = EC_DOMAIN) {
  if (!assignedRep || typeof assignedRep !== 'string') return null;
  const direct = canonicalEmail(assignedRep);
  if (direct) return direct;
  const first = assignedRep.trim().split(/\s+/)[0].toLowerCase();
  return first ? `${first}@${domain}` : null;
}

function canAccessLead(user, lead, domain = EC_DOMAIN) {
  if (!user || !lead) return false;
  const role = String(user.role || '').toLowerCase();
  if (!role) return false;
  if (role === 'admin' || role === 'manager') return true;
  // office and any non-lead-scoped role are denied lead access (matches Lead
  // RLS, which grants lead scope only to admin/manager/sales_rep).
  if (role !== 'sales_rep') return false;
  const userEmail = canonicalEmail(user.email);
  if (!userEmail) return false;
  const ownerEmail = resolveOwnerEmail(lead.assigned_rep, domain);
  if (!ownerEmail) return false;
  return ownerEmail === userEmail;
}

module.exports = { canAccessLead, resolveOwnerEmail, canonicalEmail };