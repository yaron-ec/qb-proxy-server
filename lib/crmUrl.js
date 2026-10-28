/* eslint-disable no-undef */
/**
 * crmUrl — the ONE validated source of the CRM's absolute base URL, used by
 * every outbound notification email (and any other place) that links back
 * into the CRM: New Lead, lead/CRM-activity updates, appointment/follow-up/
 * task reminders, incoming-SMS reply notifications, manual reminders,
 * invites, and the CSP img-src origin.
 *
 * Production incident (November 2026, lead 774d31bd-1134-4319-8298-5810dbe196a5):
 * a New Lead notification email's "Open Lead in CRM" button opened
 * `http:///leads/774d31bd-...` on mobile — scheme present, host EMPTY.
 * Root cause: `lib/captureAlerts.js#sendNewLeadAlert` built its lead link as
 * `` `${crmPublicUrl || ''}/leads/${lead.id}` `` with NO fallback of its own,
 * and its three real callers (routes/websiteLeads.js, routes/publicCapture.js,
 * routes/metaWebhook.js x2) all passed `process.env.CRM_PUBLIC_URL || ''` —
 * when CRM_PUBLIC_URL was unset in production, the email shipped a bare
 * RELATIVE path (`/leads/<id>`, no scheme, no host) baked into its HTML.
 * There is no "current page" inside an email to resolve a relative href
 * against, so Gmail's own link-safety/redirect wrapper rendered exactly the
 * reported symptom (an empty-host absolute URL) and Google's interstitial
 * correctly flagged it "invalid url". `routes/sms.js`'s inbound-SMS-reply
 * notification path (`lib/smsReplyNotify.js#notifyAssignedRep`) had the
 * identical missing-fallback pattern, degrading more gracefully (it omitted
 * the link entirely rather than emitting a broken one) but still shipping a
 * notification with no way to open the lead at all.
 *
 * Every OTHER CRM-link call site in this codebase had already independently
 * reinvented the same `process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com'`
 * fallback — duplicated across `lib/dataAccessRailway.js`,
 * `lib/emailTemplates.js`, `lib/reminderEmails.js`, `lib/reminderPages.js`,
 * `lib/actionRouter.js`, `lib/crmActivityNotifier.js`, `routes/cronJobs.js`,
 * `lib/phoneCallReminders.js` — 8 separate copies, each one a chance to be
 * missed exactly like `captureAlerts.js` was. This module is the single,
 * validated replacement for every one of them.
 */
'use strict';

const PRODUCTION_FALLBACK_URL = 'https://crm.ecconstructiongroup.com';

// Hosts a CRM link must never point at, even if CRM_PUBLIC_URL is explicitly
// (mis)configured to one — a stale/wrong value is still safer to override
// than to trust blindly for a link this installation's staff will click.
// Deliberately does NOT block Railway's own generated *.up.railway.app
// domains: lib/platformInfraProvisioning.js legitimately sets a brand-new
// company's real frontend_url to exactly that shape before a custom domain
// is attached (see "Multi-company direction" in CLAUDE.md) — that is a
// genuine, working CRM origin, not a misconfiguration.
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return true;
  if (h.endsWith('.railway.internal')) return true;
  if (h === 'base44.app' || h.endsWith('.base44.app')) return true;
  if (h === 'base44.com' || h.endsWith('.base44.com')) return true;
  return false;
}

/**
 * The validated, absolute CRM base URL — e.g. "https://crm.ecconstructiongroup.com"
 * — with no trailing slash and no path. ALWAYS returns a valid absolute
 * http(s) URL with a real host: never a blank string, a bare scheme, a
 * relative path, or any blocked host. Falls back to the known production
 * CRM URL whenever `CRM_PUBLIC_URL` is unset, unparsable, missing a
 * protocol/host, or points at a blocked host — logging a warning only for
 * the invalid/blocked cases (a real misconfiguration worth surfacing), not
 * for the simply-unset case (CRM_PUBLIC_URL is documented as "Recommended",
 * not "Required" — see docs/CONFIGURATION_REFERENCE.md).
 */
function getCrmBaseUrl() {
  const raw = process.env.CRM_PUBLIC_URL;
  if (raw) {
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch (e) {
      console.warn(`[crmUrl] CRM_PUBLIC_URL is set but not a valid URL ("${raw}") — falling back to the production CRM URL.`);
    }
    if (parsed) {
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isBlockedHost(parsed.hostname)) {
        return `${parsed.protocol}//${parsed.host}`;
      }
      console.warn(`[crmUrl] CRM_PUBLIC_URL ("${raw}") is not a usable CRM link base (wrong protocol or a blocked host) — falling back to the production CRM URL.`);
    }
  }
  return PRODUCTION_FALLBACK_URL;
}

/**
 * An absolute URL to a specific lead in the CRM, e.g.
 * "https://crm.ecconstructiongroup.com/leads/<id>" — the correct frontend
 * route (crm-frontend/src/App.jsx routes `/leads/:id` to LeadDetailModern,
 * verified, never assumed). Returns null when leadId is missing — callers
 * MUST omit the link/button entirely in that case rather than ever emit a
 * bare "/leads/" or "/leads/undefined" link.
 */
function buildLeadUrl(leadId) {
  if (!leadId) return null;
  return `${getCrmBaseUrl()}/leads/${encodeURIComponent(String(leadId))}`;
}

module.exports = { getCrmBaseUrl, buildLeadUrl, isBlockedHost, PRODUCTION_FALLBACK_URL };
