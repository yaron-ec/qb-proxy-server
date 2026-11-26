/* eslint-disable no-undef */
/**
 * productionWatchdog — standalone entrypoint for a SEPARATE Railway Cron job
 * (every 3 min) on a dedicated single-replica service (`ec-crm-production-watchdog`).
 *
 * This is a DIFFERENT failure domain from every service it monitors. If
 * qb-proxy-server, the reminder worker, or any outbox worker is dead/stuck,
 * the watchdog still runs and alerts.
 *
 * What it does:
 *   1. Runs health probes for every monitored service.
 *   2. Records results to monitoring_health_checks (audit trail).
 *   3. Opens/updates monitoring_incidents on failure.
 *   4. Dispatches alerts via the independent alert path (logs + Slack + email).
 *   5. Evaluates safe recovery policy and ATTEMPTS recovery when safe:
 *      - Level 1 transient: one controlled Railway API restart + health verify.
 *      - Level 2 bad deploy: rollback to last known good (if API token allows).
 *      - Level 3 (MODULE_NOT_FOUND, missing env, OAuth): BLOCKED → escalate.
 *   6. Resolves incidents when health is restored.
 *   7. Sends alerts via independent channel (Railway emailService + Slack webhook).
 *
 * What it does NOT do:
 *   - Does NOT attempt a restart for a service with no railwayProjectId/
 *     railwayServiceId in serviceInventory.js, or when RAILWAY_API_TOKEN is
 *     unset/insufficiently scoped (checked live via railwayApiClient — this
 *     degrades to alert-only exactly as before, never throws).
 *   - Does NOT restart a CIRCUIT_BREAKER_SERVICES entry (cron/loop-managed
 *     worker — see recoveryPolicy.js) under any circumstance.
 *   - Does NOT attempt more than one restart per open incident (see
 *     executeRecovery/recordRecoveryOutcome below) — a second failure on the
 *     same still-open incident escalates instead of restarting again.
 *   - Does NOT auto-rollback deployments (requires deployment management scopes).
 *   - Does NOT send customer emails or mutate production data.
 *   - Does NOT monitor clever-manifestation (LEGACY_UNUSED).
 *
 *   node productionWatchdog.js
 */
'use strict';

const db = require('./db/client');
const { getMonitoredServices, getService } = require('./lib/monitoring/serviceInventory');
const { probeService } = require('./lib/monitoring/healthProbes');
const crashLoop = require('./lib/monitoring/crashLoopDetector');
const { verifyAndPromote } = require('./lib/monitoring/knownGoodBaseline');
const { dispatchMonitoringAlert } = require('./lib/monitoring/alertDispatcher');
const { evaluateRecovery, isEscalationError } = require('./lib/monitoring/recoveryPolicy');
const railwayApi = require('./lib/monitoring/railwayApiClient');

// Post-restart health verification: poll for up to 90 seconds (overridable
// only for tests — a real deploy never sets these env vars).
const RESTART_VERIFY_TIMEOUT_MS = parseInt(process.env.WATCHDOG_RESTART_VERIFY_TIMEOUT_MS || '', 10) || 90 * 1000;
const RESTART_VERIFY_INTERVAL_MS = parseInt(process.env.WATCHDOG_RESTART_VERIFY_INTERVAL_MS || '', 10) || 10 * 1000;

async function verifyServiceHealth(service, baseUrl) {
  const deadline = Date.now() + RESTART_VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await probeService(service, baseUrl);
    if (result.healthy) return { healthy: true, verifiedAt: new Date().toISOString(), result };
    await new Promise(r => setTimeout(r, RESTART_VERIFY_INTERVAL_MS));
  }
  return { healthy: false, reason: 'Health did not recover within 90s after restart' };
}

