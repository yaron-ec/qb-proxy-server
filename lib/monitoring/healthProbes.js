/* eslint-disable no-undef */
/**
 * healthProbes — read-only health check functions for every service type.
 *
 * Every probe returns a uniform shape:
 *   { serviceId, healthy, checkType, responseTimeMs, details, error }
 *
 * NO probe mutates production data or sends customer-facing messages.
 * All probes are safe to run every 1-3 minutes.
 */
'use strict';

const db = require('../../db/client');

async function checkHttpHealth(service, baseUrl) {
  const start = Date.now();
  const targetBase = service.directUrl || baseUrl;
  const url = `${targetBase}${service.healthUrl}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const responseTimeMs = Date.now() - start;
    const healthy = resp.status === (service.expectedStatus || 200);
    return {
      serviceId: service.id,
      healthy,
      checkType: 'http',
      responseTimeMs,
      httpStatus: resp.status,
      details: { url, expectedStatus: service.expectedStatus || 200 },
      error: healthy ? null : `HTTP ${resp.status}`,
    };
  } catch (e) {
    return {
      serviceId: service.id,
      healthy: false,
      checkType: 'http',
      responseTimeMs: Date.now() - start,
      httpStatus: null,
      details: { url },
      error: e.message,
    };
  }
}

async function checkReminderHeartbeat(service) {
  try {
    const { rows } = await db.query(
      `SELECT last_successful_run_at, last_run_status, consecutive_failures,
              last_run_error, last_run_error_type
       FROM reminder_runs WHERE id = 1`
    );
    const row = rows[0];
    if (!row) {
      return { serviceId: service.id, healthy: false, checkType: 'heartbeat', error: 'reminder_runs row missing' };
    }
    const lastSuccessMs = row.last_successful_run_at ? new Date(row.last_successful_run_at).getTime() : 0;
    const ageMs = Date.now() - lastSuccessMs;
    const healthy = ageMs < service.staleThresholdMs && (row.consecutive_failures || 0) < 3;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'heartbeat',
      details: {
        lastSuccessfulRunAt: row.last_successful_run_at,
        lastRunStatus: row.last_run_status,
        consecutiveFailures: row.consecutive_failures || 0,
        ageMs,
        staleThresholdMs: service.staleThresholdMs,
      },
      error: healthy ? null : `Heartbeat stale (${Math.round(ageMs / 60000)}min old) or ${row.consecutive_failures || 0} consecutive failures`,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'heartbeat', error: e.message };
  }
}

async function checkOutboxBacklog(service) {
  try {
    const table = service.backlogTable;
    const statusField = service.backlogStatusField || 'status';
    const pendingValue = service.backlogPendingValue || 'pending';
    const { rows } = await db.query(
      `SELECT COUNT(*) AS pending_count,
              COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) * 1000, 0) AS oldest_age_ms
       FROM ${table} WHERE ${statusField} = $1`,
      [pendingValue]
    );
    const pendingCount = parseInt(rows[0]?.pending_count || '0', 10);
    const oldestAgeMs = parseFloat(rows[0]?.oldest_age_ms || 0);
    const backlogStuck = oldestAgeMs > service.maxBacklogAge;
    const healthy = pendingCount < 100 && !backlogStuck;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'backlog',
      details: { pendingCount, oldestAgeMs, maxBacklogAge: service.maxBacklogAge, backlogStuck },
      error: healthy ? null : `Backlog: ${pendingCount} pending, oldest ${Math.round(oldestAgeMs / 1000)}s old`,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'backlog', error: e.message };
  }
}

async function checkDbConnection(service) {
  const start = Date.now();
  try {
    await db.query('SELECT 1');
    return {
      serviceId: service.id,
      healthy: true,
      checkType: 'db',
      responseTimeMs: Date.now() - start,
      details: { query: 'SELECT 1' },
      error: null,
    };
  } catch (e) {
    return {
      serviceId: service.id,
      healthy: false,
      checkType: 'db',
      responseTimeMs: Date.now() - start,
      error: e.message,
    };
  }
}

async function checkQbHealth(service, baseUrl) {
  const start = Date.now();
  const targetBase = service.directUrl || baseUrl;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${targetBase}/qb/health`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json();
    const healthy = !data.reconnectRequired && data.connected;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'qb_integration',
      responseTimeMs: Date.now() - start,
      details: { connected: data.connected, reconnectRequired: data.reconnectRequired, tokenExpired: data.tokenExpired },
      error: healthy ? null : `QB ${data.reconnectRequired ? 'reconnect required (OAuth expired)' : 'not connected'}`,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'qb_integration', responseTimeMs: Date.now() - start, error: e.message };
  }
}

