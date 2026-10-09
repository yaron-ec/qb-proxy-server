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
    dependentServices: ['postgres', 'gmail-integration'],
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
    // This probe's own backlog check IS the Google Calendar sync-health
    // signal (a stuck calendar_outbox backlog IS a Calendar sync failure) —
    // there is no separate 'google-calendar' service to depend on.
    dependentServices: ['postgres'],
  },
  {
    // noble-illumination also drains google_contacts_outbox (same worker
    // process as calendar-outbox-worker, different queue table) — CRM
    // STABILITY PHASE final audit: Google Contacts sync had NO independent
    // stuck/failed-backlog detection before this, unlike Calendar's
    // identical-shaped queue. Mirrors calendar-outbox-worker's own check.
    id: 'google-contacts-outbox',
    name: 'Google Contacts Outbox (noble-illumination)',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER_CRITICAL',
    healthSignal: 'google_contacts_outbox_backlog',
    // Bounded exponential backoff (lib/googleContactsOutbox.js) caps at
    // 1800s between the 5th retry and dead-lettering — 30 min gives a wide
    // margin over normal backoff/retry timing before calling it "stuck."
    maxBacklogAge: 30 * 60 * 1000,
    dependentServices: ['postgres'],
  },
  {
    // Gmail has no live-call-free "is the token still valid" signal the way
    // QuickBooks does (access/refresh expiry tracked locally) — but
    // last_error_at vs last_used_at on the stored credential (written by
    // lib/gmailSender.js on every real send/refresh) is a genuine, free,
    // no-network proxy for "has sending/refreshing started failing since
    // the last success." module-aware: skips (reports healthy) when the
    // gmail module is disabled for this installation, so a company that
    // doesn't use Gmail never gets a false alarm.
    id: 'gmail-integration',
    name: 'Gmail Integration',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER',
    healthSignal: 'gmail_integration',
    dependentServices: ['postgres'],
  },
  {
    // Website Lead Intake is inbound-webhook-only — there is no credential
    // to probe, only the question "has the webhook actually delivered
    // anything recently." A generous, env-configurable silence threshold
    // (default 7 days) avoids false alarms over a quiet weekend/holiday
    // while still catching a genuinely broken delivery (secret rotated,
    // website-side outage). Module-aware and only engages once at least one
    // real receipt has ever been recorded (never alarms a fresh install
    // that hasn't gone live yet).
    id: 'website-intake',
    name: 'Website Lead Intake',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER',
    healthSignal: 'website_intake_silence',
    maxSilenceMs: Number(process.env.WEBSITE_INTAKE_SILENCE_THRESHOLD_MS) || 7 * 24 * 60 * 60 * 1000,
    dependentServices: ['postgres'],
  },
  {
    // A sustained burst of REJECTED website-lead deliveries — see
    // lib/monitoring/healthProbes.js#checkWebsiteIntakeRejections for why
    // this is a distinct signal from the silence check above. Default
    // threshold: 3+ rejections within a rolling hour.
    id: 'website-intake-rejections',
    name: 'Website Lead Intake (rejected deliveries)',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER',
    healthSignal: 'website_intake_rejections',
    windowMs: Number(process.env.WEBSITE_INTAKE_REJECTION_WINDOW_MS) || 60 * 60 * 1000,
    threshold: Number(process.env.WEBSITE_INTAKE_REJECTION_THRESHOLD) || 3,
    dependentServices: ['postgres'],
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
    directUrl: process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com', // probes the real frontend URL, not localhost
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
  // NOT monitored here, by deliberate audit decision (CRM STABILITY PHASE
  // final audit), not an oversight:
  //   - SignNow: in the primary SIGNNOW_API_KEY auth mode (this
  //     installation's configured mode) there is no locally-tracked
  //     expiry/refresh state to probe cheaply the way QuickBooks's
  //     access/refresh token expiry is — a bearer key is valid until
  //     revoked, with no local signal of that happening. A genuine
  //     connectivity check requires a live SignNow API call (already
  //     available on demand via GET /api/v1/system/info?verify=1 /
  //     lib/signnowClient.js#checkConnection) — fabricating a cheap probe
  //     with no real signal behind it would be dishonest, not helpful.
  //   - Meta Lead Ads: META_APP_SECRET is unset in production today (see
  //     GET /api/v1/system/info) — monitoring an integration nobody has
  //     configured would just generate permanent noise, not a real signal.
  //     Add a service entry here if/when Meta is actually configured.
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