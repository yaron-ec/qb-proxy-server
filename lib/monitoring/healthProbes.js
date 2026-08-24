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
  const url = `${baseUrl}${service.healthUrl}`;
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

async function probeService(service, baseUrl) {
  switch (service.healthSignal || 'http') {
    case 'reminder_runs_heartbeat': return checkReminderHeartbeat(service);
    case 'outbox_backlog': return checkOutboxBacklog(service);
    case 'db_connection': return checkDbConnection(service);
    default: return checkHttpHealth(service, baseUrl);
  }
}

module.exports = { probeService, checkHttpHealth, checkReminderHeartbeat, checkOutboxBacklog, checkDbConnection };