// Handoff (Direct API): per CLAUDE.md, this installation has no Handoff API
// key and is deliberately NOT pursuing a direct Handoff connection — the
// real, actively-used pipeline is Handoff -> QuickBooks -> CRM (see
// routes/handoffSync.js / lib/handoffClient.js#getApiKey, both of which
// correctly report Not Configured for this).
//
// FOLLOW-UP CORRECTION (the PR #62 fix below used the WRONG signal): a
// first attempt at this gate checked `companyConfig.isModuleEnabled('handoff')`
// — but that flag is NOT a proxy for "is a direct Handoff connection
// configured." It is ALSO (and, for this installation, ACTUALLY) the gate
// for `routes/handoffEstimates.js`'s entire CRUD router — the real,
// actively-used Handoff-via-QuickBooks estimates feature
// (EstimateSyncDiagnostics.jsx / UnmatchedEstimatesPanel.jsx) — which is why
// it was found to be `true` in production: correctly so, for that unrelated
// feature, not because anyone configured a direct connection. Gating on it
// here would have required either (a) still reporting unhealthy whenever
// that unrelated, working feature's flag is on — which is exactly the false
// alarm this fix exists to remove, confirmed live: the PR #62 fix deployed
// and the next watchdog scan still showed handoff-integration unhealthy
// with "fetch failed" — or (b) flipping that flag to `false` to silence the
// check, which would have 404'd the real estimates router. Neither is
// correct. Fixed by checking the ACTUAL, already-authoritative signal for
// "is a direct Handoff API connection configured" instead —
// `lib/handoffClient.js#getApiKey()`, the SAME function
// `lib/systemHealthChecks.js#checkHandoff` already uses to correctly report
// System Health's separate "Handoff (Direct API)" card as Not Configured.
// It throws when no key exists in either `app_settings.handoff_api_key` or
// `HANDOFF_API_KEY` — completely independent of `enabled_modules.handoff`,
// so this fix can never again be defeated by that flag's unrelated, correct
// value. This has zero overlap with the QuickBooks estimate-sync pipeline's
// own health reporting (`checkHandoffEstimatesSync`/`checkQuickBooks` in
// lib/systemHealthChecks.js) — that pipeline isn't part of
// productionWatchdog.js's 11-service scan at all, so a genuine QB estimate
// sync failure is never masked by this change.
async function checkHandoffHealth(service, baseUrl) {
  const start = Date.now();
  try {
    const handoffClient = require('../handoffClient');
    await handoffClient.getApiKey();
  } catch (e) {
    // No Direct Handoff API key configured anywhere — by design, per
    // CLAUDE.md. Never a false alarm for an intentionally-unused
    // integration, regardless of enabled_modules.handoff's own value.
    return { serviceId: service.id, healthy: true, checkType: 'handoff_integration', details: { apiKeyConfigured: false }, error: null };
  }
  const targetBase = service.directUrl || baseUrl;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${targetBase}/handoff/auth/status`, {
      method: 'POST',
      headers: { 'X-Proxy-Secret': process.env.PROXY_SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await resp.json();
    // Report separately — do NOT convert connected=true into credential_valid=true
    // unless the upstream request proves credential validity.
    // waf_blocked=true means upstream is unreachable; stored connection is NOT proven.
    const storedConnected = !!(data.connected || data.authorized || data.authenticated);
    const wafBlocked = data.waf_blocked === true;
    const upstreamOk = !wafBlocked && resp.ok;
    // healthy only if stored connection exists AND upstream is reachable (no WAF block)
    const healthy = storedConnected && upstreamOk;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'handoff_integration',
      responseTimeMs: Date.now() - start,
      httpStatus: resp.status,
      details: {
        storedConnected,
        upstreamHttpOk: resp.ok,
        wafBlocked,
        upstreamReachable: upstreamOk,
        connectedAt: data.connected_at || null,
        // credential/auth result: only valid if upstream was actually reached
        credentialValid: upstreamOk ? storedConnected : null,
        // entitlement/plan result: not available from this endpoint
        planInfo: data.plan || data.entitlement || null,
      },
      error: healthy ? null
        : wafBlocked ? `Handoff stored=connected but WAF blocks upstream (credential NOT proven)`
        : !storedConnected ? 'Handoff not connected (no stored credential)'
        : `Handoff upstream error (HTTP ${resp.status})`,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'handoff_integration', responseTimeMs: Date.now() - start, error: e.message };
  }
}

// Google Contacts outbox: a stuck/failed backlog IS a sync-failure signal,
// mirroring checkOutboxBacklog's existing calendar_outbox pattern but across
// BOTH retryable statuses ('pending' fresh, 'failed' awaiting backoff) plus a
// separate dead-letter count (permanently failed — bounded retry in
// lib/googleContactsOutbox.js already exhausted, needs human review, never
// resolves on its own with more time).
async function checkGoogleContactsOutboxHealth(service) {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending', 'failed')) AS pending_count,
         COUNT(*) FILTER (WHERE status = 'dead') AS dead_count,
         COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status IN ('pending', 'failed')))) * 1000, 0) AS oldest_pending_age_ms
       FROM google_contacts_outbox`
    );
    const pendingCount = parseInt(rows[0]?.pending_count || '0', 10);
    const deadCount = parseInt(rows[0]?.dead_count || '0', 10);
    const oldestPendingAgeMs = parseFloat(rows[0]?.oldest_pending_age_ms || 0);
    const backlogStuck = oldestPendingAgeMs > service.maxBacklogAge;
    const healthy = pendingCount < 100 && !backlogStuck && deadCount === 0;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'google_contacts_outbox_backlog',
      details: { pendingCount, deadCount, oldestPendingAgeMs, maxBacklogAge: service.maxBacklogAge, backlogStuck },
      error: healthy ? null
        : deadCount > 0 ? `${deadCount} Google Contacts sync(es) permanently failed (dead-lettered) — needs manual review via scripts/reconcileGoogleContacts.js`
        : `Backlog: ${pendingCount} pending/retrying, oldest ${Math.round(oldestPendingAgeMs / 1000)}s old`,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'google_contacts_outbox_backlog', error: e.message };
  }
}

