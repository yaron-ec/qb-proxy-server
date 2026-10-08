/* eslint-disable no-undef */
'use strict';

/**
 * systemHealthChecks — per-integration health evidence for System Health
 * (CRM STABILITY PHASE, System Health audit).
 *
 * Every check function below answers two questions, never one conflated
 * into the other:
 *   1. credential_present — is there ANY evidence this integration has
 *      been configured at all (an env var, a database-stored credential, a
 *      service-account key)? This is always computed, cheap, and never
 *      makes an external network call.
 *   2. live_check — when explicitly requested (verify: true), a genuine
 *      read-only call proving the credential actually works right now.
 *      Never requested implicitly — GET /api/v1/system/info without
 *      ?verify=1 only ever returns credential_present, exactly like the
 *      existing GET /qb/health vs ?verify=1 convention in server.js.
 *
 * "An env var exists" is NEVER reported as "Connected" — only a successful
 * live_check (or, for an OAuth/DB-backed integration, a real stored
 * credential row) earns CONFIGURED, and only a successful live_check earns
 * CONNECTED/DEGRADED/DISCONNECTED. See deriveState() for the exact state
 * machine, applied identically across every integration.
 *
 * Every live check here is a plain, already-used-elsewhere-in-this-
 * codebase, side-effect-free GET: QuickBooks CompanyInfo, Gmail profile,
 * Google Calendar event listing, Google People "me", SignNow user info,
 * Handoff estimates?limit=1, Twilio Account fetch. NONE of them create an
 * invoice, send an email/SMS, send a contract, or modify a contact —
 * exactly the System Health audit's explicit safety requirement.
 *
 * MODULE_FLAG_ENFORCED — updated by the CRM PRODUCTION final reliability
 * audit. The original System Health audit found company_settings
 * .enabled_modules.{gmail,sms,website_intake} had ZERO code consumers.
 * `gmail` and `website_intake` are now fixed: routes/gmail.js and
 * routes/leadEmails.js (the Gmail admin mailbox-read/diagnostic UI and the
 * lead-scoped email-history read) gate on `gmail`; routes/websiteLeads.js's
 * POST/DELETE-test routes gate on `website_intake` (GET status stays
 * reachable, mirroring routes/metaWebhook.js's own GET-bypass). `sms`
 * remains, by DELIBERATE DESIGN, never gated: its one consumer
 * (lib/reminderAlerts.js's Twilio critical-alert channel to STAFF) exists
 * specifically to be independent of everything else, including a
 * company_settings/DB read that might itself be struggling during the
 * exact outage the alert is about — see that file's own header and
 * test/moduleGateCoverage.test.js's structural guard against adding one.
 *
 * IMPORTANT caveat for `gmail`: gating only covers the admin read-only
 * surface. Gmail remains this CRM's SOLE email-sending transport
 * (routes/emails.js, the reminder worker) — disabling the `gmail` module
 * does NOT stop reminders/alerts from sending, by deliberate choice (that
 * would be "stop all customer/staff email," a product decision requiring
 * explicit sign-off, not a side-effect of closing this structural gap). A
 * System Health "Gmail: DISABLED" reading means "the admin mailbox-read UI
 * is off," not "no email is being sent."
 */

const { query } = require('../db/client');
const companyConfig = require('./companyConfig');

const MODULE_FLAG_ENFORCED = Object.freeze({
  quickbooks: true,
  gmail: true,            // now gates routes/gmail.js + routes/leadEmails.js (admin read UI only — see header)
  google_calendar: true,
  google_contacts: true,
  signnow: true,
  handoff: true,
  meta: true,
  sms: false,             // deliberate, permanent exception — see header
  website_intake: true,   // now gates routes/websiteLeads.js's POST/DELETE-test routes
});

function nowIso() { return new Date().toISOString(); }

function liveCheck(ok, degraded, message, detail) {
  return { ok: !!ok, degraded: !!degraded, message, checked_at: nowIso(), detail: detail || null };
}

function notConfigured() {
  return { credential_present: false, credential_source: 'none', missing_env: [], supports_live_check: true, live_check: null };
}

