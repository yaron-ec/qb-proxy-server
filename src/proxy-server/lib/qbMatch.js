/* eslint-disable no-undef */
/**
 * QB Estimate -> CRM Lead matching engine.
 *
 * Ported VERBATIM from base44/functions/syncEstimatesFromQBDirect/entry.ts
 * (the pure-JS normalization + matching helpers). No Base44 SDK dependency —
 * operates on plain objects, so it runs identically inside the Railway proxy.
 *
 * DO NOT change the matching behavior — the Base44 scheduled function and the
 * Railway sync must produce identical matches during the verification window.
 */
'use strict';

// Railway runtime recovery deployment trigger

const normalize = (str) => (str || '').toLowerCase().trim();

const normalizeEmail = (email) => {
  if (!email) return '';
  return email.toLowerCase().trim();
};

const normalizePhone = (phone) => {
  if (!phone) return '';
  // Remove all non-digits and country code
  const digits = phone.replace(/\D/g, '');
  // Remove leading 1 (US country code)
  return digits.replace(/^1(\d{10})$/, '$1').slice(-10);
};

const normalizeString = (str) => {
  if (!str) return '';
  return str.toLowerCase().trim().replace(/[\s\-()]/g, '');
};

const levenshtein = (a, b) => {
  const an = normalizeString(a);
  const bn = normalizeString(b);
  if (an === bn) return 0;
  const matrix = Array(bn.length + 1).fill(null).map(() => Array(an.length + 1).fill(0));
  for (let i = 0; i <= an.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= bn.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= bn.length; j++) {
    for (let i = 1; i <= an.length; i++) {
      matrix[j][i] = an[i - 1] === bn[j - 1]
        ? matrix[j - 1][i - 1]
        : 1 + Math.min(matrix[j - 1][i], matrix[j][i - 1], matrix[j - 1][i - 1]);
    }
  }
  return matrix[bn.length][an.length];
};

// Extract the actual customer name from QB DisplayName/CustomerRef.name
// EC Construction format: "HNDF-PRJ-10198 Description - Customer Name"
// Also handles: "Customer Name:ProjectRef"
function extractCustomerName(raw) {
  if (!raw) return '';
  // Format: "Name:ProjectRef"
  const colonIdx = raw.indexOf(':');
  if (colonIdx !== -1) return raw.slice(0, colonIdx).trim();
  // Format: "HNDF-PRJ-XXXXX Description - Customer Name"
  const dashIdx = raw.lastIndexOf(' - ');
  if (dashIdx !== -1) {
    const afterDash = raw.slice(dashIdx + 3).trim();
    if (afterDash && !/\d{3,}|\/|\\/.test(afterDash)) return afterDash;
  }
  return raw.trim();
}

// Returns true if QB customer name shares at least first OR last name with the CRM lead
function partialNameMatch(qbName, leadFirst, leadLast) {
  const qbNorm = normalize(extractCustomerName(qbName));
  const first = normalize(leadFirst || '');
  const last = normalize(leadLast || '');
  const qbParts = qbNorm.split(/\s+/).filter(Boolean);
  if (first && first.length >= 2 && qbParts.includes(first)) return true;
  if (last && last.length >= 2 && qbParts.includes(last)) return true;
  return false;
}

function findMatchingLead(qbCustomer, leads) {
  const customerEmail = normalizeEmail(qbCustomer.PrimaryEmailAddr?.Address || qbCustomer.email || '');
  const customerPhone = normalizePhone(qbCustomer.PrimaryPhone?.FreeFormNumber || qbCustomer.phone || '');
  const rawName = qbCustomer.DisplayName || qbCustomer.name || '';
  const customerName = normalize(extractCustomerName(rawName));
  const customerAddress = normalize(qbCustomer.BillAddr?.Line1 || qbCustomer.property_address || '');
  const customerAddressNorm = normalizeString(customerAddress);

  // Priority 0: exact persisted qb_customer_id match (AUTHORITATIVE)
  // The canonical mapping lives on leads.qb_customer_id. If the QB customer's
  // Id matches a lead's persisted qb_customer_id, that lead is the
  // authoritative match — fuzzy matching is NOT consulted.
  //
  // CARDINALITY: 1:1 (one Lead → one QB Customer). If multiple leads share
  // the same qb_customer_id, the mapping is AMBIGUOUS. We FAIL CLOSED —
  // return null immediately, do NOT fall through to fuzzy matching.
  // The caller must resolve the duplicate (merge or clear) before the
  // QB customer can be matched. This prevents silently choosing the first
  // of two authoritative matches.
  const qbCustomerId = String(qbCustomer.Id || qbCustomer.id || qbCustomer.value || '').trim();
  if (qbCustomerId) {
    const exactMatches = leads.filter(l => {
      const leadQbId = l.qb_customer_id;
      return leadQbId && String(leadQbId).trim() === qbCustomerId;
    });
    if (exactMatches.length === 1) return exactMatches[0];
    if (exactMatches.length > 1) return null; // FAIL CLOSED — ambiguous, do NOT fall through to fuzzy
  }

  // Priority 1: phone + partial name (first OR last)
  if (customerPhone) {
    const hits = leads.filter(l => normalizePhone(l.phone || '') === customerPhone && partialNameMatch(rawName, l.first_name, l.last_name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return hits[0]; // multiple — take first, phone+name is high confidence
  }

  // Priority 2: email + partial name (first OR last)
  if (customerEmail) {
    const hits = leads.filter(l => normalizeEmail(l.email || '') === customerEmail && partialNameMatch(rawName, l.first_name, l.last_name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return hits[0];
  }

  // Priority 3: phone alone (exact) — only if unique
  if (customerPhone) {
    const hits = leads.filter(l => normalizePhone(l.phone || '') === customerPhone);
    if (hits.length === 1) return hits[0];
  }

  // Priority 4: email alone (exact) — only if unique
  if (customerEmail) {
    const hits = leads.filter(l => normalizeEmail(l.email || '') === customerEmail);
    if (hits.length === 1) return hits[0];
  }

  // Priority 5: address + partial name
  if (customerAddressNorm && customerAddressNorm.length >= 10) {
    const hits = leads.filter(l => {
      const la = normalizeString(normalize(l.property_address || ''));
      return la.length >= 10 && la.slice(0, 30) === customerAddressNorm.slice(0, 30) && partialNameMatch(rawName, l.first_name, l.last_name);
    });
    if (hits.length === 1) return hits[0];
  }

  // Priority 6: exact full name (fallback)
  const customerNameNorm = normalizeString(customerName);
  if (customerNameNorm) {
    const hits = leads.filter(l => {
      const ln = normalizeString(normalize(`${l.first_name} ${l.last_name}`));
      return ln === customerNameNorm;
    });
    if (hits.length === 1) return hits[0];
  }

  return null;
}

module.exports = {
  normalize,
  normalizeEmail,
  normalizePhone,
  normalizeString,
  levenshtein,
  extractCustomerName,
  partialNameMatch,
  findMatchingLead,
};