// Gmail: cheap, no-network credential-health proxy. Module-aware — a
// company that has disabled Gmail (or never configured it) must never
// generate a false alarm here; only a genuinely enabled-but-broken
// credential is reported unhealthy.
async function checkGmailIntegrationHealth(service) {
  try {
    const companyConfig = require('../companyConfig');
    const enabled = await companyConfig.isModuleEnabled('gmail');
    if (!enabled) {
      return { serviceId: service.id, healthy: true, checkType: 'gmail_integration', details: { moduleEnabled: false }, error: null };
    }
    const gmailCredentialStore = require('../gmailCredentialStore');
    const ENVIRONMENT = process.env.QB_ENVIRONMENT || process.env.NODE_ENV || 'production';
    const cred = await gmailCredentialStore.loadGmailCredential(ENVIRONMENT);
    if (!cred || !cred.refresh_token) {
      return {
        serviceId: service.id, healthy: false, checkType: 'gmail_integration',
        details: { moduleEnabled: true, credentialPresent: false },
        error: 'Gmail module is enabled but no credential is connected — an admin must connect Gmail via Settings → Integrations (OAuth).',
      };
    }
    const lastErrorMs = cred.last_error_at ? new Date(cred.last_error_at).getTime() : 0;
    const lastUsedMs = cred.last_used_at ? new Date(cred.last_used_at).getTime() : 0;
    const healthy = !(lastErrorMs > lastUsedMs);
    return {
      serviceId: service.id,
      healthy,
      checkType: 'gmail_integration',
      details: { moduleEnabled: true, credentialPresent: true, last_used_at: cred.last_used_at, last_error_at: cred.last_error_at },
      error: healthy ? null : 'Gmail credential error is more recent than its last successful use — sending/refreshing is likely failing (reconnect may be required).',
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'gmail_integration', error: e.message };
  }
}

