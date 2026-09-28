/* eslint-disable no-undef */
/**
 * GET /api/v1/system/info — read-only installation/system health for
 * Admin/System Health (PRODUCTIZATION FOUNDATION — Phase J/H).
 *
 * Surfaces: product version, schema/migration status, this installation's
 * identity (never another installation's — see lib/installationIdentity.js),
 * and per-integration environment-variable presence (NOT_CONFIGURED vs
 * present — never a live connectivity check, so this endpoint is always
 * fast and side-effect-free). No secret VALUE is ever included — only
 * whether a variable is set, and generic connection metadata already
 * treated as non-secret elsewhere (integration_credentials.status,
 * expires_at, last_error_at/message — never encrypted_payload).
 *
 * Auth: admin only (this can reveal which integrations are/aren't wired,
 * which is operationally sensitive even without secret values).
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const { identify } = require('../lib/installationIdentity');
const { integrationEnvStatus } = require('../scripts/install/bootstrap');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

let _pkgVersion = null;
function productVersion() {
  if (_pkgVersion) return _pkgVersion;
  _pkgVersion = require('../package.json').version;
  return _pkgVersion;
}

// Which (provider, credential_type) row(s) in integration_credentials, if
// any, actually back a given module key. Verified against the real writers
// (lib/qbTokenStore usage in server.js, lib/gmailCredentialStore.js,
// lib/signnowClient.js/routes/signnow.js) — NOT a guess from naming
// convention. google_calendar/google_contacts (service-account,
// domain-wide delegation), handoff (app_settings or env), meta (webhook
// HMAC secret only) and sms (Twilio, used only for internal critical
// alerts today — see lib/reminderAlerts.js) never write a row here, so
// their connection state is necessarily env-presence-only.
const CREDENTIAL_SOURCE = {
  quickbooks: { provider: 'intuit', credential_type: 'quickbooks' },
  gmail: { provider: 'google', credential_type: 'gmail' },
  // SignNow only persists a row on the OAuth2 password-grant fallback path;
  // the primary SIGNNOW_API_KEY auth is a stateless bearer token with no
  // stored credential, so a configured-but-no-row SignNow is expected, not
  // an error.
  signnow: { provider: 'signnow', credential_type: 'password' },
};

router.get('/info', async (req, res) => {
  try {
    const installation = await identify();
    const { rows: migRows } = await query('SELECT count(*)::int AS n, max(applied_at) AS last_applied_at FROM schema_migrations');
    const { rows: credRows } = await query(
      `SELECT provider, credential_type, status, expires_at, last_error_at, last_error_message, refreshed_at, last_used_at
       FROM integration_credentials ORDER BY provider, credential_type`
    );

    // integration_credentials-derived state layered on top of the env-var
    // presence check — see docs/INTEGRATIONS_SETUP.md's state model.
    const byProviderAndType = {};
    for (const r of credRows) {
      const state = r.expires_at && new Date(r.expires_at) < new Date() ? 'RECONNECT_REQUIRED'
        : r.last_error_at && (!r.last_used_at || new Date(r.last_error_at) > new Date(r.last_used_at)) ? 'ERROR'
        : 'CONNECTED';
      byProviderAndType[`${r.provider}::${r.credential_type}`] = { state, last_used_at: r.last_used_at, last_error_at: r.last_error_at, last_error_message: r.last_error_message };
    }

    const envStatus = integrationEnvStatus();
    const integrations = {};
    for (const [mod, env] of Object.entries(envStatus)) {
      const source = CREDENTIAL_SOURCE[mod];
      const cred = source ? byProviderAndType[`${source.provider}::${source.credential_type}`] : null;
      integrations[mod] = {
        env_configured: env.configured,
        missing_env: env.missing,
        connection: cred || (env.configured ? { state: 'CONFIGURED' } : { state: 'NOT_CONFIGURED' }),
      };
    }

    res.json({
      product_version: productVersion(),
      installation: { company_name: installation.companyName, installation_id: installation.installationId, configured: installation.configured },
      schema: { migrations_applied: migRows[0].n, last_migration_applied_at: migRows[0].last_applied_at },
      integrations,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[system-info] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
