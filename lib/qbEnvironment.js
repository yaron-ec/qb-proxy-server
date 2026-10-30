'use strict';

/**
 * qbEnvironment — the ONE validated source of truth for which QuickBooks
 * environment ("production" or "sandbox") every QuickBooks-calling module
 * in this codebase uses, for BOTH the API hostname AND the stored-credential
 * lookup key.
 *
 * October 2026 reliability audit finding: server.js and
 * lib/systemHealthChecks.js already resolved the hostname from
 * `QB_ENVIRONMENT` (default 'sandbox'), but lib/qbInboundSync.js,
 * lib/qbSyncTrigger.js and lib/qbEstimateInvoice.js separately resolved
 * which STORED CREDENTIAL to load from a second, independent variable,
 * `QB_SANDBOX` (default 'production' — the opposite default). The two
 * variables happen to agree in this installation today only because
 * `QB_ENVIRONMENT=production` is explicitly set and `QB_SANDBOX` is unset.
 * If `QB_ENVIRONMENT` were ever accidentally unset or mistyped, those three
 * modules would keep loading the PRODUCTION credential (since an unset
 * `QB_SANDBOX` resolves to 'production') while sending the request to the
 * SANDBOX hostname (since an unset/invalid `QB_ENVIRONMENT` resolves to
 * 'sandbox') — a production access token presented to Intuit's sandbox API,
 * which Intuit would reject outright. Conversely, `QB_SANDBOX=true` with
 * `QB_ENVIRONMENT` still 'production' would send requests to the production
 * hostname while trying to load a (very likely nonexistent) 'sandbox'
 * credential, producing a confusing partial outage limited to whichever
 * modules read `QB_SANDBOX`. Neither failure mode is the current 429
 * incident (both would show up as 401/403/"not connected", not 429) but
 * both are real, latent correctness risks this module closes by giving
 * every module exactly one place to ask the same question.
 *
 * `QB_SANDBOX` is no longer read by any hostname- or credential-selection
 * code path after this change — every call site below derives the
 * equivalent "is this sandbox?" boolean from the same resolved value
 * instead, including the two purely cosmetic QB-app deep-link builders
 * (lib/qbSyncTrigger.js, routes/leadQB.js) that used to read it directly.
 */

const QB_HOSTS = Object.freeze({
  production: 'https://quickbooks.api.intuit.com/v3/company',
  sandbox: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
});

const QB_APP_URLS = Object.freeze({
  production: 'https://app.qbo.intuit.com',
  sandbox: 'https://sandbox.qbo.intuit.com',
});

let warnedOnce = false;

/**
 * Resolves `QB_ENVIRONMENT` to exactly 'production' or 'sandbox'.
 *
 * Fails SAFE (never silently treats a misconfigured/unset value as
 * 'production' — the higher-consequence environment) but fails VISIBLY: an
 * unset or unrecognized value is logged loudly (once per process, so it
 * can't be missed in a deploy's logs, but also can't spam) and reported via
 * `misconfigured: true` so a caller (System Health, buildHealthPayload) can
 * surface it to an admin instead of only to a log line. This NEVER changes
 * behavior for a correctly configured installation (`QB_ENVIRONMENT` set to
 * exactly 'production' or 'sandbox', case-insensitive) — including this
 * installation's current production config.
 */
function resolveQbEnvironment() {
  const raw = String(process.env.QB_ENVIRONMENT || '').trim().toLowerCase();
  if (raw === 'production' || raw === 'sandbox') {
    return { environment: raw, misconfigured: false, raw: process.env.QB_ENVIRONMENT || null };
  }
  if (!warnedOnce) {
    warnedOnce = true;
    console.error(
      `[qb-environment] QB_ENVIRONMENT is ${raw ? `set to the unrecognized value "${process.env.QB_ENVIRONMENT}"` : 'not set'}. ` +
      `Every QuickBooks-calling module resolves environment through this one function, which is defaulting to 'sandbox' ` +
      `rather than guessing 'production' — a missing/invalid QB_ENVIRONMENT in a real production deployment must be fixed ` +
      `in Railway, never silently worked around. See lib/qbEnvironment.js.`
    );
  }
  return { environment: 'sandbox', misconfigured: true, raw: process.env.QB_ENVIRONMENT || null };
}

function resolveQbApiBase(environment) {
  return QB_HOSTS[environment] || QB_HOSTS.sandbox;
}

function resolveQbAppUrlBase(environment) {
  return QB_APP_URLS[environment] || QB_APP_URLS.sandbox;
}

/** Reset the one-time warning latch — test-only. */
function _resetWarnedOnceForTests() { warnedOnce = false; }

module.exports = {
  QB_HOSTS, QB_APP_URLS,
  resolveQbEnvironment, resolveQbApiBase, resolveQbAppUrlBase,
  _resetWarnedOnceForTests,
};
