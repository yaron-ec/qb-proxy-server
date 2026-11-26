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

// Generic heartbeat check over any single-row `id=1`-style run-tracking
// table with a timestamp column — mirrors checkReminderHeartbeat's shape,
// but table/column/threshold are read from the service's own inventory
// entry (reminder-worker's heartbeat check stays as its own dedicated
// function since it also inspects last_run_status/consecutive_failures,
// which followup_reminder_runs has no equivalent of).
async function checkCalendarWorkerHeartbeat(service) {
  try {
    const { rows } = await db.query(
      `SELECT ${service.heartbeatField} AS last_run_at FROM ${service.heartbeatTable} WHERE id = 1`
    );
    const row = rows[0];
    if (!row || !row.last_run_at) {
      return { serviceId: service.id, healthy: false, checkType: 'heartbeat', error: `${service.heartbeatTable} row missing or never ticked` };
    }
    const ageMs = Date.now() - new Date(row.last_run_at).getTime();
    const healthy = ageMs < service.staleThresholdMs;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'heartbeat',
      details: { lastRunAt: row.last_run_at, ageMs, staleThresholdMs: service.staleThresholdMs },
      error: healthy ? null : `Heartbeat stale (${Math.round(ageMs / 60000)}min old) — worker process likely dead`,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'heartbeat', error: e.message };
  }
}

