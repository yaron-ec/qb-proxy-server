/* eslint-disable no-undef */
/**
 * base44TokenVerify — [TEMPORARY Stage A] authoritative verification of a
 * Base44 access token for the one-shot migration bridge.
 *
 * The browser supplies ONLY the raw Base44 access token. Email and role are
 * NEVER taken from the browser; they are derived from Base44's own verified
 * `/auth/me` response. A forged/expired/missing token is rejected by Base44
 * (HTTP 401) and never produces a Railway identity.
 *
 * Security invariants (tested in test/authExchange.test.js):
 *   - missing token            -> VerifyError('missing_token')
 *   - Base44 bridge unconfigured-> VerifyError('bridge_unavailable')
 *   - Base44 returns 401        -> VerifyError('invalid_token')   (forged/expired)
 *   - Base44 unreachable (5xx/network) -> VerifyError('base44_unavailable')
 *   - verified user with no email -> VerifyError('no_email')
 *   - role not in allowlist     -> role = null (caller assigns 'user' for new rows)
 *
 * This module is REMOVED in Stage B (independent Railway auth). See
 * docs/EMAIL_MIGRATION_OWNERSHIP.md.
 */
'use strict';

const BASE44_API_URL = process.env.BASE44_API_URL || 'https://api.base44.com';
const ALLOWED_ROLES = ['admin', 'manager', 'sales_rep', 'office'];

class VerifyError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'VerifyError'; }
}

/**
 * Verify a Base44 access token by calling Base44 /auth/me. Returns the trusted
 * identity { email, role, full_name } or throws VerifyError.
 * Never accepts email/role from the caller.
 */
async function verifyBase44Token(token) {
  if (!token) throw new VerifyError('missing_token');
  // Read configuration at CALL time (not module load) so a test that mutates
  // BASE44_APP_ID is honored. Both app id and api key are required; a missing
  // either is a bridge-unavailable failure (no privileged fallback).
  const appId = process.env.BASE44_APP_ID;
  const apiKey = process.env.BASE44_API_KEY;
  if (!appId || !apiKey) throw new VerifyError('bridge_unavailable');

  let meRes;
  try {
    meRes = await fetch(`${BASE44_API_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}`, 'X-App-ID': appId },
    });
  } catch (e) {
    // Network failure reaching Base44 -> safe authentication failure (no fallback).
    throw new VerifyError('base44_unavailable');
  }

  if (meRes.status === 401 || meRes.status === 403) throw new VerifyError('invalid_token');
  if (!meRes.ok) throw new VerifyError('base44_unavailable');

  const u = await meRes.json().catch(() => ({}));
  if (!u || !u.email) throw new VerifyError('no_email');
  const role = ALLOWED_ROLES.includes(u.role) ? u.role : null;
  return { email: String(u.email).trim().toLowerCase(), role, full_name: u.full_name || u.name || null };
}

module.exports = { verifyBase44Token, VerifyError, ALLOWED_ROLES };