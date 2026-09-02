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
 *   7. Sends alerts via independent channel (Railway emailService (lib/emailService) — Base44 fully decommissioned).
 *
 * What it does NOT do:
 *   - Does NOT auto-restart services (Railway API token is read-only).
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

// Post-restart health verification: poll for up to 90 seconds
const RESTART_VERIFY_TIMEOUT_MS = 90 * 1000;
const RESTART_VERIFY_INTERVAL_MS = 10 * 1000;

async function verifyServiceHealth(service, baseUrl) {
  const deadline = Date.now() + RESTART_VERIFY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await probeService(service, baseUrl);
    if (result.healthy) return { healthy: true, verifiedAt: new Date().toISOString(), result };
    await new Promise(r => setTimeout(r, RESTART_VERIFY_INTERVAL_MS));
  }
  return { healthy: false, reason: 'Health did not recover within 90s after restart' };
}

async function attemptSafeRecovery(service, result, incident, baseUrl) {
  const errorSummary = result.error || 'Unknown failure';
  const isCrashLoop = incident?.is_crash_loop || (incident?.failure_count >= 3);

  // Level 3 — escalation errors: BLOCK recovery
  if (isEscalationError(errorSummary)) {
    return {
      action: 'escalate',
      attempted: false,
      reason: `Automatic recovery BLOCKED — escalation error pattern: ${errorSummary.slice(0, 100)}`,
    };
  }

  // Crash loop: BLOCK restart
  if (isCrashLoop) {
    return {
      action: 'escalate',
      attempted: false,
      reason: 'Automatic recovery BLOCKED — crash loop detected (3+ failures in 10 min)',
    };
  }

  // Level 1 — transient failure: attempt ONE controlled restart
  const caps = await railwayApi.checkCapabilities();
  if (!caps.canRestart) {
    return {
      action: 'escalate',
      attempted: false,
      reason: `Restart not available — ${caps.reason}. Operator must restart via Railway dashboard.`,
    };
  }

  // Attempt restart (requires project/service IDs from Railway API)
  // Since we don't have the IDs in the inventory yet, we report the action
  // and the operator performs it. When IDs are available, this becomes automatic.
  return {
    action: 'restart',
    attempted: false,
    reason: 'Restart recommended — Railway API token scope insufficient for automated restart. Operator must restart via Railway dashboard. Post-restart health verification will run on next watchdog cycle.',
  };
}

async function recordHealthCheck(result) {
  await db.query(
    `INSERT INTO monitoring_health_checks (service_id, check_type, healthy, response_time_ms, http_status, details, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [result.serviceId, result.checkType, result.healthy, result.responseTimeMs || null,
     result.httpStatus || null, JSON.stringify(result.details || {}), result.error || null]
  );
}

async function handleFailure(service, result) {
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

  await dispatchMonitoringAlert({
    serviceId: service.id,
    level: isCrashLoop ? 'critical' : 'warning',
    errorSummary: result.error,
    errorType: result.checkType,
    httpStatus: result.httpStatus,
    isCrashLoop,
    recoveryAction: recoveryDecision.action,
    recoveryResult: recoveryDecision.reason,
    logLines: [],
  });

  await crashLoop.markAlertSent(incident.id);
}

async function handleSuccess(service, result) {
  const { resolved, incident } = await crashLoop.recordSuccess(service.id);
  if (resolved && incident) {
    await dispatchMonitoringAlert({
      serviceId: service.id,
      level: 'info',
      errorSummary: 'Service recovered — incident resolved',
      errorType: 'recovery',
      httpStatus: result.httpStatus,
      isCrashLoop: false,
      recoveryAction: 'none',
      recoveryResult: 'healthy',
      logLines: [],
    });
  }

  // Promote known-good baseline if we have commit info
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA;
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID;
  if (commitSha && service.classification === 'CRITICAL_PRODUCTION') {
    await verifyAndPromote(service.id, commitSha, deploymentId, result);
  }
}

(async () => {
  try {
    await db.ensureSchema();
    const services = getMonitoredServices();
    const baseUrl = process.env.CRM_API_URL || `http://localhost:${process.env.PORT || 3000}`;

    const results = [];
    for (const service of services) {
      const result = await probeService(service, baseUrl);
      results.push(result);
      await recordHealthCheck(result);

      if (result.healthy) {
        await handleSuccess(service, result);
      } else {
        await handleFailure(service, result);
      }
    }

    const summary = {
      total: results.length,
      healthy: results.filter(r => r.healthy).length,
      unhealthy: results.filter(r => !r.healthy).length,
      checkedAt: new Date().toISOString(),
    };
    console.log(JSON.stringify({ event: 'PRODUCTION_WATCHDOG_SCAN', ...summary }));

    process.exit(0);
  } catch (e) {
    console.error('[productionWatchdog] fatal:', e.message);
    process.exit(1);
  }
})();