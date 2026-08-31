/* eslint-disable no-undef */
/**
 * googleCalendarClient — Railway-owned Google Calendar access via service
 * account (GOOGLE_SERVICE_ACCOUNT_KEY). No Base44 connector, no browser tokens.
 *
 * Auth: RS256 JWT signed with the service-account private key, exchanged for
 * an OAuth access token (scope calendar). Token is cached until near-expiry.
 *
 * Operations are idempotent against the create-success/local-write-failure
 * crash window (Phase 2 req 2):
 *   - createOrUpdateEvent: POST with a CLIENT-SUPPLIED deterministic event id.
 *     409 means the event already exists (created by a prior crashed attempt)
 *     → GET to adopt its id; if cancelled, PUT to restore. Secondary reconcile
 *     via extendedProperties.private.ec_appointment_id if the GET fails.
 *   - updateEvent: PUT; 404 → fall back to createOrUpdateEvent (re-create).
 *   - cancelEvent: DELETE; 404/410 treated as success (already gone).
 *
 * Calendar target: the calendar id passed by the caller (default 'primary' of
 * the service account). Calendar OWNERSHIP policy lives in calendarOutbox.js
 * enqueue (CALENDAR_ID), not here.
 */
'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

// Token cache keyed by impersonation subject (subEmail).
// Key '_self' = service account's own identity (no impersonation).
// This mirrors the proven DWD pattern in googleContactsClient.js.
let _tokenCache = new Map();

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// getAccessToken(subEmail) — obtains a Calendar access token, optionally
// impersonating a Workspace user via Domain-Wide Delegation (DWD).
//
// When subEmail is provided, the JWT includes `sub: subEmail`, so Google
// sees the Calendar operations as performed BY that user. This is REQUIRED
// for creating events with attendees + sendUpdates=all — service accounts
// cannot invite attendees without DWD impersonation (403 forbiddenForServiceAccounts).
//
// When subEmail is null/undefined, the service account acts as itself (used
// for availability reads via ACL sharing, which do not require DWD).
//
// DWD pattern reused from lib/googleContactsClient.js (working contacts sync).
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
  const claim = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp };
  // Domain-Wide Delegation: impersonate a specific Workspace user.
  // This allows the service account to send event invitations (attendees +
  // sendUpdates=all) as that user, which is required for create_main events.
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
    throw new Error(`Google token exchange failed ${res.status}: ${t.substring(0, 300)}`);
  }
  const data = await res.json();
  const token = data.access_token;
  _tokenCache.set(cacheKey, { token, exp: now + (data.expires_in || 3600) * 1000 });
  return token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function isQuota(status, text) {
  return status === 429 || /quotaExceeded|rateLimitExceeded/i.test(text || '');
}

async function listByExt(token, calendarId, key, value) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    + `?extendedProperty=${encodeURIComponent(`private:${key}=${value}`)}&maxResults=10&singleEvents=true`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).filter(i => i.status !== 'cancelled');
}

// POST with client-supplied id; 409 → reconcile (adopt existing / restore).
async function createOrUpdateEvent(token, calendarId, eventBody, sendUpdates) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const url = sendUpdates ? `${base}?sendUpdates=all` : base;
  const res = await fetch(url, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(eventBody) });
  if (res.status === 200 || res.status === 201) {
    const ev = await res.json();
    return { id: ev.id, alreadyExisted: false };
  }
  if (res.status === 409) {
    // An event with this deterministic id already exists. Adopt it — do NOT
    // PUT-restore a cancelled event. A cancelled event here means a cancel
    // outbox row already ran (or it was cancelled externally); recreating it
    // would resurrect a historical event the system intended to delete.
    const id = eventBody.id;
    const getRes = await fetch(`${base}/${encodeURIComponent(id)}`, { headers: authHeaders(token) });
    if (getRes.ok) {
      const ev = await getRes.json();
      return { id: ev.id || id, alreadyExisted: true };
    }
    // Secondary reconciliation via extendedProperties. Correlate on the FULL
    // identity (appointment_id + kind + slot + version) so a stale historical
    // event from an earlier version/slot can never be adopted ambiguously.
    const ext = (eventBody.extendedProperties && eventBody.extendedProperties.private) || {};
    if (ext.ec_appointment_id) {
      const listed = await listByExt(token, calendarId, 'ec_appointment_id', ext.ec_appointment_id);
      const match = (i) => {
        const p = (i.extendedProperties && i.extendedProperties.private) || {};
        return p.ec_kind === ext.ec_kind && p.ec_slot === ext.ec_slot && String(p.ec_version) === String(ext.ec_version);
      };
      const exact = listed.filter(match);
      if (exact.length) return { id: exact[0].id, alreadyExisted: true };
      const kindSlot = listed.filter(i => {
        const p = (i.extendedProperties && i.extendedProperties.private) || {};
        return p.ec_kind === ext.ec_kind && p.ec_slot === ext.ec_slot;
      });
      if (kindSlot.length) return { id: kindSlot[0].id, alreadyExisted: true };
    }
    return { id, alreadyExisted: true };
  }
  const errText = await res.text().catch(() => '');
  if (isQuota(res.status, errText)) { const e = new Error('quota_exceeded'); e.isQuota = true; throw e; }
  throw new Error(`Calendar insert ${res.status}: ${errText.substring(0, 300)}`);
}

// PUT; 404 → re-create with the deterministic id.
async function updateEvent(token, calendarId, eventId, eventBody) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const res = await fetch(`${base}/${encodeURIComponent(eventId)}`, {
    method: 'PUT', headers: authHeaders(token), body: JSON.stringify(eventBody),
  });
  if (res.status === 200 || res.status === 201) {
    const ev = await res.json();
    return { id: ev.id };
  }
  if (res.status === 404 || res.status === 410) {
    return createOrUpdateEvent(token, calendarId, eventBody, false);
  }
  const errText = await res.text().catch(() => '');
  if (isQuota(res.status, errText)) { const e = new Error('quota_exceeded'); e.isQuota = true; throw e; }
  throw new Error(`Calendar update ${res.status}: ${errText.substring(0, 300)}`);
}

// DELETE; 404/410 = already gone (safe retry).
async function cancelEvent(token, calendarId, eventId) {
  if (!eventId) return { ok: true, alreadyGone: true };
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const res = await fetch(`${base}/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers: authHeaders(token) });
  if (res.status === 200 || res.status === 204) return { ok: true };
  if (res.status === 404 || res.status === 410) return { ok: true, alreadyGone: true };
  const errText = await res.text().catch(() => '');
  if (isQuota(res.status, errText)) { const e = new Error('quota_exceeded'); e.isQuota = true; throw e; }
  throw new Error(`Calendar cancel ${res.status}: ${errText.substring(0, 300)}`);
}

// List events in [timeMin, timeMax) (RFC3339 UTC). Returns active (non-cancelled)
// events. Used by the public capture availability path to read the owner's real
// Google Calendar (service-account JWT — no Base44, no browser tokens).
async function listEvents(calendarId, timeMin, timeMax) {
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    + `?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
    + `&singleEvents=true&orderBy=startTime&maxResults=250`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (isQuota(res.status, t)) { const e = new Error('quota_exceeded'); e.isQuota = true; throw e; }
    throw new Error(`Calendar list ${res.status}: ${t.substring(0, 300)}`);
  }
  const data = await res.json();
  return (data.items || []).filter(i => i.status !== 'cancelled');
}

module.exports = { getAccessToken, createOrUpdateEvent, updateEvent, cancelEvent, listByExt, listEvents };