// November 2026 "John John" production incident fix (item 6 of the report):
// this previously counted ONLY service.backlogPendingValue ('pending') —
// a row stuck at 'failed' (awaiting its next_attempt_at backoff retry) or
// permanently 'dead' (calendar_outbox's own bounded retry, max_attempts=5,
// exhausted) was invisible to this check, regardless of how long it had
// been stuck or how many rows had dead-lettered. A failed/dead
// calendar_outbox row means a reschedule's old Google Calendar event was
// never actually cancelled, or a new one never actually created — exactly
// the "silently leaving stale events" failure mode this check exists to
// catch. Fixed to mirror checkGoogleContactsOutboxHealth's already-correct
// pattern (that function's own header explains it mirrors this one — the
// two had drifted; this closes that gap in the original, generic over
// service.backlogRetryableValues (defaults to just backlogPendingValue, so
// a caller that never opts in is byte-for-byte unaffected) and an optional
// service.backlogDeadValue (default null = not checked, same reason).
async function checkOutboxBacklog(service) {
  try {
    const table = service.backlogTable;
    const statusField = service.backlogStatusField || 'status';
    const retryableValues = service.backlogRetryableValues || [service.backlogPendingValue || 'pending'];
    const deadValue = service.backlogDeadValue || null;
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE ${statusField} = ANY($1)) AS pending_count,
         COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND ${statusField} = $2) AS dead_count,
         COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE ${statusField} = ANY($1)))) * 1000, 0) AS oldest_age_ms
       FROM ${table}`,
      [retryableValues, deadValue]
    );
    const pendingCount = parseInt(rows[0]?.pending_count || '0', 10);
    const deadCount = parseInt(rows[0]?.dead_count || '0', 10);
    const oldestAgeMs = parseFloat(rows[0]?.oldest_age_ms || 0);
    const backlogStuck = oldestAgeMs > service.maxBacklogAge;
    const healthy = pendingCount < 100 && !backlogStuck && deadCount === 0;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'backlog',
      details: { pendingCount, deadCount, oldestAgeMs, maxBacklogAge: service.maxBacklogAge, backlogStuck },
      error: healthy ? null
        : deadCount > 0 ? `${deadCount} ${table} row(s) permanently failed (dead-lettered, retries exhausted) — needs manual review`
        : `Backlog: ${pendingCount} pending/retrying, oldest ${Math.round(oldestAgeMs / 1000)}s old`,
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

// A sustained-open circuit breaker counts as unhealthy for watchdog/alert
// purposes once it has failed this many consecutive reopen trials with NO
// intervening success — roughly 2+ hours at the breaker's own 30-minute
// max cooldown (lib/qbRateLimitBreaker.js#MAX_COOLDOWN_MS), comfortably
// longer than any single ordinary blip the breaker's own retry/backoff
// design already recovers from on its own, short enough to alert well
// within the same day rather than after it's been broken for days.
const QB_BREAKER_WATCHDOG_OPENS_THRESHOLD = 3;

async function checkQbHealth(service, baseUrl) {
  const start = Date.now();
  const targetBase = service.directUrl || baseUrl;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`${targetBase}/qb/health`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json();
    const credentialHealthy = !data.reconnectRequired && data.connected;

    // November 2026 "automated alerting never caught a 3-day QB outage"
    // finding: a valid OAuth credential (confirmed here) says nothing about
    // whether QuickBooks DATA sync is actually working — the credential
    // kept refreshing successfully every hour throughout the entire
    // incident while every single sync call failed behind an open circuit
    // breaker, and this check (the ONE thing the production watchdog's
    // automated alert pipeline reads for 'quickbooks-integration') never
    // looked at the breaker at all. Read it directly — a pure, read-only
    // app_settings SELECT, never a QuickBooks network call, never consumes
    // the breaker's one trial slot — and fold a SUSTAINED (not a brief,
    // normal) open state into this health signal so the EXISTING watchdog
    // alert/dedup/recovery-notification pipeline actually fires.
    let breakerState = null;
    let breakerSustainedOpen = false;
    try {
      const breaker = require('../qbRateLimitBreaker');
      breakerState = await breaker.getState();
      breakerSustainedOpen = breaker.isCoolingDown(breakerState) && (breakerState.opens_count || 0) >= QB_BREAKER_WATCHDOG_OPENS_THRESHOLD;
    } catch (e) { /* best-effort — a breaker-read failure never flips this check unhealthy on its own */ }

    const healthy = credentialHealthy && !breakerSustainedOpen;
    let error = null;
    // failureReason: a STABLE category for this failure, deliberately never
    // including a changing value (a reopen counter, a raw timestamp) — this
    // is what lib/monitoring/crashLoopDetector.js#shouldAlert compares
    // against the incident's last-alerted category to decide whether a
    // persistent incident is still the SAME failure (apply the 24h
    // cooldown) or has genuinely changed (alert immediately). Comparing the
    // full `error` string instead would defeat the cooldown entirely, since
    // that string embeds `breakerState.opens_count`, which increments every
    // reopen even while the underlying condition is completely unchanged.
    let failureReason = null;
    if (!credentialHealthy) {
      error = `QB ${data.reconnectRequired ? 'reconnect required (OAuth expired)' : 'not connected'}`;
      failureReason = data.reconnectRequired ? 'reconnect_required' : 'not_connected';
    } else if (breakerSustainedOpen) {
      const quota = breakerState.last_failure_detail && breakerState.last_failure_detail.reason === 'quota_exhausted';
      error = quota
        ? `QuickBooks API monthly call quota exhausted (${breakerState.last_failure_detail.throttlePlanName || 'Intuit throttle plan'}) — sync will not recover automatically until Intuit's quota resets or the API plan is upgraded`
        : `QuickBooks rate-limit circuit breaker has reopened ${breakerState.opens_count} consecutive times with no successful trial — sync has been down for a sustained period`;
      failureReason = quota ? 'quota_exhausted' : 'rate_limited_sustained';
    }
    return {
      serviceId: service.id,
      healthy,
      checkType: 'qb_integration',
      responseTimeMs: Date.now() - start,
      details: {
        connected: data.connected, reconnectRequired: data.reconnectRequired, tokenExpired: data.tokenExpired,
        circuit_breaker_state: breakerState ? breakerState.state : null,
        circuit_breaker_opens_count: breakerState ? breakerState.opens_count : null,
      },
      error,
      failureReason,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'qb_integration', responseTimeMs: Date.now() - start, error: e.message };
  }
}

