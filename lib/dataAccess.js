/* eslint-disable no-undef */
/**
 * dataAccess — [TEMPORARY] Base44 data-access bridge.
 *
 * PURPOSE: give the Railway email endpoints access to Lead/Invoice/User/
 * CompanySettings data while the permanent Railway Postgres data model is
 * NOT yet built. This reads Base44 entities directly via the Base44 REST API
 * (lib/base44.js, service-role key) — NO Base44 backend function is invoked.
 *
 * TEMPORARY: every function here has a permanent replacement in the Railway
 * Postgres tables (leads, invoices, users, settings) per the final architecture.
 * REMOVAL POINT: Stage 7 of the migration (when Railway Postgres becomes the
 *   authoritative data store). After that, delete this file and replace call
 *   sites with Railway-Postgres queries. Nothing else depends on this module
 *   except the Phase 1 email routes.
 *
 * No Gmail, no sending — pure data reads.
 */
'use strict';

const b44 = require('./base44');

const CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com';

async function getLead(id) {
  if (!id) return null;
  try { return await b44.get('Lead', id); } catch { return null; }
}

async function getInvoice(id) {
  if (!id) return null;
  try { return await b44.get('Invoice', id); } catch { return null; }
}

async function getCompanySettings() {
  try {
    const rows = await b44.list('CompanySettings', '-created_date', 10, 0);
    return rows[0] || null;
  } catch { return null; }
}

// Resolve the staff email for an assigned rep name (e.g. "Yaron Drilevich" -> yaron@…).
function resolveOwnerEmail(ownerName) {
  if (!ownerName || typeof ownerName !== 'string') return null;
  const first = ownerName.trim().split(/\s+/)[0].toLowerCase();
  return first ? `${first}@ecconstructiongroup.com` : null;
}

function leadLink(leadId) {
  return `${CRM_PUBLIC_URL}/leads/${leadId}`;
}

module.exports = {
  // [TEMPORARY] — replaced by Railway Postgres `leads`/`invoices`/`settings` tables in Stage 7.
  getLead,
  getInvoice,
  getCompanySettings,
  resolveOwnerEmail,
  leadLink,
  CRM_PUBLIC_URL,
};