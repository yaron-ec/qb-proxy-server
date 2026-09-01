/* eslint-disable no-undef */
/**
 * RBAC middleware — Railway-owned authorization (PERMANENT).
 *
 * requireAuth:  validates the Railway JWT access token (Bearer scheme),
 *               attaches { sub, email, role, full_name } to req.user.
 * requireRole:  restricts a route to one or more roles.
 *
 * No Base44 tokens, no PROXY_SECRET, no server secrets reach the browser.
 */
'use strict';

const { verifyAccessToken } = require('./authService');

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return res.status(401).json({ error: 'missing bearer token' });
  try {
    req.user = verifyAccessToken(m[1].trim());
    next();
  } catch (e) {
    const expired = /expir/i.test(e.message);
    return res.status(401).json({ error: e.message, code: expired ? 'token_expired' : 'token_invalid' });
  }
}

function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden: insufficient role' });
    next();
  };
}

// Convenience: admin/manager may act on behalf; sales_rep/office are scoped in-route.
const requireStaff = requireRole('admin', 'manager', 'sales_rep', 'office');
const requireAdmin = requireRole('admin');

module.exports = { requireAuth, requireRole, requireStaff, requireAdmin };