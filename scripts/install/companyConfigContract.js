/* eslint-disable no-undef */
'use strict';

/**
 * companyConfigContract.js — the ONE canonical definition of what a company
 * installation config must/can contain (PRODUCTIZATION — Company
 * Provisioning System, see docs/INSTALL_NEW_COMPANY.md).
 *
 * This is deliberately a plain data module (field specs + a pure validator),
 * not a class or a schema-library dependency — scripts/install/provisionCompany.js
 * and scripts/install/bootstrap.js both import it, and it is also imported
 * directly by tests, so it must have zero side effects and no DB/network
 * access of its own.
 *
 * CONTRACT_VERSION bumps only on a breaking shape change (a field renamed or
 * a previously-optional field becoming required) — purely additive fields
 * don't need a bump. A provisioning report records the version it validated
 * against, so a config file written against an older contract version is
 * still identifiable later.
 *
 * Secrets (anything in MODULES[*].secretEnvVars, plus RAILWAY_JWT_SECRET /
 * ENCRYPTION_KEY) are NEVER part of this config shape — they are supplied
 * only via the deployment environment (Railway env vars), never written to
 * company.json, never logged, never included in a provisioning report. See
 * "Secret-handling model" in docs/INSTALL_NEW_COMPANY.md.
 */

const CONTRACT_VERSION = '1.0.0';

