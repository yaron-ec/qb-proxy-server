/* eslint-disable no-undef */
'use strict';

/**
 * qbRouteAuth — admin/manager-restricted variant of server.js's
 * requireProxySecret, for the legacy QuickBooks proxy routes with real
 * financial or credential consequences: OAuth connect/callback/disconnect,
 * and the invoice/estimate/customer create+void passthrough routes.
 *
 * October 2026 QuickBooks reliability audit finding: requireProxySecret
 * accepts EITHER the server-to-server X-Proxy-Secret header OR any valid
 * Railway JWT Bearer token — with NO role check on the JWT path. Every
 * legitimate caller on the X-Proxy-Secret path (lib/qbInternal.js, used by
 * routes/leadQB.js and routes/dealQbSync.js) is already gated one layer up
 * with requireRole('admin','manager') — but a browser could skip that
 * upstream gate entirely and call these routes directly with ANY
 * authenticated user's JWT (sales_rep, office, anyone), since this
 * middleware never checked req.user.role. This closes that gap:
 *   - The X-Proxy-Secret path is UNCHANGED — still allowed unconditionally,
 *     since it is a trusted server-to-server caller whose role was already
 *     enforced upstream. Restricting it here too would double-gate (and
 *     could break) the legitimate internal calls above.
 *   - The JWT path now additionally requires req.user.role to be one of
 *     the roles this route explicitly allows.
 *
 * A separate small module (not inlined in server.js) so it can be
 * `require()`d with a correct relative path from both server.js and any
 * test file, and unit-tested without eval-extracting a fragment of
 * server.js's source text.
 */
function requireProxySecretOrRole(...roles) {
  return function (req, res, next) {
    const secret = req.headers['x-proxy-secret'];
    if (process.env.PROXY_SECRET && secret === process.env.PROXY_SECRET) {
      return next();
    }

    const header = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) {
      return res.status(401).json({ error: 'Unauthorized — authentication required' });
    }
    try {
      req.user = require('./authService').verifyAccessToken(m[1].trim());
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized — authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden: insufficient role' });
    }
    return next();
  };
}

module.exports = { requireProxySecretOrRole };