// Website Lead Intake (silence): inbound-webhook-only, so the only signal
// available here is "has the pipeline delivered anything recently." Module-
// aware and only engages once at least one real receipt has ever landed
// (never alarms a fresh/not-yet-launched installation).
//
// FOLLOW-UP CORRECTION (production reliability audit): this check used to
// report `healthy: false` once the silence window elapsed, which fed
// productionWatchdog.js's crash-loop/incident/alert pipeline — the exact
// same pipeline a real service outage uses — and generated a
// "[EC CRM Monitor] WARNING — Website Lead Intake" SYSTEM_FAILURE email to
// staff. But mere absence of website leads is NOT evidence of a broken
// delivery pipeline — a quiet website (slow season, no ad spend, a holiday)
// produces the exact same silence shape as a genuinely broken one, and this
// check alone cannot tell the two apart. checkWebsiteIntakeRejections below
// CAN: a burst of REJECTED deliveries proves the website is actively
// attempting delivery and being refused — the real signature of a broken
// pipeline, as opposed to simply no customer traffic.
//
// Fixed: this check now ALWAYS reports `healthy: true` (never opens an
// incident, never dispatches an alert, never sends a SYSTEM_FAILURE email)
// — silence is a marketing/activity metric, not a system failure. The real
// underlying data is still fully computed and returned in `details`
// (`silenceDetected`, `ageMs`, `lastReceivedAt`, etc.) and is still recorded
// verbatim into monitoring_health_checks on every run (see
// productionWatchdog.js#recordHealthCheck, which records unconditionally on
// `healthy`) — so the metric is preserved and queryable, it just never
// alerts. A genuine failure of THIS CHECK ITSELF (e.g. the database query
// throwing) is a real infrastructure problem, not "no leads," and is still
// reported unhealthy below, unchanged.
async function checkWebsiteIntakeSilence(service) {
  try {
    const companyConfig = require('../companyConfig');
    const enabled = await companyConfig.isModuleEnabled('website_intake');
    if (!enabled) {
      return { serviceId: service.id, healthy: true, checkType: 'website_intake_silence', details: { moduleEnabled: false }, error: null };
    }
    const { rows } = await db.query(`SELECT MAX(received_at) AS last_at, COUNT(*)::int AS total FROM website_lead_receipts WHERE is_test = FALSE`);
    const lastAt = rows[0]?.last_at || null;
    const total = rows[0]?.total || 0;
    if (total === 0) {
      // Never received anything at all — could be a brand-new installation
      // that hasn't gone live, not necessarily broken. Not alarmed.
      return { serviceId: service.id, healthy: true, checkType: 'website_intake_silence', details: { moduleEnabled: true, total: 0, silenceDetected: false }, error: null };
    }
    const ageMs = Date.now() - new Date(lastAt).getTime();
    const silenceDetected = ageMs >= service.maxSilenceMs;
    return {
      serviceId: service.id,
      healthy: true,
      checkType: 'website_intake_silence',
      details: { moduleEnabled: true, total, lastReceivedAt: lastAt, ageMs, maxSilenceMs: service.maxSilenceMs, silenceDetected },
      error: null,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'website_intake_silence', error: e.message };
  }
}

// Website Lead Intake: a burst of REJECTED deliveries (wrong/rotated secret,
// or the module unexpectedly disabled) is a distinct signal from silence
// above — it means the website IS attempting delivery and the CRM is
// refusing every attempt, which plain silence can't distinguish from
// "nothing ever arrived." See
// db/migrations/2026-58-website-lead-intake-rejections.sql and
// routes/websiteLeads.js#recordRejection (the write side, fire-and-forget).
// A single stray bad request (a manual curl, a stray bot) never alarms —
// only a sustained run within the window trips the threshold. Module-aware,
// same as checkWebsiteIntakeSilence.
async function checkWebsiteIntakeRejections(service) {
  try {
    const companyConfig = require('../companyConfig');
    const enabled = await companyConfig.isModuleEnabled('website_intake');
    if (!enabled) {
      return { serviceId: service.id, healthy: true, checkType: 'website_intake_rejections', details: { moduleEnabled: false }, error: null };
    }
    const windowMs = service.windowMs || 60 * 60 * 1000;
    const threshold = service.threshold || 3;
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n, MAX(received_at) AS last_at FROM website_lead_intake_rejections
        WHERE received_at > NOW() - ($1 || ' milliseconds')::interval`,
      [String(windowMs)]
    );
    const count = rows[0]?.n || 0;
    const healthy = count < threshold;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'website_intake_rejections',
      details: { moduleEnabled: true, count, threshold, windowMs, lastRejectedAt: rows[0]?.last_at || null },
      error: healthy ? null : `${count} website lead deliveries rejected (bad/missing credential) in the last ${Math.round(windowMs / 60000)}m — WEBSITE_LEAD_WEBHOOK_SECRET is likely out of sync between the website and the CRM.`,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'website_intake_rejections', error: e.message };
  }
}

async function probeService(service, baseUrl) {
  switch (service.healthSignal || 'http') {
    case 'reminder_runs_heartbeat': return checkReminderHeartbeat(service);
    case 'outbox_backlog': return checkOutboxBacklog(service);
    case 'db_connection': return checkDbConnection(service);
    case 'qb_integration': return checkQbHealth(service, baseUrl);
    case 'handoff_integration': return checkHandoffHealth(service, baseUrl);
    case 'google_contacts_outbox_backlog': return checkGoogleContactsOutboxHealth(service);
    case 'gmail_integration': return checkGmailIntegrationHealth(service);
    case 'website_intake_silence': return checkWebsiteIntakeSilence(service);
    case 'website_intake_rejections': return checkWebsiteIntakeRejections(service);
    default: return checkHttpHealth(service, baseUrl);
  }
}

module.exports = {
  probeService, checkHttpHealth, checkReminderHeartbeat, checkOutboxBacklog, checkDbConnection,
  checkQbHealth, checkHandoffHealth, checkGoogleContactsOutboxHealth, checkGmailIntegrationHealth,
  checkWebsiteIntakeSilence, checkWebsiteIntakeRejections,
};