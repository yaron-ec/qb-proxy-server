/* eslint-disable no-undef */
/**
 * captureOverrideAuth — server-side authorization for the admin conflict-
 * override on the PUBLIC lead capture endpoint.
 *
 * The public capture route (routes/publicCapture.js) is intentionally
 * unauthenticated for normal submissions. When a submission carries
 * appointment_override=true, this module is the AUTHORITATIVE gate:
 *   1. require a Bearer Railway JWT
 *   2. verify the token (authService.verifyAccessToken)
 *   3. require role === 'admin'
 *   4. require the email is in the explicit server-side allowlist
 *      (yaron / michelle @ecconstructiongroup.com)
 *
 * The frontend toggle is NEVER trusted. A missing/invalid token, a non-admin
 * role, or a non-allowlisted email all return { ok:false, code:'override_forbidden' }
 * and the route responds 403.
 *
 * `_verify` is an internal/test-only seam: production calls authorizeOverride
 * with a single arg; tests pass a fake verifier to avoid needing RAILWAY_JWT_SECRET.
 */
'use strict';

// Import the JWT verifier directly from crypto (the same function
// authService.verifyAccessToken delegates to). This keeps the module pure /
// loadable without a DB connection (authService pulls db/client -> pg), while
// using the identical verification path as the rest of the app.
const { verifyJWT } = require('./crypto');

// PRODUCTIZATION PHASE 2: ADMIN_OVERRIDE_EMAILS env var, comma-separated,
// takes priority when set — this module is deliberately DB-free/synchronous
// (see header comment), so it cannot read company_settings the way most
// other productized values do; an env var is the only config surface
// available to it. Unset (EC's current real state) preserves the exact
// historical two-email allowlist, so this is a no-op change for EC by
// default. A new installation should set ADMIN_OVERRIDE_EMAILS to its own
// admin(s) — see docs/CONFIGURATION_REFERENCE.md.
const ADMIN_OVERRIDE_EMAILS = process.env.ADMIN_OVERRIDE_EMAILS
  ? new Set(process.env.ADMIN_OVERRIDE_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
  : new Set([
      'yaron@ecconstructiongroup.com',
      'michelle@ecconstructiongroup.com',
    ]);

function isOverrideAdminEmail(email) {
  return !!email && ADMIN_OVERRIDE_EMAILS.has(String(email).trim().toLowerCase());
}

function authorizeOverride(authHeader, _verify) {
  const verify = typeof _verify === 'function' ? _verify : verifyJWT;
  if (!authHeader) {
    return { ok: false, code: 'override_forbidden', message: 'Authorization required to override a conflict.' };
  }
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader));
  if (!m) {
    return { ok: false, code: 'override_forbidden', message: 'Valid Bearer token required to override a conflict.' };
  }
  let payload;
  try {
    payload = verify(m[1].trim());
  } catch (e) {
    return { ok: false, code: 'override_forbidden', message: 'Invalid or expired token.' };
  }
  if (!payload || String(payload.role || '').toLowerCase() !== 'admin') {
    return { ok: false, code: 'override_forbidden', message: 'Only admins may override a conflict.' };
  }
  if (!isOverrideAdminEmail(payload.email)) {
    return { ok: false, code: 'override_forbidden', message: 'This account is not authorized to override conflicts.' };
  }
  return {
    ok: true,
    user: { id: payload.sub, email: payload.email, role: payload.role, full_name: payload.full_name },
  };
}

module.exports = { authorizeOverride, isOverrideAdminEmail, ADMIN_OVERRIDE_EMAILS };