/**
 * checkQbSyncScheduler — DIFFERENT failure class from checkQbHealth above:
 * that check catches sync ATTEMPTS that are failing (a sustained-open
 * circuit breaker); this one catches the scheduler not even making
 * attempts at all (e.g. a crashed/hung process, a cron registration bug —
 * the user's own explicit "is a scheduler failure the real cause" question).
 * Keyed on `last_attempted_at` specifically, never `last_successful_sync_at`
 * — both QB crons already write `last_attempted_at` on EVERY tick
 * regardless of outcome (server.js), so during an ordinary sustained-429
 * incident (covered by checkQbHealth instead) this stays fresh and this
 * check correctly stays healthy — the two checks are complementary, never
 * duplicate alerts for the same root cause.
 */
async function checkQbSyncScheduler(service) {
  const start = Date.now();
  try {
    if (!require('../qbSyncCronConfig').isEstimateSyncCronEnabled()) {
      // Explicitly, deliberately turned off by an operator — not a failure.
      return { serviceId: service.id, healthy: true, checkType: 'qb_sync_scheduler', responseTimeMs: Date.now() - start, details: { reason: 'cron_disabled' }, error: null };
    }
    const { getQbSyncStatus } = require('../qbSyncStatus');
    const status = await getQbSyncStatus();
    const thresholdMs = service.maxAttemptSilenceMs || 3 * 60 * 60 * 1000;
    const now = Date.now();
    const checks = [
      { key: 'estimate_sync', cursor: status.estimate_sync },
      { key: 'inbound_reconcile', cursor: status.inbound_reconcile },
    ];
    const stale = checks.filter(({ cursor }) => {
      if (!cursor || !cursor.available) return false; // a read failure is reported separately below, never silently treated as staleness
      if (!cursor.ever_run) return false; // a brand-new install has never ticked yet — not a failure
      const lastAttempt = cursor.last_attempted_at ? new Date(cursor.last_attempted_at).getTime() : null;
      return !lastAttempt || (now - lastAttempt) > thresholdMs;
    });
    const unavailable = checks.filter(({ cursor }) => !cursor || !cursor.available);
    const healthy = stale.length === 0 && unavailable.length === 0;
    let error = null;
    if (unavailable.length > 0) error = `sync_cursors unavailable for: ${unavailable.map((c) => c.key).join(', ')}`;
    else if (stale.length > 0) error = `no scheduled attempt recorded in over ${Math.round(thresholdMs / 60000)} minutes for: ${stale.map((c) => c.key).join(', ')} — the scheduler may not be executing`;
    return {
      serviceId: service.id,
      healthy,
      checkType: 'qb_sync_scheduler',
      responseTimeMs: Date.now() - start,
      details: {
        estimate_sync_last_attempted_at: status.estimate_sync?.last_attempted_at || null,
        inbound_reconcile_last_attempted_at: status.inbound_reconcile?.last_attempted_at || null,
      },
      error,
    };
  } catch (e) {
    return { serviceId: service.id, healthy: false, checkType: 'qb_sync_scheduler', responseTimeMs: Date.now() - start, error: e.message };
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
    case 'calendar_worker_heartbeat': return checkCalendarWorkerHeartbeat(service);
    case 'outbox_backlog': return checkOutboxBacklog(service);
    case 'db_connection': return checkDbConnection(service);
    case 'qb_integration': return checkQbHealth(service, baseUrl);
    case 'qb_sync_scheduler': return checkQbSyncScheduler(service);
    case 'handoff_integration': return checkHandoffHealth(service, baseUrl);
    case 'google_contacts_outbox_backlog': return checkGoogleContactsOutboxHealth(service);
    case 'gmail_integration': return checkGmailIntegrationHealth(service);
    case 'website_intake_silence': return checkWebsiteIntakeSilence(service);
    case 'website_intake_rejections': return checkWebsiteIntakeRejections(service);
    default: return checkHttpHealth(service, baseUrl);
  }
}

module.exports = {
  probeService, checkHttpHealth, checkReminderHeartbeat, checkCalendarWorkerHeartbeat, checkOutboxBacklog, checkDbConnection,
  checkQbHealth, checkQbSyncScheduler, checkHandoffHealth, checkGoogleContactsOutboxHealth, checkGmailIntegrationHealth,
  checkWebsiteIntakeSilence, checkWebsiteIntakeRejections,
};