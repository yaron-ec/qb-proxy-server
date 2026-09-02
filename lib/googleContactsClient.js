/* eslint-disable no-undef */
/**
 * googleContactsClient — Railway-owned Google Contacts access via service
 * account (GOOGLE_SERVICE_ACCOUNT_KEY) with domain-wide delegation.
 *
 * Reuses the SAME service account as googleCalendarClient, but requests the
 * contacts scope and impersonates a specific user (sub) via domain-wide
 * delegation. This does NOT create a new auth architecture — it extends the
 * existing service account with a different scope + subject.
 *
 * Required: Google Workspace Admin must add the contacts scope to the
 * service account's domain-wide delegation. If not configured, the token
 * exchange will fail with a clear error.
 *
 * Operations:
 *   createOrUpdateContact(lead, ownerEmail) — create or update a contact
 *     in the impersonated user's Google Contacts. Idempotent by email/phone.
 *   getContact(resourceName) — fetch a contact by resource name.
 *   deleteContact(resourceName) — delete a contact.
 */
'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/contacts';
const PEOPLE_BASE = 'https://people.googleapis.com/v1';

let _tokenCache = new Map(); // key: subEmail → { token, exp }

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * Get an access token for the contacts scope, impersonating `subEmail`.
 * If subEmail is null, uses the service account's own identity (less useful
 * for domain contacts, but works for service-account-owned contacts).
 */
async function getAccessToken(subEmail) {
  const cacheKey = subEmail || '_self';
  const now = Date.now();
  const cached = _tokenCache.get(cacheKey);
  if (cached && cached.exp > now + 5000) return cached.token;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON'); }
  if (!sa.client_email || !sa.private_key) throw new Error('service account JSON missing client_email/private_key');

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp,
  };
  // Domain-wide delegation: impersonate a specific user
  if (subEmail) claim.sub = subEmail;

  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${b64url(header)}.${b64url(claim)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(sa.private_key, 'base64url');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // If domain-wide delegation is not configured, Google returns 403 with
    // "unauthorized_client: Client is unauthorized to retrieve token-type
    // access token using this method" or "access_denied".
    if (res.status === 403 || /unauthorized_client|access_denied/i.test(t)) {
      const err = new Error('contacts_scope_not_configured');
      err.code = 'CONTACTS_SCOPE_NOT_CONFIGURED';
      err.status = 501;
      throw err;
    }
    throw new Error(`Google contacts token exchange failed ${res.status}: ${t.substring(0, 300)}`);
  }
  const data = await res.json();
  _tokenCache.set(cacheKey, { token: data.access_token, exp: now + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Search for an existing contact by email or phone in the impersonated user's
 * account. Returns the resource name if found, null otherwise.
 */
async function findContact(token, email, phone) {
  const mask = 'names,emailAddresses,phoneNumbers';
  let query = '';
  if (email) query = email;
  else if (phone) query = phone.replace(/\D/g, '');
  if (!query) return null;

  const url = `${PEOPLE_BASE}/people:searchContacts?query=${encodeURIComponent(query)}&readMask=${mask}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) return null;
  const data = await res.json();
  const results = data.results || [];
  for (const r of results) {
    const person = r.person || {};
    if (email) {
      const emails = person.emailAddresses || [];
      for (const e of emails) {
        if (e.value && e.value.toLowerCase() === email.toLowerCase()) return person;
      }
    }
    if (phone) {
      const normalized = phone.replace(/\D/g, '');
      const phones = person.phoneNumbers || [];
      for (const p of phones) {
        if (p.value && p.value.replace(/\D/g, '').includes(normalized)) return person;
      }
    }
  }
  return null;
}

/**
 * Create or update a contact for a lead in the impersonated user's Google
 * Contacts. Idempotent: searches by email/phone first, updates if found,
 * creates if not.
 *
 * @param {Object} lead - { first_name, last_name, email, phone, property_address, city }
 * @param {string} subEmail - The Google Workspace user to impersonate (the rep)
 * @returns { resourceName, created } on success
 */
async function createOrUpdateContact(lead, subEmail, existingResourceName) {
  const token = await getAccessToken(subEmail);

  // Use stored resource_name when available — direct getContact avoids
  // searchContacts quota (the 429 'Critical read requests' root cause).
  // Only fall back to searchContacts when no resource_name is stored.
  let existing = null;
  if (existingResourceName) {
    existing = await getContact(token, existingResourceName);
  } else {
    existing = await findContact(token, lead.email, lead.phone);
  }

  const contactPayload = {
    names: [{
      givenName: lead.first_name || '',
      familyName: lead.last_name || '',
    }],
  };
  if (lead.email) {
    contactPayload.emailAddresses = [{ value: lead.email, type: 'work' }];
  }
  if (lead.phone) {
    contactPayload.phoneNumbers = [{ value: lead.phone, type: 'mobile' }];
  }
  if (lead.property_address || lead.city) {
    contactPayload.addresses = [{
      formattedValue: [lead.property_address, lead.city].filter(Boolean).join(', '),
      type: 'home',
    }];
  }

  if (existing && existing.resourceName) {
    // Update existing contact
    const updatePayload = {
      ...contactPayload,
      etag: existing.etag,
    };
    // Google People API updateContact requires "updatePersonFields" (not "updateFields")
    // as the query parameter name. Sending "updateFields" produces:
    //   400 Invalid JSON payload received. Unknown name "updateFields": Cannot bind query parameter.
    const updatePersonFields = ['names', 'emailAddresses', 'phoneNumbers', 'addresses'].join(',');
    const res = await fetch(
      `${PEOPLE_BASE}/${existing.resourceName}:updateContact?updatePersonFields=${updatePersonFields}`,
      { method: 'PATCH', headers: authHeaders(token), body: JSON.stringify(updatePayload) }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Google contact update failed ${res.status}: ${t.substring(0, 200)}`);
    }
    const updated = await res.json();
    return { resourceName: updated.resourceName, created: false };
  }

  // Create new contact
  const res = await fetch(`${PEOPLE_BASE}/people:createContact`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(contactPayload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Google contact create failed ${res.status}: ${t.substring(0, 200)}`);
  }
  const created = await res.json();
  return { resourceName: created.resourceName, created: true };
}

async function getContact(token, resourceName) {
  const mask = 'names,emailAddresses,phoneNumbers';
  const res = await fetch(`${PEOPLE_BASE}/${resourceName}?personFields=${mask}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return null;
  return res.json();
}

module.exports = { getAccessToken, createOrUpdateContact, findContact, getContact };