// ── Module metadata ──────────────────────────────────────────────────────────
// One entry per optional integration. `secretEnvVars` are Railway environment
// variables — never read from or written to company.json. `oauth` describes
// a human-in-the-loop authorization step that cannot be scripted from this
// repository; `callbackPath(urls)` computes the exact redirect/webhook URL an
// operator must register with the provider, derived from the installation's
// OWN frontend_url/backend_url (never hardcoded to any specific company).
const MODULES = Object.freeze({
  quickbooks: {
    label: 'QuickBooks Online',
    secretEnvVars: ['QB_CLIENT_ID', 'QB_CLIENT_SECRET', 'QB_REDIRECT_URI'],
    oauth: {
      required: true,
      provider: 'Intuit Developer',
      note: 'Create an app at developer.intuit.com, set its Redirect URI to the callback URL below, then connect via the CRM\'s own Integrations page after first deploy (Admin Override flow — OAuth re-consent only, never stored Intuit credentials).',
      callbackPath: (urls) => (urls.frontend_url ? `${urls.frontend_url}/qb-callback` : null),
      callbackEnvVar: 'QB_REDIRECT_URI',
    },
  },
  gmail: {
    label: 'Gmail (mailbox integration)',
    secretEnvVars: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_OAUTH_REDIRECT_URI', 'GMAIL_FROM_ADDRESS'],
    oauth: {
      required: true,
      provider: 'Google Cloud Console (OAuth consent screen)',
      note: 'Create an OAuth client, set its Authorized redirect URI to the callback URL below, then connect the company\'s own mailbox via the CRM\'s admin-facing Gmail OAuth flow after first deploy.',
      callbackPath: (urls) => (urls.backend_url ? `${urls.backend_url}/internal/gmail/oauth/callback` : null),
      callbackEnvVar: 'GMAIL_OAUTH_REDIRECT_URI',
    },
  },
  google_calendar: {
    label: 'Google Calendar (appointment sync)',
    secretEnvVars: ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_KEY'],
    oauth: {
      required: true,
      provider: 'Google Workspace Admin Console (domain-wide delegation)',
      note: 'Create a service account, grant it domain-wide delegation for Calendar scopes in the company\'s own Google Workspace admin console. No per-user OAuth consent and no redirect URL — this is an admin-console authorization step, not a browser OAuth flow.',
      callbackPath: () => null,
      callbackEnvVar: null,
    },
  },
  google_contacts: {
    label: 'Google Contacts (caller-ID sync)',
    secretEnvVars: ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_KEY'],
    oauth: {
      required: true,
      provider: 'Google Workspace Admin Console (domain-wide delegation)',
      note: 'Shares the same service account as google_calendar — only one domain-wide delegation grant is needed for both modules if both are enabled.',
      callbackPath: () => null,
      callbackEnvVar: null,
    },
  },
  signnow: {
    label: 'SignNow (e-signature)',
    // Only the primary (API key) path is listed for the missing-env-var
    // warning — an operator using the OAuth2 password-grant fallback
    // instead (SIGNNOW_USERNAME/PASSWORD/CLIENT_ID/CLIENT_SECRET, see
    // lib/signnowClient.js) will see a harmless false warning, never a
    // hard failure (warnings here are advisory only).
    secretEnvVars: ['SIGNNOW_API_KEY'],
    oauth: {
      required: false,
      provider: 'SignNow (API key, primary) or SignNow OAuth2 password grant (fallback, application-owner account only)',
      note: 'Primary path is a plain API key from the company\'s own SignNow account — no redirect URL. The OAuth2 password-grant fallback (SIGNNOW_CLIENT_ID/SIGNNOW_CLIENT_SECRET) only works for the account that generated those credentials and has no redirect URL either.',
      callbackPath: () => null,
      callbackEnvVar: null,
    },
  },
  handoff: {
    label: 'Handoff',
    secretEnvVars: ['HANDOFF_API_KEY'],
    oauth: { required: false, provider: null, note: 'Static API key, issued by Handoff for this company\'s own account — no redirect URL.', callbackPath: () => null, callbackEnvVar: null },
  },
  meta: {
    label: 'Meta / Facebook Lead Ads',
    secretEnvVars: ['META_APP_SECRET'],
    oauth: {
      required: true,
      provider: 'Meta for Developers',
      note: 'Create a Meta app, subscribe the company\'s own Facebook Page to the Leadgen webhook, and set the webhook URL (below) and verify token in the Meta app dashboard.',
      callbackPath: (urls) => (urls.backend_url ? `${urls.backend_url}/api/v1/meta-webhook` : null),
      callbackEnvVar: null,
    },
  },
  sms: {
    // KNOWN GAP (found building this contract, documented not silently
    // fixed — see docs/CONFIGURATION_REFERENCE.md): there is no customer-
    // facing SMS feature in this codebase today, and the enabled_modules.sms
    // flag has ZERO consumers anywhere (no `isModuleEnabled('sms')` call
    // exists). The only Twilio integration present is
    // lib/reminderAlerts.js's internal critical-alert channel to STAFF, and
    // it reads TWILIO_* env vars directly/unconditionally — it is NOT gated
    // by this module flag at all. Toggling `sms` in Company Settings
    // currently has no observable effect. Kept in the contract (rather than
    // removed) because it is a real, user-visible toggle in the product
    // today — removing it from the contract silently would hide the gap,
    // not fix it.
    label: 'SMS (currently NO enforcement point — see note)',
    secretEnvVars: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'],
    oauth: {
      required: false,
      provider: null,
      note: 'These Twilio credentials actually configure lib/reminderAlerts.js\'s internal critical-alert SMS to staff, independent of this module flag — there is no customer-facing SMS feature and no inbound webhook. Toggling this module in Company Settings has no current effect; set these env vars directly if you want the internal alert channel regardless of this flag.',
      callbackPath: () => null,
      callbackEnvVar: null,
    },
  },
  website_intake: {
    label: 'Website lead intake webhook',
    secretEnvVars: ['WEBSITE_LEAD_WEBHOOK_SECRET'],
    oauth: {
      required: true,
      provider: "the company's own marketing website / form provider",
      note: 'Configure the company\'s website to POST new leads to the webhook URL below with header x-webhook-secret matching WEBSITE_LEAD_WEBHOOK_SECRET. This module fails CLOSED (503) if the secret is unset — never silently accepts unauthenticated leads.',
      callbackPath: (urls) => (urls.backend_url ? `${urls.backend_url}/api/v1/website-leads` : null),
      callbackEnvVar: null,
    },
  },
});

const MODULE_KEYS = Object.freeze(Object.keys(MODULES));

