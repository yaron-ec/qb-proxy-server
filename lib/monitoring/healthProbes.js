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

async function checkHandoffHealth(service, baseUrl) {
  const start = Date.now();
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

// Website Lead Intake: inbound-webhook-only, so the only honest signal is
// "has the pipeline actually delivered anything recently." Module-aware and
// only engages once at least one real receipt has ever landed (never alarms
// a fresh/not-yet-launched installation).
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
      return { serviceId: service.id, healthy: true, checkType: 'website_intake_silence', details: { moduleEnabled: true, total: 0 }, error: null };
    }
    const ageMs = Date.now() - new Date(lastAt).getTime();
    const healthy = ageMs < service.maxSilenceMs;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'website_intake_silence',
      details: { moduleEnabled: true, total, lastReceivedAt: lastAt, ageMs, maxSilenceMs: service.maxSilenceMs },
      error: healthy ? null : `No website lead delivery received in ${Math.round(ageMs / 3600000)}h (threshold ${Math.round(service.maxSilenceMs / 3600000)}h) — check WEBSITE_LEAD_WEBHOOK_SECRET and the website's delivery pipeline.`,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'website_intake_silence', error: e.message };
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
    default: return checkHttpHealth(service, baseUrl);
  }
}

module.exports = {
  probeService, checkHttpHealth, checkReminderHeartbeat, checkOutboxBacklog, checkDbConnection,
  checkQbHealth, checkHandoffHealth, checkGoogleContactsOutboxHealth, checkGmailIntegrationHealth,
  checkWebsiteIntakeSilence,
};