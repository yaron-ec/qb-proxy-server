/* eslint-disable no-undef */
/**
 * crashLoopDetector — tracks repeated failures per service using the
 * monitoring_incidents table. Prevents alert spam: one alert per incident,
 * updates only when state materially changes.
 *
 * Crash loop threshold: 3 failures within 10 minutes → CRASH_LOOP = YES
 * → no further blind restart → escalate.
 *
 * Incident lifecycle:
 *   open   → failure detected, alert dispatched
 *   resolved → health restored, resolution alert dispatched
 */
'use strict';

const db = require('../../db/client');

const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000; // 10 min
const CRASH_LOOP_THRESHOLD = 3;

// November 2026 production incident: a long-lived, externally-blocked
// incident (QuickBooks monthly quota exhaustion) was re-alerting roughly
// once an hour for as long as it stayed open, because the PREVIOUS rule
// ("every 5th failed probe") is a count, not a clock — at this watchdog's
// ~15-30 minute probe cadence, 5 ticks is only ~75-150 minutes, repeating
// for as long as the incident remains open (which, for an externally
// blocked incident, can be days). ALERT_COOLDOWN_MS replaces that count
// with an explicit 24h wall-clock reminder cadence for a persistent,
// unchanged incident — see shouldAlert() below for the full policy.
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

async function recordFailure(serviceId, errorSummary, errorType, metadata = {}) {
  const now = new Date();
  // Find existing open incident for this service
  const { rows } = await db.query(
    `SELECT * FROM monitoring_incidents WHERE service_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1`,
    [serviceId]
  );
  let incident = rows[0];

  if (!incident) {
    // Open new incident
    const inserted = await db.query(
      `INSERT INTO monitoring_incidents (service_id, status, failure_count, first_failure_at, last_failure_at, last_error_summary, last_error_type, metadata)
       VALUES ($1, 'open', 1, NOW(), NOW(), $2, $3, $4)
       RETURNING *`,
      [serviceId, errorSummary, errorType, JSON.stringify(metadata)]
    );
    return { incident: inserted.rows[0], isNew: true, isCrashLoop: false };
  }

  // Increment existing incident
  const newCount = incident.failure_count + 1;
  const firstMs = new Date(incident.first_failure_at).getTime();
  const isCrashLoop = newCount >= CRASH_LOOP_THRESHOLD && (now.getTime() - firstMs) < CRASH_LOOP_WINDOW_MS;

  const updated = await db.query(
    `UPDATE monitoring_incidents SET
       failure_count = $2, last_failure_at = NOW(),
       last_error_summary = $3, last_error_type = $4, metadata = $5
     WHERE id = $1 RETURNING *`,
    [incident.id, newCount, errorSummary, errorType, JSON.stringify(metadata)]
  );

  return { incident: updated.rows[0], isNew: false, isCrashLoop };
}

async function recordSuccess(serviceId) {
  const { rows } = await db.query(
    `SELECT * FROM monitoring_incidents WHERE service_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1`,
    [serviceId]
  );
  const incident = rows[0];
  if (!incident) return { resolved: false };

  await db.query(
    `UPDATE monitoring_incidents SET status = 'resolved', resolved_at = NOW() WHERE id = $1`,
    [incident.id]
  );
  return { resolved: true, incident };
}

async function getOpenIncidents() {
  const { rows } = await db.query(
    `SELECT * FROM monitoring_incidents WHERE status = 'open' ORDER BY last_failure_at DESC`
  );
  return rows;
}

/**
 * shouldAlert — the ONE place this codebase decides whether a given
 * watchdog tick's failure is worth a human notification. Previously this
 * logic was duplicated inline in BOTH productionWatchdog.js#handleFailure
 * AND routes/cronJobs.js's /diagnose-watchdog route (the exact kind of
 * drift this codebase has paid for before — see lib/qbEnvironment.js's own
 * header) — both call sites now delegate here instead.
 *
 * Policy (approved November 2026, replacing the old count-based "every 5th
 * failure" rule):
 *   1. A brand-new incident always alerts immediately.
 *   2. A crash-loop transition always alerts immediately (existing rule,
 *      unchanged).
 *   3. A GENUINELY DIFFERENT failure for the same still-open incident
 *      (e.g. quota_exhausted -> reconnect_required) always alerts
 *      immediately, even if the 24h cooldown hasn't elapsed — detected by
 *      comparing against `last_alerted_error_type` (the category as of the
 *      LAST alert, persisted in monitoring_incidents, durable across
 *      worker restarts/deployments), never a changing value like a raw
 *      error message or a reopen counter (both would make an UNCHANGED
 *      incident look "different" on every single tick and defeat the
 *      cooldown entirely).
 *   4. Otherwise (the same incident, the same failure category, already
 *      alerted at least once): alert again only once ALERT_COOLDOWN_MS
 *      (24h) has elapsed since the last alert — "at most one consolidated
 *      status reminder every 24 hours" for a persistent, unchanged
 *      incident.
 *
 * Pure/synchronous — operates only on the already-fetched `incident` row
 * (recordFailure's own UPDATE already applied this tick's values before
 * this is called), no DB access of its own.
 */
function shouldAlert(incident, { isNew = false, isCrashLoop = false, newErrorType = null } = {}) {
  if (!incident) return false;
  if (isNew) return true;
  if (isCrashLoop) return true;
  if (newErrorType && incident.last_alerted_error_type && newErrorType !== incident.last_alerted_error_type) {
    return true;
  }
  if (!incident.alert_sent_at) return true; // defensive — isNew should already cover the first-ever alert
  const elapsedMs = Date.now() - new Date(incident.alert_sent_at).getTime();
  return elapsedMs >= ALERT_COOLDOWN_MS;
}

// errorType: the SAME stable category passed as `newErrorType` to
// shouldAlert() for this alert — persisted so the NEXT tick's comparison
// (rule 3 above) has something durable to compare against. Optional and
// backward-compatible: an omitted/null value leaves the column exactly as
// it was (COALESCE), so a caller that doesn't yet have a category to
// report never erases a previously-recorded one.
async function markAlertSent(incidentId, errorType = null) {
  await db.query(
    `UPDATE monitoring_incidents SET alert_sent_at = NOW(), alert_count = alert_count + 1, last_alerted_error_type = COALESCE($2, last_alerted_error_type) WHERE id = $1`,
    [incidentId, errorType]
  );
}

module.exports = {
  recordFailure, recordSuccess, getOpenIncidents, shouldAlert, markAlertSent,
  CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD, ALERT_COOLDOWN_MS,
};