// ── Field contract ───────────────────────────────────────────────────────────
// `section` groups fields for the installation report / docs only.
// `required` fields must be non-empty for provisionCompany.js to proceed past
// validation (never during/after a DB write).
const FIELD_SPECS = [
  // Identity
  { key: 'company_name', section: 'identity', required: true, type: 'string', description: 'Display name, e.g. "Acme Remodeling".' },
  { key: 'legal_name', section: 'identity', required: false, type: 'string' },
  { key: 'dba', section: 'identity', required: false, type: 'string' },
  { key: 'company_slug', section: 'identity', required: true, type: 'slug', description: 'Lowercase, hyphenated identifier (e.g. "acme-remodeling"). Used only for naming generated artifacts/deployments — never for request routing or tenant scoping.' },
  { key: 'timezone', section: 'identity', required: false, type: 'timezone', default: 'America/Los_Angeles' },
  { key: 'locale', section: 'identity', required: false, type: 'string', default: 'en-US' },
  { key: 'currency', section: 'identity', required: false, type: 'currency', default: 'USD' },
  { key: 'company_phone', section: 'identity', required: false, type: 'string' },
  { key: 'company_email', section: 'identity', required: false, type: 'email', description: 'Primary support/contact email shown in the product.' },
  { key: 'company_website', section: 'identity', required: false, type: 'url' },
  { key: 'company_address', section: 'identity', required: false, type: 'string' },
  { key: 'company_city', section: 'identity', required: false, type: 'string' },
  { key: 'company_state', section: 'identity', required: false, type: 'string' },
  { key: 'company_zip', section: 'identity', required: false, type: 'string' },

  // Branding
  { key: 'company_logo_url', section: 'branding', required: false, type: 'url', description: 'Hosted logo image URL (uploaded by the operator — this contract never uploads a file for you).' },
  { key: 'favicon_url', section: 'branding', required: false, type: 'url' },
  { key: 'brand_primary_color', section: 'branding', required: false, type: 'hexcolor' },

  // Initial administrator
  { key: 'admin_name', section: 'admin', required: false, type: 'string' },
  { key: 'admin_email', section: 'admin', required: true, type: 'email' },
  { key: 'admin_password', section: 'admin', required: true, type: 'password', secret: true, description: 'Never committed anywhere — see "Secret-handling model". Minimum 12 characters.' },

  // Business configuration
  { key: 'appointment_travel_buffer_minutes', section: 'business', required: false, type: 'integer', default: 60 },
  { key: 'business_hours', section: 'business', required: false, type: 'business_hours', default: { start: '08:30', end: '18:30' } },
  { key: 'project_types', section: 'business', required: false, type: 'string[]' },
  { key: 'lead_sources', section: 'business', required: false, type: 'string[]' },
  { key: 'statuses', section: 'business', required: false, type: 'string[]' },
  { key: 'contact_owners', section: 'business', required: false, type: 'string[]' },
  { key: 'default_owner_name', section: 'business', required: false, type: 'string' },
  { key: 'default_owner_email', section: 'business', required: false, type: 'email' },
  { key: 'default_owner_starting_location', section: 'business', required: false, type: 'string', description: 'Street address the Daily Map/routing engine uses as this owner\'s start-of-day location (seeds app_settings.owner_starting_locations). Optional — omitted means the routing engine has no starting point for this owner until set via the admin UI.' },
  { key: 'notification_recipients', section: 'business', required: false, type: 'notification_recipients' },
  { key: 'email_from_name', section: 'business', required: false, type: 'string' },

  // Modules
  { key: 'enabled_modules', section: 'modules', required: false, type: 'enabled_modules', default: Object.fromEntries(MODULE_KEYS.map((k) => [k, false])) },

  // Infrastructure (used only by the provisioner for computing callback URLs
  // and generating the env manifest — NEVER written to company_settings)
  { key: 'environment', section: 'infra', required: false, type: 'string', default: 'production', description: 'A label for this deployment (e.g. "production", "staging") — shown only in the installation report.' },
  { key: 'frontend_url', section: 'infra', required: true, type: 'url', description: "This installation's own CRM frontend URL (e.g. https://crm.acme.example). Required to compute OAuth callback URLs." },
  { key: 'backend_url', section: 'infra', required: true, type: 'url', description: "This installation's own API URL (e.g. https://acme-crm-api.up.railway.app)." },
  { key: 'custom_domain', section: 'infra', required: false, type: 'string' },
];

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const HEXCOLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidUrl(v) {
  try { new URL(v); return true; } catch { return false; }
}

