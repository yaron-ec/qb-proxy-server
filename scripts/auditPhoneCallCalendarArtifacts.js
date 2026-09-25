/* eslint-disable no-undef */
'use strict';
/**
 * auditPhoneCallCalendarArtifacts.js — production audit + safe repair for the
 * "Phone Call treated as blocking" defect (see lib/booking/appointmentWriter.js,
 * lib/booking/availabilityService.js, lib/booking/googleAvailability.js).
 *
 * Code-path analysis found NO write path that creates a travel/buffer Google
 * Calendar event for a Phone Call (lib/booking/calendarOutbox.js's
 * enqueueCreate/enqueueUpdate both correctly skip the travel event when
 * skipTravel/isPhoneCallAppointment is true) — so this is not expected to
 * find real travel artifacts. It exists to PROVE that against real production
 * data rather than assume it, and to fix the one thing that DOES need a
 * retroactive repair: any Phone Call appointment that already has a synced
 * Google main event was synced BEFORE this fix, so its Google event lacks
 * the new ec_appointment_kind='phone_call' marker — until repaired, Google
 * Calendar read-back still misclassifies it as blocking (the same bug the
 * code fix addresses, just for already-existing calendar events).
 *
 * IDENTITY: only appointments where lower(busy_range) = start_at (the
 * canonical Phone Call shape, active status) are ever touched. A real
 * Appointment/Meeting (lower(busy_range) < start_at) is never selected by
 * this query, so it can never be affected.
 *
 * REPAIR (only with APPLY=1): reuses the EXISTING canonical
 * calendarOutbox.enqueueUpdate(..., skipTravel=true) for each affected
 * appointment — the same function every normal Phone Call update already
 * goes through. This (a) re-pushes the main event with the new marker and
 * (b) enqueues a cancel for google_travel_event_id if one is somehow set
 * (the smoking gun for an actual invalid artifact). No ad-hoc Google API
 * calls, no direct DELETE — only the durable, already-tested outbox path.
 * The calendar_outbox worker processes the enqueued rows on its own
 * schedule; this script never calls the Google API directly.
 *
 * READ-ONLY by default. Pass APPLY=1 (env) to enqueue repairs.
 * Environment: DATABASE_URL.
 */
const { pool, query } = require('../db/client');
const calendarOutbox = require('./../lib/booking/calendarOutbox');

async function findAffected() {
  // Canonical Phone Call shape: lower(busy_range) = start_at (no buffer) —
  // the SAME predicate now used by availabilityService.js and appointmentWriter.js.
  const { rows } = await query(
    `SELECT a.id, a.lead_id, a.owner_id, a.start_at, a.end_at, a.timezone, a.version,
            a.google_event_id, a.google_travel_event_id, a.busy_range,
            l.first_name, l.last_name, l.email, l.phone, l.property_address, l.city, l.project_type,
            o.email AS owner_email
     FROM appointments a
     LEFT JOIN leads l ON l.id = a.lead_id
     LEFT JOIN owners o ON o.id = a.owner_id
     WHERE a.status IN ('scheduled','confirmed')
       AND lower(a.busy_range) = a.start_at
       AND a.google_event_id IS NOT NULL`,
    []
  );
  return rows;
}

async function main() {
  const apply = process.env.APPLY === '1';
  console.log('=== PHONE CALL CALENDAR ARTIFACT AUDIT ===');
  console.log('Mode: ' + (apply ? 'APPLY (enqueues repairs via the canonical outbox path)' : 'DRY-RUN (read-only)'));
  console.log('');

  const affected = await findAffected();
  console.log('Active, already-synced Phone Call appointments found: ' + affected.length);
  const withTravelArtifact = affected.filter(a => a.google_travel_event_id);
  console.log('  Of those, with a google_travel_event_id set (an ACTUAL invalid travel artifact): ' + withTravelArtifact.length);
  for (const a of withTravelArtifact) {
    console.log('    appointment ' + a.id + ' lead ' + a.lead_id + ' start_at ' + a.start_at + ' google_travel_event_id ' + a.google_travel_event_id);
  }
  console.log('  Remaining (' + (affected.length - withTravelArtifact.length) + '): main event synced before this fix, no travel artifact — only need the retroactive ec_appointment_kind marker.');
  console.log('');

  if (!apply) {
    console.log('DRY-RUN: no writes performed. Pass APPLY=1 to enqueue repairs for the ' + affected.length + ' appointment(s) above.');
    return { affected: affected.length, withTravelArtifact: withTravelArtifact.length, applied: false };
  }

  let repaired = 0, errors = 0;
  for (const appt of affected) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-verify identity immediately before mutation (still a Phone Call, still active).
      const check = await client.query(
        `SELECT id, status, start_at, version, google_event_id, google_travel_event_id,
                lower(busy_range) AS busy_start
         FROM appointments WHERE id = $1 FOR UPDATE`,
        [appt.id]
      );
      const row = check.rows[0];
      if (!row || !['scheduled', 'confirmed'].includes(row.status)) {
        await client.query('ROLLBACK'); continue;
      }
      const stillPhoneCall = new Date(row.busy_start).getTime() === new Date(row.start_at).getTime();
      if (!stillPhoneCall) { await client.query('ROLLBACK'); continue; }

      const newVersion = (row.version || 1) + 1;
      await client.query(
        `UPDATE appointments SET version = $1, calendar_sync_status = 'pending', updated_at = NOW() WHERE id = $2`,
        [newVersion, appt.id]
      );
      const lead = {
        first_name: appt.first_name, last_name: appt.last_name, email: appt.email, phone: appt.phone,
        property_address: appt.property_address, city: appt.city, project_type: appt.project_type,
      };
      const fullAppt = { ...appt, version: newVersion, google_event_id: row.google_event_id, google_travel_event_id: row.google_travel_event_id };
      // skipTravel=true: re-pushes the main event with the new marker AND
      // cancels google_travel_event_id if one is set — the canonical path.
      await calendarOutbox.enqueueUpdate(client, fullAppt, lead, appt.owner_email, newVersion, true);
      await client.query('COMMIT');
      repaired++;
      console.log('  repaired (enqueued): appointment ' + appt.id);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      errors++;
      console.error('  FAILED: appointment ' + appt.id + ': ' + e.message);
    } finally {
      client.release();
    }
  }
  console.log('');
  console.log('Repairs enqueued: ' + repaired + ', errors: ' + errors + '. The calendar_outbox worker will process them on its normal schedule.');
  return { affected: affected.length, withTravelArtifact: withTravelArtifact.length, applied: true, repaired, errors };
}

module.exports = { findAffected, main };

if (require.main === module) {
  main().then(() => pool.end()).catch(e => { console.error('FATAL:', e); pool.end().finally(() => process.exit(1)); });
}
