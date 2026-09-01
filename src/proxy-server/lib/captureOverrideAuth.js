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

const ADMIN_OVERRIDE_EMAILS = new Set([
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