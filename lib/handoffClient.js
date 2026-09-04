/* eslint-disable no-undef */
/**
 * handoffClient — Official Handoff API GraphQL client for Railway.
 *
 * Restored from the last known working production path (Base44
 * syncHandoffEstimatesForLead), updated for the current Handoff GraphQL
 * schema (estimates now returns a flat list, not a connection; fields use
 * totalUsdCents / contact.phoneNumber / proposal.publicLink).
 *
 *   getValidToken()           — read token from app_settings (or env fallback)
 *   fetchAllEstimates(token)  — fetch all estimates, flattened for matching
 *   matchEstimateToLead(est, lead) — { match, method } phone/email/name match
 *
 * Endpoint:  https://app.handoff.ai/graphql   (HANDOFF_API_BASE_URL/graphql)
 * Auth:      Authorization: Bearer <token>     (NOT X-API-Key)
 *
 * No Base44 runtime dependency. Uses pg (db/client) for app_settings reads.
 */
'use strict';

const { query } = require('../db/client');

const HANDOFF_API = process.env.HANDOFF_API_BASE_URL || 'https://app.handoff.ai';
const GRAPHQL_URL = `${HANDOFF_API}/graphql`;

// ── Token management ──────────────────────────────────────────────────────

/**
 * Read the stored Handoff bearer token from the app_settings table.
 * Falls back to HANDOFF_AUTH_TOKEN env var if no DB token exists.
 * @returns {Promise<string|null>}
 */
async function getValidToken() {
  // 1. Try database (app_settings table — set via phone OTP or manual store-token)
  try {
    const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', ['handoff_bearer_token']);
    if (rows[0]) {
      const rawVal = rows[0].value;
      const tokenData = typeof rawVal === 'string' ? JSON.parse(rawVal || '{}') : (rawVal || {});
      if (tokenData.token) return tokenData.token;
    }
  } catch (e) {
    console.warn('[handoffClient] DB token read failed:', e.message);
  }

  // 2. Fall back to env var
  const envToken = process.env.HANDOFF_AUTH_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();

  throw new Error('NOT_AUTHENTICATED: No Handoff token in app_settings or HANDOFF_AUTH_TOKEN env var');
}

// ── GraphQL fetch ──────────────────────────────────────────────────────────

const ESTIMATES_QUERY = `
  query GetEstimates {
    estimates(input: {}) {
      id
      name
      state
      totalUsdCents
      createdAt
      contact {
        name
        email
        phoneNumber
      }
      proposal {
        publicLink
        state
      }
    }
  }
`;

/**
 * Fetch all estimates from Handoff and flatten for matching.
 * @param {string} token — Bearer token
 * @returns {Promise<Array>} flattened estimate objects
 */
async function fetchAllEstimates(token) {
  const all = [];

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query: ESTIMATES_QUERY }),
  });

  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error('AUTH_DENIED: Handoff API returned ' + res.status + ': ' + txt.slice(0, 200));
    }
    throw new Error('Handoff API error ' + res.status + ': ' + txt.slice(0, 300));
  }

  const data = await res.json();
  if (data.errors && data.errors.length) {
    const msg = data.errors[0].message || '';
    if (msg.toLowerCase().includes('auth') || msg.toLowerCase().includes('not authenticated')) {
      throw new Error('AUTH_DENIED: ' + msg);
    }
    throw new Error('Handoff GraphQL error: ' + msg);
  }

  const estimates = (data && data.data && data.data.estimates) || [];
  for (const node of estimates) {
    all.push({
      id: node.id,
      name: node.name,
      state: node.state,
      total: node.totalUsdCents ? (node.totalUsdCents / 100) : 0,
      createdAt: node.createdAt,
      clientName: (node.contact && node.contact.name) || '',
      clientPhone: (node.contact && node.contact.phoneNumber) || '',
      clientEmail: (node.contact && node.contact.email) || '',
      proposalLink: (node.proposal && node.proposal.publicLink) || null,
    });
  }

  return all;
}

// ── Lead matching ──────────────────────────────────────────────────────────

const normPhone = (p) => (p || '').replace(/\D/g, '').slice(-10);
const normEmail = (e) => (e || '').toLowerCase().trim();
const normName = (n) => (n || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-z\s]/g, '');

/**
 * Match an estimate to a lead by phone, email, or name.
 * @returns {{ match: boolean, method: string }}
 */
function matchEstimateToLead(est, lead) {
  const leadPhone = normPhone(lead.phone);
  const leadEmail = normEmail(lead.email);
  const leadName = normName((lead.first_name || '') + ' ' + (lead.last_name || ''));

  const estPhone = normPhone(est.clientPhone || '');
  const estEmail = normEmail(est.clientEmail || '');
  const estName = normName(est.clientName || '');

  if (estPhone && leadPhone && estPhone === leadPhone) return { match: true, method: 'name_phone' };
  if (estEmail && leadEmail && estEmail === leadEmail) return { match: true, method: 'name_email' };
  if (estName && leadName && estName === leadName) return { match: true, method: 'name_exact' };

  // Partial name match (first + last)
  if (estName && leadName) {
    const ep = estName.split(' '), lp = leadName.split(' ');
    if (ep.length >= 2 && lp.length >= 2 && ep[0] === lp[0] && ep[ep.length - 1] === lp[lp.length - 1]) {
      return { match: true, method: 'name_parts' };
    }
    // Last name only match
    if (ep[ep.length - 1] && ep[ep.length - 1] === lp[lp.length - 1] && ep[ep.length - 1].length > 2) {
      return { match: true, method: 'name_last' };
    }
  }

  return { match: false, method: 'none' };
}

module.exports = {
  getValidToken,
  fetchAllEstimates,
  matchEstimateToLead,
  HANDOFF_API,
  GRAPHQL_URL,
};