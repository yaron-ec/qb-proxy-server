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

// Platform administrator — the authorized operator of the Company
// Management page (PRODUCTIZATION — multi-company onboarding workflow).
// Deliberately NOT a new `role` value (that would be a per-installation
// concept bleeding into a cross-company one) and NOT a hardcoded
// company-specific email literal (Development rules: never hardcode a new
// company-specific literal outside a designated configuration point) —
// instead, reuses THIS installation's own, already-existing
// company_settings.protected_admin_emails list (routes/users.js already
// treats it as "this installation's protected admins"; on EC's production
// database it is backfilled to yaron@/michelle@ecconstructiongroup.com,
// preserving their existing administrator access with zero new config).
// A fresh company's own installation has protected_admin_emails = [] (see
// scripts/install/bootstrap.js#ensureCompanySettings), so nobody there ever
// qualifies — the entire platform_companies control plane (routes/
// platformCompanies.js) stays unreachable and inert for every customer
// company, exactly as required.
function requirePlatformAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden: platform admin only' });
  require('./notificationRecipients').getProtectedAdminEmails()
    .then((protectedEmails) => {
      if (!protectedEmails.has(String(req.user.email || '').toLowerCase())) {
        return res.status(403).json({ error: 'forbidden: platform admin only' });
      }
      next();
    })
    .catch((e) => res.status(500).json({ error: e.message }));
}

module.exports = { requireAuth, requireRole, requireStaff, requireAdmin, requirePlatformAdmin };