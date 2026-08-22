/* eslint-disable no-undef */
/**
 * qbInternal — internal HTTP client for calling the existing QB proxy
 * endpoints (defined in server.js) from Railway API routes.
 *
 * The QB proxy endpoints (GET /qb/lead-status, POST /qb/sync-lead, etc.)
 * are protected by X-Proxy-Secret. This module makes internal HTTP calls
 * to those endpoints using QB_PROXY_URL + QB_PROXY_SECRET.
 *
 * This does NOT create a new QB integration — it reuses the existing one.
 */
'use strict';

const QB_PROXY_URL = (process.env.QB_PROXY_URL || '').replace(/\/$/, '');
const QB_PROXY_SECRET = process.env.QB_PROXY_SECRET || process.env.PROXY_SECRET;

async function callQb(path, method = 'GET', body = null) {
  if (!QB_PROXY_URL) {
    const err = new Error('QB_PROXY_URL not configured');
    err.code = 'QB_PROXY_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }
  if (!QB_PROXY_SECRET) {
    const err = new Error('QB_PROXY_SECRET not configured');
    err.code = 'QB_PROXY_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const url = `${QB_PROXY_URL}${path}`;
  const options = {
    method,
    headers: {
      'X-Proxy-Secret': QB_PROXY_SECRET,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(`QB proxy ${path} failed ${res.status}: ${(data.error || text || '').substring(0, 200)}`);
    err.status = res.status;
    err.qbError = data;
    throw err;
  }
  return data;
}

/**
 * Get QB customer + invoice data for a lead.
 * @param {string} qbCustomerId - QB customer ID (optional)
 * @param {string} name - Lead name (optional)
 * @param {string} email - Lead email (optional)
 */
async function getLeadStatus(qbCustomerId, name, email) {
  return callQb('/qb/lead-status', 'POST', { qb_customer_id: qbCustomerId, name, email });
}

/**
 * Create or update a QB customer from lead data.
 * @param {Object} lead - { first_name, last_name, email, phone, property_address, city, qb_customer_id }
 */
async function syncLead(lead) {
  return callQb('/qb/sync-lead', 'POST', { lead });
}

/**
 * Fetch QB estimates for a lead.
 * @param {string} qbCustomerId - QB customer ID
 * @param {string} leadName - Lead name (fallback)
 */
async function syncLeadEstimates(qbCustomerId, leadName) {
  return callQb('/qb/sync-lead-estimates', 'POST', { qb_customer_id: qbCustomerId, lead_name: leadName });
}

/**
 * Fetch QB estimate PDF as base64.
 * @param {string} estimateId - QB estimate ID
 */
async function fetchEstimatePdf(estimateId) {
  return callQb('/qb/fetch-estimate-pdf', 'POST', { estimate_id: estimateId });
}

/**
 * Check QB auth status.
 */
async function getAuthStatus() {
  return callQb('/qb/auth-status', 'POST', {});
}

module.exports = { callQb, getLeadStatus, syncLead, syncLeadEstimates, fetchEstimatePdf, getAuthStatus };