/* eslint-disable no-undef */
/**
 * handoffClient — Official Handoff API client (GraphQL / Apollo Server).
 *
 * VERIFIED API CONTRACT (schema introspection confirmed):
 *   - The Handoff API is an Apollo GraphQL Server (NOT REST despite marketing).
 *   - Endpoint: HANDOFF_API_BASE_URL (GraphQL endpoint).
 *   - Auth: X-API-Key header with hnd_ API key (preferred), or
 *          Authorization: Bearer with session token (legacy phone OTP).
 *   - Estimate type fields: id, name, state, totalUsdCents, createdAt,
 *     isChangeOrder, isCurrentVersion, contact { id name email phoneNumber },
 *     project { id name status }, proposal { id publicLink state }.
 *   - Amounts are in INTEGER CENTS (totalUsdCents) — divide by 100 for dollars.
 *   - estimates query: { estimates { ... } } — no pagination, optional
 *     EstimatesInput { contactId } filter.
 *   - projects query: { projects(input: { pagination, clientId, search }) }
 *     with PaginatedProjects return type.
 *   - Proposal type has publicLink (the PDF/proposal URL).
 *
 * The legacy Base44 functions used WRONG field names (number, status, total,
 * client, customerName) — these don't exist in the schema. This module uses
 * the verified correct field names.
 */
'use strict';

const rda = require('./railwayDataAccess');

const HANDOFF_API = process.env.HANDOFF_API_BASE_URL || 'https://app.handoff.ai';

function getApiKey() {
  const raw = (process.env.HANDOFF_AUTH_TOKEN || '').trim();
  if (!raw) return null;
  // Strip "Bearer " prefix if present — we use X-API-Key header
  return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
}

async function getValidToken() {
  const apiKey = getApiKey();
  if (apiKey) return apiKey;
  // Fallback: Property entity in Postgres
  try {
    const records = await rda.filter('Property', { key: 'handoff_bearer_token' });
    if (records && records.length > 0) {
      const tokenData = JSON.parse(records[0].value || '{}');
      if (tokenData.token) return tokenData.token.trim();
    }
  } catch {}
  throw new Error('Handoff API key not configured. Set HANDOFF_AUTH_TOKEN to an hnd_ API key from Handoff Settings > Integrations & API Keys.');
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': token,
    'Authorization': 'Bearer ' + token,
  };
}

async function fetchGraphQL(token, query, variables) {
  const response = await fetch(HANDOFF_API, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ query: query, variables: variables || {} }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Non-JSON response (' + response.status + '): ' + text.slice(0, 200)); }
  const gqlErr = data && data.errors && data.errors[0];
  const code = (gqlErr && gqlErr.extensions && gqlErr.extensions.code) || '';
  if (response.status === 401 || code === 'NOT_AUTHENTICATED') {
    throw new Error('AUTH_DENIED: ' + ((gqlErr && gqlErr.message) || 'authentication error'));
  }
  if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + ((gqlErr && gqlErr.message) || text.slice(0, 200)));
  if (data.errors && data.errors.length) throw new Error('GraphQL error: ' + data.errors[0].message);
  return data.data;
}

// Verified estimates query — uses correct field names from schema introspection.
// No pagination on estimates (EstimatesInput only has optional contactId).
const ESTIMATES_QUERY = `{
  estimates {
    id
    name
    state
    totalUsdCents
    totalWithMarkupUsdCents
    createdAt
    isChangeOrder
    isCurrentVersion
    contact { id name email phoneNumber }
    project { id name status }
    proposal { id publicLink state sentAt approvedAt }
  }
}`;