function typeCheck(spec, value) {
  switch (spec.type) {
    case 'string': return typeof value === 'string' && value.length > 0;
    case 'slug': return typeof value === 'string' && SLUG_RE.test(value) && value.length >= 3 && value.length <= 63;
    case 'email': return typeof value === 'string' && EMAIL_RE.test(value);
    case 'url': return typeof value === 'string' && isValidUrl(value);
    case 'hexcolor': return typeof value === 'string' && HEXCOLOR_RE.test(value);
    case 'timezone':
      try { Intl.DateTimeFormat(undefined, { timeZone: value }); return true; } catch { return false; }
    case 'currency': return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
    case 'integer': return Number.isInteger(value) && value >= 0;
    case 'password': return typeof value === 'string' && value.length >= 12;
    case 'string[]': return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
    case 'business_hours': return value && typeof value.start === 'string' && typeof value.end === 'string';
    case 'notification_recipients': return value && (value.to === undefined || Array.isArray(value.to)) && (value.cc === undefined || Array.isArray(value.cc));
    case 'enabled_modules':
      if (typeof value !== 'object' || value === null) return false;
      return Object.keys(value).every((k) => MODULE_KEYS.includes(k) && typeof value[k] === 'boolean');
    default: return true;
  }
}

/**
 * Validates a company config object against the contract. Pure — no I/O, no
 * DB, no network. Safe to call before any destructive/remote action, which
 * is exactly what provisionCompany.js does as its first step.
 *
 * @returns {{ ok: boolean, errors: {field:string, message:string}[], warnings: {field:string, message:string}[] }}
 */
function validateConfig(cfg) {
  const errors = [];
  const warnings = [];
  if (!cfg || typeof cfg !== 'object') {
    return { ok: false, errors: [{ field: '(root)', message: 'config must be a JSON object' }], warnings: [] };
  }

  for (const spec of FIELD_SPECS) {
    const value = cfg[spec.key];
    const present = value !== undefined && value !== null && value !== '';
    if (!present) {
      if (spec.required) errors.push({ field: spec.key, message: `required field "${spec.key}" is missing` });
      continue;
    }
    if (!typeCheck(spec, value)) {
      errors.push({ field: spec.key, message: `"${spec.key}" failed validation for type "${spec.type}"${spec.description ? ' — ' + spec.description : ''}` });
    }
  }

  // Cross-field: at least one contact email must exist for default_owner_email
  // to resolve (mirrors bootstrap.js#ensureCompanySettings's own runtime
  // check — surfaced here so it fails BEFORE any DB connection, not after
  // migrations have already run).
  if (!cfg.default_owner_email && !cfg.admin_email && !cfg.company_email) {
    errors.push({ field: 'default_owner_email', message: 'at least one of default_owner_email, admin_email, or company_email is required' });
  }

  // Module secret/OAuth presence is reported as warnings, never errors —
  // a module can be legitimately enabled with its OAuth step deferred to
  // after first deploy (the whole point of the "requires a human" split).
  if (cfg.enabled_modules) {
    for (const key of MODULE_KEYS) {
      if (cfg.enabled_modules[key] !== true) continue;
      const mod = MODULES[key];
      const missingSecrets = mod.secretEnvVars.filter((envVar) => !process.env[envVar]);
      if (missingSecrets.length) {
        warnings.push({ field: `enabled_modules.${key}`, message: `module enabled but missing env var(s) in THIS process: ${missingSecrets.join(', ')} — set these on the deployment, not in company.json` });
      }
    }
  }

  if (cfg.company_slug && !SLUG_RE.test(cfg.company_slug)) {
    errors.push({ field: 'company_slug', message: 'must be lowercase alphanumeric with single hyphens, e.g. "acme-remodeling"' });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Computes every module's callback/webhook URL from this config's own frontend_url/backend_url. */
function computeCallbackUrls(cfg) {
  const urls = { frontend_url: cfg.frontend_url || null, backend_url: cfg.backend_url || null };
  const out = {};
  for (const key of MODULE_KEYS) {
    const mod = MODULES[key];
    out[key] = {
      label: mod.label,
      oauth_required: mod.oauth.required,
      provider: mod.oauth.provider,
      note: mod.oauth.note,
      callback_url: mod.oauth.callbackPath(urls),
      callback_env_var: mod.oauth.callbackEnvVar,
      secret_env_vars: mod.secretEnvVars,
    };
  }
  return out;
}

module.exports = { CONTRACT_VERSION, FIELD_SPECS, MODULES, MODULE_KEYS, validateConfig, computeCallbackUrls };
