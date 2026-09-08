/* eslint-disable no-undef */
/**
 * serviceInventory — canonical classification of every Railway service in the
 * EC Construction Group CRM infrastructure.
 *
 * Classification tiers:
 *   CRITICAL_PRODUCTION — serves live customer traffic; outage blocks revenue
 *   WORKER_CRITICAL     — background worker whose failure blocks a critical path
 *   WORKER              — background worker, non-critical-path
 *   CRITICAL_INFRA      — database/storage all other services depend on
 *   WATCHDOG            — monitoring service itself (not monitored by itself)
 *   LEGACY_UNUSED       — abandoned/stale; DO NOT monitor as production-critical
 *
 * clever-manifestation / qb-proxy-server is intentionally NOT listed here.
 * It is classified LEGACY_UNUSED (see forensic report). Monitoring it would
 * generate false alerts for a service that serves zero production traffic.
 */
'use strict';

const SERVICES = [
  {
    id: 'qb-proxy-server',
    name: 'QB Proxy Server (API)',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'CRITICAL_PRODUCTION',
    healthUrl: '/health',
    expectedStatus: 200,
    port: 3000,
    dependentServices: ['postgres'],
    knownGoodCommit: '2fe2ffeb9dc122dd00c92d423f492c35b5d006b5',
  },
  {
    id: 'reminder-worker',
    name: 'Reminder Worker',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER_CRITICAL',
    healthSignal: 'reminder_runs_heartbeat',
    heartbeatTable: 'reminder_runs',
    heartbeatField: 'last_successful_run_at',
    staleThresholdMs: 70 * 60 * 1000, // 2x cron interval + buffer
    dependentServices: ['postgres', 'gmail-oauth'],
  },
  {
    id: 'calendar-outbox-worker',
    name: 'Calendar Outbox Worker',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER_CRITICAL',
    healthSignal: 'outbox_backlog',
    backlogTable: 'calendar_outbox',
    backlogStatusField: 'status',
    backlogPendingValue: 'pending',
    maxBacklogAge: 10 * 60 * 1000, // 10 min — older = stuck
    dependentServices: ['postgres', 'google-calendar'],
  },
  // projection-outbox-worker: REMOVED — Base44-era projection mechanism.
  // Table exists (migration 2026-08) but has 0 writers, 0 readers, 0 runtime
  // dependencies. Backlog confirmed 0. Retired as part of Base44 retirement.
  {
    id: 'crm-frontend',
    name: 'CRM Frontend',
    project: 'ec-crm-frontend',
    environment: 'production',
    classification: 'CRITICAL_PRODUCTION',
    directUrl: process.env.CRM_PUBLIC_URL, // probes the real frontend URL, not localhost
    healthUrl: '/',
    expectedStatus: 200,
    dependentServices: [],
  },
  {
    id: 'quickbooks-integration',
    name: 'QuickBooks Integration',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER',
    healthSignal: 'qb_integration',
    dependentServices: ['postgres'],
  },
  {
    id: 'handoff-integration',
    name: 'Handoff Integration',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER',
    healthSignal: 'handoff_integration',
    dependentServices: ['postgres'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL Database',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'CRITICAL_INFRA',
    healthSignal: 'db_connection',
    dependentServices: [],
  },
];

function getCriticalServices() {
  return SERVICES.filter(s =>
    s.classification === 'CRITICAL_PRODUCTION' ||
    s.classification === 'WORKER_CRITICAL' ||
    s.classification === 'CRITICAL_INFRA'
  );
}

function getMonitoredServices() {
  return SERVICES.filter(s => s.classification !== 'LEGACY_UNUSED' && s.classification !== 'WATCHDOG');
}

function getService(id) {
  return SERVICES.find(s => s.id === id);
}

module.exports = { SERVICES, getCriticalServices, getMonitoredServices, getService };