// ── QuickBooks ───────────────────────────────────────────────────────────
async function checkQuickBooks({ verify }) {
  const tokenStore = require('./qbTokenStore');
  const QB_ENVIRONMENT = process.env.QB_ENVIRONMENT || 'sandbox';
  const QB_API_BASE = QB_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com/v3/company'
    : 'https://sandbox-quickbooks.api.intuit.com/v3/company';

  let tokens = null;
  try { tokens = await tokenStore.loadPersistedTokens(QB_ENVIRONMENT); } catch (e) { /* treat as absent */ }
  if (!tokens) return notConfigured();

  let credentialStatus = null;
  try { credentialStatus = await tokenStore.credentialStatus(QB_ENVIRONMENT); } catch (e) { /* best-effort */ }

  let live_check = null;
  if (verify) {
    const qbTokenManager = require('./qbTokenManager');
    try {
      const result = await qbTokenManager.verifyConnection(QB_ENVIRONMENT, QB_API_BASE);
      if (result.reconnectRequired) {
        live_check = liveCheck(false, false, 'Reconnect required — the refresh token has expired or been revoked. An admin must re-authorize via Settings → Integrations.', { credentialStatus });
      } else if (result.ok) {
        live_check = liveCheck(true, false, 'Verified via a read-only CompanyInfo call.', { credentialStatus });
      } else {
        live_check = liveCheck(false, true, `QuickBooks API returned HTTP ${result.status} — likely transient.`, { credentialStatus });
      }
    } catch (e) {
      live_check = liveCheck(false, true, e.message, { credentialStatus });
    }
  }
  return { credential_present: true, credential_source: 'database', missing_env: [], supports_live_check: true, live_check };
}

// ── Gmail ────────────────────────────────────────────────────────────────
async function checkGmail({ verify }) {
  const gmailCredentialStore = require('./gmailCredentialStore');
  const ENVIRONMENT = process.env.QB_ENVIRONMENT || process.env.NODE_ENV || 'production';
  let cred = null;
  try { cred = await gmailCredentialStore.loadGmailCredential(ENVIRONMENT); } catch (e) { /* treat as absent */ }
  if (!cred || !cred.refresh_token) return notConfigured();

  let live_check = null;
  if (verify) {
    const gmailSender = require('./gmailSender');
    try {
      const token = await gmailSender.refreshAccessToken();
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Gmail profile check failed HTTP ${res.status}`);
      const profile = await res.json();
      live_check = liveCheck(true, false, 'Verified via a read-only profile call.', { emailAddress: profile.emailAddress });
    } catch (e) {
      const disconnected = e instanceof gmailSender.GmailCredentialsError;
      live_check = liveCheck(false, !disconnected, disconnected ? 'Reconnect required — ' + e.message : e.message, null);
    }
  }
  return { credential_present: true, credential_source: 'database', missing_env: [], supports_live_check: true, live_check };
}

// ── Google Calendar ──────────────────────────────────────────────────────
async function checkGoogleCalendar({ verify }) {
  const required = ['GOOGLE_SERVICE_ACCOUNT_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) return { credential_present: false, credential_source: 'none', missing_env: missing, supports_live_check: true, live_check: null };

  let live_check = null;
  if (verify) {
    const calendarClient = require('./booking/googleCalendarClient');
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    try {
      const now = new Date();
      const in1Min = new Date(now.getTime() + 60000);
      // listEvents acting as the service account itself (no DWD impersonation)
      // is the SAME code path already used for availability reads elsewhere
      // in this codebase — a tiny, genuinely read-only window, never a write.
      await calendarClient.listEvents(calendarId, now.toISOString(), in1Min.toISOString());
      live_check = liveCheck(true, false, `Verified via a read-only event listing on calendar "${calendarId}".`, { calendarId });
    } catch (e) {
      live_check = liveCheck(false, !!e.isQuota, e.isQuota ? 'Google Calendar quota exceeded — likely transient.' : e.message, { calendarId });
    }
  }
  return { credential_present: true, credential_source: 'service_account', missing_env: [], supports_live_check: true, live_check };
}

// Read-only, credential-independent evidence of whether Contacts sync is
// actually COMPLETING end-to-end — distinct from "the credential works"
// (live_check above). A nonzero dead_count means bounded retry already gave
// up on at least one lead (see lib/googleContactsOutbox.js); that is real
// signal regardless of whether GOOGLE_CONTACTS_SUB is set for a live check.
async function googleContactsSyncEvidence() {
  try {
    const { rows } = await query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'failed')) AS pending,
              COUNT(*) FILTER (WHERE status = 'dead') AS dead,
              MAX(updated_at) FILTER (WHERE status = 'synced') AS last_synced_at
       FROM google_contacts_outbox`
    );
    return {
      pending_count: Number(rows[0]?.pending || 0),
      dead_count: Number(rows[0]?.dead || 0),
      last_synced_at: rows[0]?.last_synced_at || null,
    };
  } catch (e) {
    return null;
  }
}