// Executes the recovery decision from recoveryPolicy.js#evaluateRecovery, for
// REAL, when it is safe to do so. Previously (found during the November 2026
// P0 outage response) this function existed but had ZERO call sites anywhere
// in the codebase — handleFailure() only ever logged evaluateRecovery()'s
// static decision TEXT into the alert email ("AUTO_RECOVERY_ATTEMPTED:
// restart" / "...One controlled restart permitted.") without ever actually
// restarting anything, for two services that crashed outright, for roughly
// three hours, until a human noticed a Railway dashboard screenshot. Fixed
// by wiring this into handleFailure below and making it perform the restart
// it describes, bounded to exactly ONE attempt per open incident (tracked on
// monitoring_incidents.recovery_action, which this function is now the only
// writer of) — a second failure on the SAME still-open incident never
// re-attempts; it escalates, exactly like an exhausted crash-loop would.
async function executeRecovery(service, recoveryDecision, incident) {
  if (recoveryDecision.action !== 'restart') {
    return { attempted: false, restarted: false, outcome: recoveryDecision.reason };
  }
  // Bounded to one attempt per incident — recovery_action is only ever set
  // by this function, so a non-null value here means a prior failure on
  // this SAME open incident already tried it.
  if (incident.recovery_action) {
    return {
      attempted: false,
      restarted: false,
      outcome: `Already attempted a ${incident.recovery_action} for this incident (result: ${incident.recovery_result || 'unknown'}) — not restarting again. Escalating.`,
    };
  }
  if (!service.railwayProjectId || !service.railwayServiceId) {
    return { attempted: false, restarted: false, outcome: 'Restart recommended, but this service has no Railway project/service ID configured in serviceInventory.js — operator must restart via the Railway dashboard.' };
  }
  // checkCapabilities() only proves the token is VALID and of the right
  // type — it does not prove it can actually mutate THIS project/service
  // (an account token could still lack access to this specific project).
  // The real proof is restartService()'s own result below: a successful
  // Railway API request is itself not proof of recovery either — that is
  // why the caller polls verifyServiceHealth() afterward rather than
  // trusting `result.success` alone.
  const caps = await railwayApi.checkCapabilities();
  if (!caps.canRestart) {
    return { attempted: false, restarted: false, outcome: `Restart not available — ${caps.reason}. Operator must restart via the Railway dashboard.` };
  }
  const result = await railwayApi.restartService(service.railwayProjectId, service.railwayServiceId);
  if (!result.success) {
    return { attempted: true, restarted: false, outcome: `Restart API call failed: ${result.error}. Operator must restart via the Railway dashboard.` };
  }
  return { attempted: true, restarted: true, outcome: `Restart triggered via Railway API (restartId: ${result.restartId || 'n/a'}). Polling health before declaring recovery...` };
}

async function recordRecoveryOutcome(incidentId, action, outcome) {
  await db.query(
    `UPDATE monitoring_incidents SET recovery_action = $2, recovery_result = $3 WHERE id = $1`,
    [incidentId, action, outcome]
  );
}

