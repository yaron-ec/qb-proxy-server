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

// qb-proxy-server's REAL listening port in production — verified two
// independent ways (both against the live Railway service, not assumed):
// (1) its public serviceDomain config reports targetPort: 8080; (2) its own
// boot log literally prints "[proxy] QuickBooks Proxy running on port 8080".
// server.js resolves this via `process.env.PORT || 3000` — so Railway sets
// PORT=8080 for this specific service; 3000 is only the in-code fallback
// for an environment with no PORT set at all (e.g. a fresh local dev run).
// ONE named constant, below, is the single source for every watchdog
// directUrl that targets qb-proxy-server, so the URL's port and the
// service's own `port` metadata field can never silently diverge again —
// exactly the bug this constant replaces: a prior fix built the directUrl
// from a stale, never-actually-exercised `port: 3000` field, which caused
// every post-fix health check to still fail, now with "fetch failed"
// (connection refused on the wrong port) instead of the original
// "fetch failed" (no route at all). See test/monitoringServiceInventoryDirectUrl.test.js
// for the regression guard against this recurring.
const QB_PROXY_SERVER_PORT = 8080;

const SERVICES = [
  {
    id: 'qb-proxy-server',
    name: 'QB Proxy Server (API)',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'CRITICAL_PRODUCTION',
    // The watchdog always runs from artistic-determination (reminderWorker.js
    // requires productionWatchdog.js inline — see that file's own header; it
    // is NOT a separate Railway service), never from qb-proxy-server itself,
    // so a bare 'http://localhost:<port>' fallback is structurally
    // unreachable — it probes the watchdog's OWN container, which has no
    // Express server at all, not qb-proxy-server's. Railway's private
    // networking resolves any other service in the same project+environment
    // at '<service-name>.railway.internal' with no extra wiring required —
    // this is the same fix pattern crm-frontend's own directUrl already
    // uses for the identical class of problem. QB_PROXY_URL/CRM_API_URL
    // (if an operator sets either) still take precedence.
    directUrl: process.env.QB_PROXY_URL || process.env.CRM_API_URL || `http://qb-proxy-server.railway.internal:${QB_PROXY_SERVER_PORT}`,
    healthUrl: '/health',
    expectedStatus: 200,
    port: QB_PROXY_SERVER_PORT,
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
    // Website Lead Intake (silence) is inbound-webhook-only — there is no
    // credential to probe, only the question "has the webhook actually
    // delivered anything recently." A generous, env-configurable silence
    // threshold (default 7 days) avoids false alarms over a quiet weekend/
    // holiday.
    //
    // FOLLOW-UP CORRECTION (production reliability audit): mere absence of
    // website leads is a marketing/activity signal, not a system failure —
    // this check alone cannot distinguish "the pipeline is broken" from
    // "the website simply had no visitors convert." See
    // lib/monitoring/healthProbes.js#checkWebsiteIntakeSilence's own header
    // for the full explanation: it now ALWAYS reports healthy, so this
    // entry never opens an incident or sends a SYSTEM_FAILURE alert over
    // silence alone; the real data is still recorded into
    // monitoring_health_checks as a queryable metric. The entry (and its
    // `maxSilenceMs` threshold) is kept so that metric keeps being computed
    // — see website-intake-rejections below for the check that CAN detect
    // and alert on a genuine delivery failure.
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
    // this is a distinct signal from the silence check above: it proves the
    // website IS attempting delivery and the CRM is refusing every attempt
    // (a rotated/mismatched WEBSITE_LEAD_WEBHOOK_SECRET, most likely), which
    // is a genuine, customer-impacting delivery failure — real website
    // leads are being dropped — not a quiet-traffic metric. Default
    // threshold: 3+ rejections within a rolling hour; the query's own
    // rolling window already absorbs "was this one stray bad request," so
    // an unhealthy result here is, by construction, already a sustained,
    // currently-active condition at probe time.
    //
    // alwaysCritical: true (follow-up correction, production reliability
    // audit) — productionWatchdog.js#handleFailure's default alert level is
    // `isCrashLoop ? 'critical' : 'warning'`, but isCrashLoop requires 3
    // failures within a 10-minute window (lib/monitoring/
    // crashLoopDetector.js), which this check's own ~15-minute probe
    // cadence can make nearly impossible to satisfy even for a real,
    // ongoing failure — leaving a genuine delivery failure stuck at
    // 'warning' indefinitely. Per explicit product requirement, a genuine
    // website-to-CRM delivery failure must always reach a 'critical' alert,
    // so this one check is explicitly marked to always alert at that level
    // on any unhealthy result, independent of the crash-loop coincidence.
    // Scoped to this entry alone — every other service's alert level is
    // completely unaffected (default behavior unchanged).
    alwaysCritical: true,
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
    // checkQbHealth calls qb-proxy-server's own /qb/health over HTTP — the
    // SAME cross-container-unreachable-localhost problem the qb-proxy-server
    // entry above has, and the same fix (see that entry's comment) — reusing
    // the SAME QB_PROXY_SERVER_PORT constant so the two entries can never
    // disagree about qb-proxy-server's real port.
    directUrl: process.env.QB_PROXY_URL || process.env.CRM_API_URL || `http://qb-proxy-server.railway.internal:${QB_PROXY_SERVER_PORT}`,
    dependentServices: ['postgres'],
  },
  {
    id: 'handoff-integration',
    name: 'Handoff Integration',
    project: 'devoted-courtesy',
    environment: 'production',
    classification: 'WORKER',
    healthSignal: 'handoff_integration',
    // checkHandoffHealth returns healthy:true WITHOUT ever making an HTTP
    // call when no direct Handoff API key is configured (see
    // lib/monitoring/healthProbes.js#checkHandoffHealth's own header — this
    // installation's current, by-design state, per CLAUDE.md), so this
    // directUrl is NOT exercised today. It is still set, for the same
    // reason as the qb-proxy-server/quickbooks-integration entries above:
    // checkHandoffHealth calls qb-proxy-server's own POST /handoff/auth/status
    // (routes/handoffSync.js, mounted on this same backend process) when a
    // key IS configured, and without an explicit directUrl that call would
    // fall back to baseUrl — unreachable from this watchdog's own container
    // (artistic-determination), the identical latent bug this follow-up fix
    // already corrected for the two entries above. Set now so a future
    // operator who configures a direct Handoff connection never rediscovers
    // the same "fetch failed" class of issue.
    directUrl: process.env.QB_PROXY_URL || process.env.CRM_API_URL || `http://qb-proxy-server.railway.internal:${QB_PROXY_SERVER_PORT}`,
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