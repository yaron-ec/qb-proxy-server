/* eslint-disable no-undef */
/**
 * safeReturnTo — validates a post-login "return to" destination so a user
 * who follows a CRM email link (New Lead, incoming SMS, etc.) while logged
 * out lands back on that same lead after signing in, instead of always on
 * the default dashboard.
 *
 * Deliberately restrictive: a "return to" value is NEVER trusted as an
 * absolute URL (that would be an open-redirect vector — an attacker-crafted
 * login link could otherwise send a freshly-authenticated session, tokens
 * included, to an external host). Only a same-origin, app-internal PATH is
 * ever accepted.
 */
'use strict';

function sanitizeReturnTo(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > 2048) return null; // defense in depth against abuse
  // Must start with exactly one "/" — "//host/..." and "/\host/..." are
  // both browser-recognized protocol-relative forms (an open-redirect
  // vector), and a bare "http://..."/"javascript:..." is an absolute URL
  // or scheme, never a same-origin path.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return value;
}

module.exports = { sanitizeReturnTo };
