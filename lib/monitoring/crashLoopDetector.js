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

const db = require('../db/client');

const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000; // 10 min
const CRASH_LOOP_THRESHOLD = 3;

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

async function shouldAlert(serviceId, incident) {
  // Alert only on: new incident, crash loop transition, or every 5th failure (anti-spam)
  if (!incident) return false;
  if (incident.alert_count === 0) return true;
  if (incident.failure_count % 5 === 0) return true;
  return false;
}

async function markAlertSent(incidentId) {
  await db.query(
    `UPDATE monitoring_incidents SET alert_sent_at = NOW(), alert_count = alert_count + 1 WHERE id = $1`,
    [incidentId]
  );
}

module.exports = {
  recordFailure, recordSuccess, getOpenIncidents, shouldAlert, markAlertSent,
  CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD,
};