async function recordHealthCheck(result) {
  await db.query(
    `INSERT INTO monitoring_health_checks (service_id, check_type, healthy, response_time_ms, http_status, details, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [result.serviceId, result.checkType, result.healthy, result.responseTimeMs || null,
     result.httpStatus || null, JSON.stringify(result.details || {}), result.error || null]
  );
}

async function handleFailure(service, result, baseUrl) {
  // November 2026 CRM final-acceptance requirement: a QuickBooks recovery
  // notification must never be sent merely because auth/breaker look
  // healthy — see lib/qbRecoveryVerification.js. A fresh failure here means
  // any earlier, still-pending verification for this service is now stale;
  // clear it so it can never fire a misleading "recovered" email for an
  // incident that has since reopened.
  if (service.id === 'quickbooks-integration') {
    await require('./lib/qbRecoveryVerification').clearOnFailure();
  }

  const { incident, isNew, isCrashLoop } = await crashLoop.recordFailure(
    service.id, result.error || 'Unknown failure', result.checkType, result.details || {}
  );

  if (!incident) return;

  const shouldAlert = isNew || isCrashLoop || (incident.failure_count % 5 === 0);
  if (!shouldAlert) return;

  const recoveryDecision = evaluateRecovery(service.id, {
    errorSummary: result.error,
    isCrashLoop,
    isNewIncident: isNew,
    previousHealthy: !isCrashLoop,
  });

  // Default alert level follows the crash-loop heuristic (isCrashLoop ?
  // 'critical' : 'warning') — but a small number of checks (currently only
  // website-intake-rejections, see serviceInventory.js's own comment on
  // that entry) represent an ALREADY-sustained, genuinely customer-
  // impacting condition the moment they report unhealthy at all — the
  // crash-loop window (3 failures within 10 minutes) is nearly impossible
  // to satisfy at this watchdog's own ~15-minute probe cadence, which would
  // otherwise leave a real, ongoing failure stuck at 'warning' forever.
  // `service.alwaysCritical` opts a specific service entry into 'critical'
  // on every unhealthy result, independent of crash-loop status — every
  // other service's level is completely unaffected (default unchanged).
  const level = (service.alwaysCritical || isCrashLoop) ? 'critical' : 'warning';

  const { attempted, restarted, outcome } = await executeRecovery(service, recoveryDecision, incident);
  if (attempted || recoveryDecision.action === 'restart') {
    await recordRecoveryOutcome(incident.id, recoveryDecision.action, outcome);
  }

  // November 2026 P0 outage follow-up: "a successful API request is not
  // proof of recovery" — when a restart was genuinely triggered, poll the
  // service's own real health check (never just trust the Railway API's
  // 200) before deciding whether to tell anyone it's fixed. This produces
  // exactly one of two alerts, both distinct from the generic failure
  // alert below: a verified-recovery confirmation, or an escalated
  // recovery-failed critical alert — never a silent nothing either way.
  if (restarted) {
    const verify = await verifyServiceHealth(service, baseUrl);
    if (verify.healthy) {
      const verifiedOutcome = `${outcome} VERIFIED healthy at ${verify.verifiedAt} (polled, not assumed from the API call alone).`;
      await recordRecoveryOutcome(incident.id, recoveryDecision.action, verifiedOutcome);
      await crashLoop.recordSuccess(service.id); // resolves the incident now, not on the next regular tick
      await dispatchMonitoringAlert({
        serviceId: service.id,
        level: 'info',
        errorSummary: 'Recovery verified — automatic restart succeeded and service health was independently re-checked afterward.',
        errorType: 'recovery_verified',
        httpStatus: verify.result?.httpStatus,
        isCrashLoop: false,
        recoveryAction: recoveryDecision.action,
        recoveryResult: verifiedOutcome,
        incidentId: incident.id,
        logLines: [],
      });
      await crashLoop.markAlertSent(incident.id);
      return;
    }
    const failedOutcome = `${outcome} Verification FAILED: ${verify.reason}`;
    await recordRecoveryOutcome(incident.id, recoveryDecision.action, failedOutcome);
    await dispatchMonitoringAlert({
      serviceId: service.id,
      level: 'critical',
      errorSummary: `Automatic restart was triggered but the service did NOT become healthy within ${Math.round(RESTART_VERIFY_TIMEOUT_MS / 1000)}s — operator must investigate immediately.`,
      errorType: 'recovery_failed',
      httpStatus: result.httpStatus,
      isCrashLoop,
      recoveryAction: recoveryDecision.action,
      recoveryResult: failedOutcome,
      incidentId: incident.id,
      logLines: [],
    });
    await crashLoop.markAlertSent(incident.id);
    return;
  }

  await dispatchMonitoringAlert({
    serviceId: service.id,
    level,
    errorSummary: result.error,
    errorType: result.checkType,
    httpStatus: result.httpStatus,
    isCrashLoop,
    recoveryAction: recoveryDecision.action,
    recoveryResult: outcome,
    incidentId: incident.id,
    logLines: [],
  });

  await crashLoop.markAlertSent(incident.id);
}

async function handleSuccess(service, result) {
  const { resolved, incident } = await crashLoop.recordSuccess(service.id);
  if (resolved && incident) {
    // November 2026 CRM final-acceptance requirement: "Recovery
    // notifications must not be sent merely because authentication
    // succeeded or the circuit breaker closed. They must accurately
    // reflect whether dependent synchronization has also caught up."
    // checkQbHealth reporting healthy here means only that OAuth auth is
    // valid and the circuit breaker isn't sustained-open — it says nothing
    // about whether the QB Estimate Sync / Inbound Reconciliation crons
    // have actually completed a real successful run since recovery. For
    // `quickbooks-integration` specifically, defer the notification: start
    // tracking this recovery (lib/qbRecoveryVerification.js) instead of
    // sending it now; the verified-recovery check below (run on every
    // healthy tick, not just this resolving one) sends exactly one email
    // once dependent sync genuinely catches up, however many ticks that
    // takes. Every other service's recovery notification is unchanged.
    if (service.id === 'quickbooks-integration') {
      await require('./lib/qbRecoveryVerification').markRecoveryPending(incident.id);
    } else {
      await dispatchMonitoringAlert({
        serviceId: service.id,
        level: 'info',
        errorSummary: 'Service recovered — incident resolved (health was observed healthy on a regular watchdog cycle, independent of any restart)',
        errorType: 'recovery',
        httpStatus: result.httpStatus,
        isCrashLoop: false,
        recoveryAction: 'none',
        recoveryResult: 'healthy',
        incidentId: incident.id,
        logLines: [],
      });
    }
  }

  if (service.id === 'quickbooks-integration') {
    await require('./lib/qbRecoveryVerification').maybeNotifyVerifiedRecovery(async (pending, caughtUp) => {
      const est = caughtUp.evidence?.estimate_sync;
      const inbound = caughtUp.evidence?.inbound_reconcile;
      await dispatchMonitoringAlert({
        serviceId: service.id,
        level: 'info',
        errorSummary: `QuickBooks recovery VERIFIED — the circuit breaker is closed AND dependent synchronization has genuinely caught up since recovery. Last successful QB Estimate Sync: ${est?.last_successful_sync_at || 'n/a'}. Last successful QB Inbound Reconciliation: ${inbound?.last_successful_sync_at || 'n/a'}.`,
        errorType: 'recovery_verified_sync_caught_up',
        isCrashLoop: false,
        recoveryAction: 'none',
        recoveryResult: 'sync_caught_up',
        incidentId: pending.incidentId,
        logLines: [],
      });
    });
  }

  // Promote known-good baseline if we have commit info
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA;
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
  if (commitSha && service.classification === 'CRITICAL_PRODUCTION') {
    await verifyAndPromote(service.id, commitSha, deploymentId, result);
  }
}

async function runWatchdog() {
  await db.ensureSchema();
  const services = getMonitoredServices();
  // When running inside artistic-determination (reminderWorker.js), there is
  // no local Express server. Use QB_PROXY_URL as fallback for HTTP probes.
  const baseUrl = process.env.CRM_API_URL || process.env.QB_PROXY_URL || `http://localhost:${process.env.PORT || 3000}`;

    const results = [];
    for (const service of services) {
      const result = await probeService(service, baseUrl);
      results.push(result);
      await recordHealthCheck(result);

      if (result.healthy) {
        await handleSuccess(service, result);
      } else {
        await handleFailure(service, result, baseUrl);
      }
    }

    // Per-service breakdown — previously only the aggregate counts were
    // logged (e.g. "unhealthy":4), with no way to tell WHICH 4 without a
    // separate Postgres query against monitoring_health_checks. Every
    // unhealthy service's id + its own check's error reason is now in the
    // one scan log line, matching the level of detail an operator actually
    // needs without extra tooling.
    const unhealthyServices = results.filter(r => !r.healthy).map(r => ({ serviceId: r.serviceId, checkType: r.checkType, error: r.error }));
    const summary = {
      total: results.length,
      healthy: results.filter(r => r.healthy).length,
      unhealthy: results.filter(r => !r.healthy).length,
      unhealthyServices,
      checkedAt: new Date().toISOString(),
    };
    console.log(JSON.stringify({ event: 'PRODUCTION_WATCHDOG_SCAN', ...summary }));

    return summary;
}

module.exports = { runWatchdog, handleFailure, executeRecovery, recordRecoveryOutcome };

// If run directly (not required as a module), execute and exit
if (require.main === module) {
  runWatchdog()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[productionWatchdog] fatal:', e.message);
      process.exit(1);
    });
}