// ── Google Contacts ──────────────────────────────────────────────────────
async function checkGoogleContacts({ verify }) {
  const sync_evidence = await googleContactsSyncEvidence();
  const required = ['GOOGLE_SERVICE_ACCOUNT_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) return { credential_present: false, credential_source: 'none', missing_env: missing, supports_live_check: true, live_check: null, sync_evidence };

  // The People API has no "service account acting as itself" path — a real
  // live check REQUIRES domain-wide-delegation impersonation of a real
  // mailbox. That mailbox is installation-specific and must never be
  // guessed/hardcoded (see lib/googleContactsOutbox.js's own EC-specific
  // fallback — explicitly NOT reused here). Without GOOGLE_CONTACTS_SUB set,
  // this integration is CONFIGURED (credential present) but not live-checked
  // — an honest "cannot verify" rather than a guessed check. sync_evidence
  // (above) still distinguishes "configured" from "actually syncing" even
  // without a live connectivity check.
  const sub = process.env.GOOGLE_CONTACTS_SUB;
  if (!sub) {
    return { credential_present: true, credential_source: 'service_account', missing_env: [], supports_live_check: false, live_check: null, sync_evidence };
  }

  let live_check = null;
  if (verify) {
    const contactsClient = require('./googleContactsClient');
    try {
      const token = await contactsClient.getAccessToken(sub);
      const res = await fetch('https://people.googleapis.com/v1/people/me?personFields=names', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Google Contacts check failed HTTP ${res.status}`);
      live_check = liveCheck(true, false, `Verified via a read-only People API call impersonating ${sub}.`, { impersonating: sub });
    } catch (e) {
      live_check = liveCheck(false, false, e.message, { impersonating: sub });
    }
  }
  return { credential_present: true, credential_source: 'service_account', missing_env: [], supports_live_check: true, live_check, sync_evidence };
}

// ── SignNow ──────────────────────────────────────────────────────────────
async function checkSignNow({ verify }) {
  const signnowClient = require('./signnowClient');
  const authMethod = signnowClient.getAuthMethod();
  if (authMethod === 'none') return notConfigured();

  let live_check = null;
  if (verify) {
    try {
      const status = await signnowClient.checkConnection();
      if (status.connected) {
        live_check = liveCheck(true, false, 'Verified via a read-only user-info call.', { environment: status.environment || null, email: status.email || null });
      } else {
        live_check = liveCheck(false, false, status.message || 'SignNow reported not connected.', { error: status.error || null });
      }
    } catch (e) {
      live_check = liveCheck(false, true, e.message, null);
    }
  }
  return { credential_present: true, credential_source: authMethod === 'api_key' ? 'env' : 'database', missing_env: [], supports_live_check: true, live_check };
}

// ── Handoff ──────────────────────────────────────────────────────────────
async function checkHandoff({ verify }) {
  const handoffClient = require('./handoffClient');
  let apiKey = null;
  try { apiKey = await handoffClient.getApiKey(); } catch (e) { return notConfigured(); }

  let live_check = null;
  if (verify) {
    try {
      const result = await handoffClient.checkAuth(apiKey);
      if (result.connected && !result.warning) {
        live_check = liveCheck(true, false, 'Verified via a read-only estimates?limit=1 call.', null);
      } else if (result.connected && result.warning) {
        live_check = liveCheck(true, true, result.warning, null);
      } else {
        live_check = liveCheck(false, false, result.reason === 'invalid_key' ? 'The stored Handoff API key was rejected.' : 'Handoff reported not connected.', { reason: result.reason || null });
      }
    } catch (e) {
      live_check = liveCheck(false, true, e.message, null);
    }
  }
  return { credential_present: true, credential_source: 'database_or_env', missing_env: [], supports_live_check: true, live_check };
}

// ── Twilio (sms) ─────────────────────────────────────────────────────────
// NOTE: this does not correspond to any customer-facing SMS feature or
// inbound webhook — it is lib/reminderAlerts.js's internal critical-alert
// channel to STAFF, unconditional on the `sms` module flag (see
// MODULE_FLAG_ENFORCED above and companyConfigContract.js's own note).
async function checkTwilio({ verify }) {
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) return { credential_present: false, credential_source: 'none', missing_env: missing, supports_live_check: true, live_check: null };

  let live_check = null;
  if (verify) {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const basic = Buffer.from(`${sid}:${token}`).toString('base64');
      // GET /Accounts/{sid}.json is Twilio's own read-only account-fetch
      // endpoint — never sends an SMS, never touches a message resource.
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
      });
      if (res.status === 401) { live_check = liveCheck(false, false, 'Twilio rejected the stored Account SID/Auth Token.', null); }
      else if (!res.ok) { live_check = liveCheck(false, true, `Twilio account check failed HTTP ${res.status}.`, null); }
      else {
        const data = await res.json();
        live_check = liveCheck(data.status === 'active', data.status !== 'active', `Verified via a read-only account fetch (status: ${data.status}).`, { status: data.status });
      }
    } catch (e) {
      live_check = liveCheck(false, true, e.message, null);
    }
  }
  return { credential_present: true, credential_source: 'env', missing_env: [], supports_live_check: true, live_check };
}

// ── Meta / Facebook Lead Ads ─────────────────────────────────────────────
// Inbound-webhook-only — no stored page/user access token exists anywhere
// in this codebase to make ANY outbound Graph API call with, so there is no
// safe live check to perform. Recency of the last Meta-sourced lead
// actually received is a genuine, read-only (DB-only) evidence signal
// instead of a fabricated API call.
async function checkMeta({ verify }) {
  const missing = process.env.META_APP_SECRET ? [] : ['META_APP_SECRET'];
  if (missing.length > 0) return { credential_present: false, credential_source: 'none', missing_env: missing, supports_live_check: false, live_check: null };

  let detail = null;
  try {
    const { rows } = await query(`SELECT MAX(created_at) AS last_at, COUNT(*)::int AS total FROM leads WHERE source = 'Instagram / Facebook'`);
    detail = { last_lead_received_at: rows[0]?.last_at || null, total_leads_received: rows[0]?.total || 0 };
  } catch (e) { /* best-effort, never fail the whole check on this */ }

  return { credential_present: true, credential_source: 'webhook_secret', missing_env: [], supports_live_check: false, live_check: null, recency: detail };
}

// ── Website Lead Intake ──────────────────────────────────────────────────
// Inbound-webhook-only, same reasoning as Meta above: no outbound call is
// possible or meaningful — the real evidence is whether the webhook has
// actually received anything recently.
const WEBSITE_INTAKE_E2E_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function checkWebsiteIntake({ verify }) {
  const missing = process.env.WEBSITE_LEAD_WEBHOOK_SECRET ? [] : ['WEBSITE_LEAD_WEBHOOK_SECRET'];
  if (missing.length > 0) return { credential_present: false, credential_source: 'none', missing_env: missing, supports_live_check: false, live_check: null };

  let detail = null;
  try {
    const { rows } = await query(`SELECT MAX(received_at) AS last_at, COUNT(*)::int AS total FROM website_lead_receipts WHERE is_test = FALSE`);
    detail = { last_lead_received_at: rows[0]?.last_at || null, total_leads_received: rows[0]?.total || 0 };
  } catch (e) { /* best-effort */ }

  // "configuration" (secret set) vs "connectivity" (N/A — no outbound call
  // exists for an inbound webhook) vs "end-to-end functionality" (has the
  // FULL pipeline — webhook auth, dedup, lead creation — actually succeeded
  // recently?), kept as three explicitly distinct answers rather than
  // conflating "secret is set" with "it's working." Never auto-triggers a
  // synthetic delivery to find out — the existing admin-only
  // POST /api/v1/website-leads (is_test) + DELETE /test/:externalRef
  // mechanism is the deliberate, on-demand way to prove this, and running it
  // automatically on every health-check click (same `verify=1` click an
  // admin might press repeatedly) risks generating synthetic traffic/rows
  // nobody asked for — exactly what this audit was told never to do.
  const hasRecentReceipt = !!(detail && detail.total_leads_received > 0 && detail.last_lead_received_at
    && (Date.now() - new Date(detail.last_lead_received_at).getTime()) < WEBSITE_INTAKE_E2E_WINDOW_MS);
  const end_to_end = {
    verified: hasRecentReceipt,
    message: !detail || detail.total_leads_received === 0
      ? 'No website lead has ever been received — end-to-end delivery has not been proven yet.'
      : hasRecentReceipt
        ? `A real delivery completed the full pipeline (auth, dedup, lead creation) as recently as ${detail.last_lead_received_at}.`
        : `The most recent delivery was more than ${Math.round(WEBSITE_INTAKE_E2E_WINDOW_MS / 86400000)} days ago (${detail.last_lead_received_at}) — recent end-to-end success is unconfirmed.`,
    manual_check: 'An admin can run a genuine, safe end-to-end proof on demand: POST a test-flagged payload to /api/v1/website-leads, then DELETE /api/v1/website-leads/test/:externalRef to confirm clean creation and removal (no alert, no Google Contacts sync, no real customer record). Not run automatically by this health check.',
  };

  return { credential_present: true, credential_source: 'webhook_secret', missing_env: [], supports_live_check: false, live_check: null, recency: detail, end_to_end };
}

const CHECKS = {
  quickbooks: checkQuickBooks,
  gmail: checkGmail,
  google_calendar: checkGoogleCalendar,
  google_contacts: checkGoogleContacts,
  signnow: checkSignNow,
  handoff: checkHandoff,
  sms: checkTwilio,
  meta: checkMeta,
  website_intake: checkWebsiteIntake,
};

/**
 * deriveState — the ONE state machine applied identically to every
 * integration, so "Connected" always means the same evidence-backed thing
 * everywhere on the page (System Health audit requirement: never mark
 * Connected solely because an env var exists).
 *
 *   DISABLED       — module flag is enforced AND off (never for gmail/sms/
 *                    website_intake — see MODULE_FLAG_ENFORCED).
 *   NOT_CONFIGURED — no credential/env evidence at all.
 *   CONFIGURED     — credential/env present; no live check was requested or
 *                    none is possible for this integration.
 *   CONNECTED      — a live check was requested AND succeeded cleanly.
 *   DEGRADED       — a live check was requested AND succeeded with a caveat
 *                    (transient error, near-expiry, a non-fatal warning).
 *   DISCONNECTED   — a live check was requested AND failed outright
 *                    (revoked, invalid credentials, reconnect required).
 */
function deriveState({ moduleEnabled, flagEnforced, result }) {
  if (flagEnforced && !moduleEnabled) return 'DISABLED';
  if (!result.credential_present) return 'NOT_CONFIGURED';
  if (!result.live_check) return 'CONFIGURED';
  if (result.live_check.ok && !result.live_check.degraded) return 'CONNECTED';
  if (result.live_check.ok && result.live_check.degraded) return 'DEGRADED';
  return 'DISCONNECTED';
}

/**
 * getIntegrationHealth({ verify }) — the single entry point routes/systemInfo.js
 * calls. Runs all 9 checks in parallel (each is independent and read-only);
 * a single integration's check failing never breaks the others.
 */
async function getIntegrationHealth({ verify = false } = {}) {
  const cfg = await companyConfig.getCompanyConfig();
  const enabledModules = cfg.enabled_modules || {};
  const entries = await Promise.all(
    Object.entries(CHECKS).map(async ([mod, fn]) => {
      const flagEnforced = MODULE_FLAG_ENFORCED[mod];
      const moduleEnabled = enabledModules[mod] === true;
      let result;
      try {
        result = await fn({ verify });
      } catch (e) {
        result = { credential_present: false, credential_source: 'none', missing_env: [], supports_live_check: true, live_check: liveCheck(false, true, `Health check itself failed: ${e.message}`, null) };
      }
      const state = deriveState({ moduleEnabled, flagEnforced, result });
      return [mod, {
        module_enabled: moduleEnabled,
        flag_enforced: flagEnforced,
        state,
        credential_source: result.credential_source,
        missing_env: result.missing_env,
        supports_live_check: result.supports_live_check,
        live_check: result.live_check,
        recency: result.recency || null,
        // Present only for integrations with a genuine signal: Google
        // Contacts' outbox backlog (sync_evidence) and Website Intake's
        // explicit config/connectivity/end-to-end distinction (end_to_end).
        sync_evidence: result.sync_evidence || null,
        end_to_end: result.end_to_end || null,
      }];
    })
  );
  return Object.fromEntries(entries);
}

module.exports = {
  MODULE_FLAG_ENFORCED,
  deriveState,
  getIntegrationHealth,
  // Exported individually for focused unit tests.
  checkQuickBooks, checkGmail, checkGoogleCalendar, checkGoogleContacts,
  checkSignNow, checkHandoff, checkTwilio, checkMeta, checkWebsiteIntake,
};