async function fetchAllEstimates(token) {
  const data = await fetchGraphQL(token, ESTIMATES_QUERY);
  const estimates = (data && data.estimates) || [];
  if (!Array.isArray(estimates)) throw new Error('Unexpected estimates response shape');
  // Normalize to a flat structure for matching/upserting
  return estimates.map(function (est) {
    return {
      id: est.id,
      name: est.name || '',
      state: est.state || 'DRAFT',
      totalCents: est.totalUsdCents || 0,
      totalWithMarkupCents: est.totalWithMarkupUsdCents || 0,
      total: (est.totalUsdCents || 0) / 100, // convert cents to dollars
      createdAt: est.createdAt || null,
      isChangeOrder: est.isChangeOrder || false,
      isCurrentVersion: est.isCurrentVersion !== false,
      clientName: (est.contact && est.contact.name) || '',
      clientPhone: (est.contact && est.contact.phoneNumber) || '',
      clientEmail: (est.contact && est.contact.email) || '',
      clientId: (est.contact && est.contact.id) || '',
      projectId: (est.project && est.project.id) || '',
      projectName: (est.project && est.project.name) || '',
      proposalId: (est.proposal && est.proposal.id) || '',
      proposalLink: (est.proposal && est.proposal.publicLink) || '',
      proposalState: (est.proposal && est.proposal.state) || '',
    };
  });
}

// Fetch estimates filtered by contactId (for per-lead sync)
async function fetchEstimatesForContact(token, contactId) {
  const query = 'query ($contactId: ID) { estimates(input: { contactId: $contactId }) { id name state totalUsdCents createdAt contact { id name email phoneNumber } project { id name } proposal { id publicLink state } } }';
  const data = await fetchGraphQL(token, query, { contactId: contactId });
  const estimates = (data && data.estimates) || [];
  return estimates.map(function (est) {
    return {
      id: est.id, name: est.name || '', state: est.state || 'DRAFT',
      totalCents: est.totalUsdCents || 0, total: (est.totalUsdCents || 0) / 100,
      createdAt: est.createdAt || null,
      clientName: (est.contact && est.contact.name) || '',
      clientPhone: (est.contact && est.contact.phoneNumber) || '',
      clientEmail: (est.contact && est.contact.email) || '',
      clientId: (est.contact && est.contact.id) || '',
      projectId: (est.project && est.project.id) || '',
      proposalId: (est.proposal && est.proposal.id) || '',
      proposalLink: (est.proposal && est.proposal.publicLink) || '',
    };
  });
}

// Matching helpers
function normalizePhone(p) { return p ? String(p).replace(/\D/g, '').slice(-10) : ''; }
function normalizeName(n) { return (n || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z\s]/g, ''); }
function normalizeEmail(e) { return (e || '').toLowerCase().trim(); }

function matchEstimateToLead(est, lead) {
  var leadPhone = normalizePhone(lead.phone);
  var leadEmail = normalizeEmail(lead.email);
  var leadName = normalizeName((lead.first_name || '') + ' ' + (lead.last_name || ''));
  var estPhone = normalizePhone(est.clientPhone || '');
  var estEmail = normalizeEmail(est.clientEmail || '');
  var estName = normalizeName(est.clientName || '');
  if (estPhone && leadPhone && estPhone === leadPhone) return { match: true, method: 'phone' };
  if (estEmail && leadEmail && estEmail === leadEmail) return { match: true, method: 'email' };
  if (estName && leadName && estName === leadName) return { match: true, method: 'name_exact' };
  if (estName && leadName) {
    var ep = estName.split(' '), lp = leadName.split(' ');
    if (ep.length >= 2 && lp.length >= 2 && ep[0] === lp[0] && ep[ep.length - 1] === lp[lp.length - 1]) return { match: true, method: 'name_parts' };
  }
  return { match: false, method: 'none' };
}

module.exports = {
  getValidToken: getValidToken,
  fetchAllEstimates: fetchAllEstimates,
  fetchEstimatesForContact: fetchEstimatesForContact,
  matchEstimateToLead: matchEstimateToLead,
  normalizePhone: normalizePhone,
  normalizeEmail: normalizeEmail,
  normalizeName: normalizeName,
  HANDOFF_API: HANDOFF_API,
};
