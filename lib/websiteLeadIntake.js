/* eslint-disable no-undef */
/**
 * websiteLeadIntake — pure mapping/validation for leads forwarded by the public
 * website (ecconstructiongroup.com, Netlify) to POST /api/v1/website-leads.
 *
 * The website's contract (server/lib/leads.js in the website repo) is fixed:
 *   POST <CRM_WEBHOOK_URL>
 *   Content-Type: application/json
 *   x-webhook-secret: <WEBHOOK_SECRET>
 *   Idempotency-Key: ec-website-lead-<website lead id>   (absent only when the
 *                    website's own storage was down and it forwards directly)
 *   body: the normalized website lead (first_name, last_name, full_name, email,
 *         phone, city, zip, project_type, property_type, budget_range, timeline,
 *         message, photo_url, source, consent_sms, consent_sms_timestamp,
 *         consent_sms_disclosure_version, consent_email, id, created_date, ...)
 *
 * No I/O here — see routes/websiteLeads.js for persistence and side effects.
 */
'use strict';

const crypto = require('crypto');

const EXTERNAL_REF_PREFIX = 'ec-website-lead-';
const EXTERNAL_REF_RE = /^ec-website-lead-[A-Za-z0-9_-]{1,100}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

// Controlled end-to-end tests are marked on BOTH name and a reserved email
// domain (RFC 2606 example.com, which can never be a real customer). Such
// leads get no staff alert / Google Contacts sync and are the only leads the
// test-cleanup endpoint may delete.
const TEST_FIRST_NAME_RE = /^e2e[- ]?test\b/i;
const TEST_EMAIL_RE = /@example\.com$/i;

function clean(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

// Constant-time comparison of the shared secret (hash first so lengths match).
function secretMatches(provided, expected) {
  if (!expected || typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function isTestLead(lead) {
  return !!(lead && TEST_FIRST_NAME_RE.test(lead.first_name || '') && TEST_EMAIL_RE.test(lead.email || ''));
}

/**
 * The idempotency reference for a delivery: the website's Idempotency-Key
 * (stable across every retry of the same lead), else one derived from the
 * website lead id, else a content hash (the website's storage-down path sends
 * neither — the hash still collapses exact repeats).
 */
function externalRefFor(idempotencyKey, body) {
  if (typeof idempotencyKey === 'string' && EXTERNAL_REF_RE.test(idempotencyKey)) return idempotencyKey;
  const id = body && typeof body.id === 'string' ? body.id : null;
  if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) return EXTERNAL_REF_PREFIX + id;
  const basis = JSON.stringify([
    body && body.full_name, body && body.first_name, body && body.last_name,
    body && body.email, body && body.phone, body && body.message, body && body.created_date,
  ]);
  return `${EXTERNAL_REF_PREFIX}h-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  return { first: parts[0], last: parts.slice(1).join(' ') || null };
}

function validIso(v, now) {
  const t = Date.parse(v || '');
  if (!Number.isFinite(t)) return null;
  // Never a future time (clock skew tolerance 5 min) and not absurdly old.
  if (t > now + 5 * 60e3 || t < Date.UTC(2020, 0, 1)) return null;
  return new Date(t).toISOString();
}

/**
 * Map a website lead to the CRM lead fields. Returns
 *   { ok: true, lead } | { ok: false, errors: [...] }
 */
function mapWebsiteLead(body, { now = Date.now() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors = [];

  let first = clean(body.first_name, 100);
  let last = clean(body.last_name, 100);
  if (!first && !last) {
    const s = splitName(clean(body.full_name, 200));
    first = s.first; last = s.last;
  }

  let email = clean(body.email, 254);
  if (email) {
    email = email.toLowerCase();
    if (!EMAIL_RE.test(email)) email = null; // website validates; never store garbage
  }
  let phone = clean(body.phone, 40);
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) phone = null;
  }

  if (!first && !last && !email && !phone) errors.push('a name, phone number or email is required');

  const consent = body.consent_sms === true;
  const consentAt = consent ? (validIso(body.consent_sms_timestamp, now) || new Date(now).toISOString()) : null;
  const consentVersion = consent ? (clean(body.consent_sms_disclosure_version, 60) || 'unknown') : null;

  const photo = clean(body.photo_url, 2000);
  const photoUrls = photo && /^https:\/\//i.test(photo) ? [photo] : [];

  const websiteId = clean(body.id, 100);
  const propertyType = clean(body.property_type, 120);
  const zip = clean(body.zip, 10);
  const originalSource = clean(body.source, 120);
  const noteLines = [
    'Submitted through the ecconstructiongroup.com website form.',
    websiteId ? `Website lead ID: ${websiteId}` : null,
    originalSource && originalSource !== 'Website' ? `Website source: ${originalSource}` : null,
    propertyType ? `Property type: ${propertyType}` : null,
    `SMS consent: ${consent ? `yes (${consentVersion}, ${consentAt})` : 'no'}`,
    typeof body.consent_email === 'boolean' ? `Email consent: ${body.consent_email ? 'yes' : 'no'}` : null,
  ].filter(Boolean);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    lead: {
      // leads.first_name / last_name are NOT NULL.
      first_name: first || '(no name)',
      last_name: last || '',
      email,
      phone,
      city: clean(body.city, 120),
      zip: zip && /^\d{5}(-\d{4})?$/.test(zip) ? zip : null,
      project_type: clean(body.project_type, 120),
      budget_range: clean(body.budget_range, 60),
      start_timeframe: clean(body.timeline, 60),
      // Every website form sends 'Website'; the CRM's Website filter keys on it.
      source: 'Website',
      message: clean(body.message, 5000),
      notes: noteLines.join('\n'),
      photo_urls: photoUrls,
      sms_consent: consent,
      sms_consent_at: consentAt,
      sms_consent_disclosure_version: consentVersion,
      sms_consent_source: consent ? 'website' : null,
      submitted_at: validIso(body.created_date, now),
      website_lead_id: websiteId,
    },
  };
}

module.exports = {
  EXTERNAL_REF_PREFIX, EXTERNAL_REF_RE,
  secretMatches, isTestLead, externalRefFor, mapWebsiteLead,
};
