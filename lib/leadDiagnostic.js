/* eslint-disable no-undef */
/**
 * leadDiagnostic — READ-ONLY, single-lead diagnostic bundle for
 * routes/systemHealth.js's `GET /lead-diagnostic/:id`.
 *
 * Built as the "safe authenticated production diagnostic mechanism" that
 * can answer a Follow-Up/Appointment integrity question for ONE specific
 * lead without exposing DB credentials to the caller (the caller only ever
 * gets a JSON response over the existing admin/CI-OIDC-authenticated
 * System Health endpoint — see lib/systemHealthAuth.js) and without any
 * possibility of mutation (every query here is a plain SELECT; this module
 * exports no write function and takes no write-shaped input).
 *
 * Gathers, in one call:
 *   - the lead's own row (including the canonical follow_up_* fields)
 *   - every appointment ever created for the lead (not just the active
 *     one) with its full appointment_events history
 *   - the lead's activity history
 *   - reminder state: reminder_leads projection row + reminder_claims +
 *     the Phone Call non-blocking calendar reminder row
 *   - calendar_outbox rows for every appointment, and
 *     google_contacts_outbox rows for the lead (calendar/outbox linkage)
 *   - a deterministic classification of the follow-up/appointment
 *     relationship, reusing the SAME classify()/assess()/provenance()
 *     functions scripts/auditAppointmentFollowUp.js already uses (and
 *     test/auditAppointmentFollowUpClassifier.test.js already covers) —
 *     this is not new ad hoc logic, it is the existing, tested classifier
 *     invoked for one lead instead of a full-table sweep.
 */
'use strict';

const { serializeAppointment } = require('./booking/appointmentView');
const { classify, assess, provenance } = require('../scripts/auditAppointmentFollowUp');

const APPT_SQL = `
  SELECT a.*, t.name AS type_name, lower(a.busy_range) AS busy_start, upper(a.busy_range) AS busy_end,
         (SELECT min(e.created_at) FROM appointment_events e WHERE e.appointment_id = a.id AND e.action = 'created') AS created_event_at,
         (SELECT e.actor FROM appointment_events e WHERE e.appointment_id = a.id AND e.action = 'created' ORDER BY e.created_at LIMIT 1) AS created_event_actor
    FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id`;

async function getLeadDiagnostic(pool, leadId) {
  const leadRes = await pool.query(
    `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`,
    [leadId]
  );
  const lead = leadRes.rows[0];
  if (!lead) return null;

  const allAppts = (await pool.query(`${APPT_SQL} WHERE a.lead_id = $1 ORDER BY a.created_at ASC`, [leadId])).rows;
  const activeAppts = allAppts.filter((a) => a.status === 'scheduled' || a.status === 'confirmed');

  const apptIds = allAppts.map((a) => a.id);
  const eventsByAppt = new Map();
  if (apptIds.length) {
    const evs = (await pool.query(
      `SELECT appointment_id, actor, action, previous_values, new_values, created_at
         FROM appointment_events WHERE appointment_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
      [apptIds]
    )).rows;
    for (const e of evs) {
      const k = String(e.appointment_id);
      if (!eventsByAppt.has(k)) eventsByAppt.set(k, []);
      eventsByAppt.get(k).push({ actor: e.actor, action: e.action, previous_values: e.previous_values, new_values: e.new_values, created_at: e.created_at });
    }
  }

  const activities = (await pool.query(
    `SELECT type, content, author, source, created_at FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [leadId]
  )).rows;

  const reminderLeadsRow = (await pool.query(`SELECT * FROM reminder_leads WHERE id = $1`, [String(leadId)])).rows[0] || null;
  const reminderClaims = (await pool.query(
    `SELECT reminder_key, appointment_date, reminder_window, status, attempts, last_error, last_error_type, sent_at, created_at, updated_at
       FROM reminder_claims WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [String(leadId)]
  )).rows;
  const followupCalendarReminder = (await pool.query(
    `SELECT google_event_id, generation, status, followup_kind, start_at, owner_email, fingerprint, attempts, last_error, synced_at, created_at, updated_at
       FROM followup_calendar_reminders WHERE lead_id = $1`,
    [leadId]
  )).rows[0] || null;

  let calendarOutboxRows = [];
  if (apptIds.length) {
    calendarOutboxRows = (await pool.query(
      `SELECT appointment_id, action, status, attempts, last_error, google_event_id, created_at, updated_at
         FROM calendar_outbox WHERE appointment_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
      [apptIds]
    )).rows;
  }
  const contactsOutboxRows = (await pool.query(
    `SELECT status, attempts, last_error, next_attempt_at, created_at, updated_at
       FROM google_contacts_outbox WHERE lead_id = $1 ORDER BY created_at DESC`,
    [leadId]
  ).catch(() => ({ rows: [] }))).rows;

  // Reuse the SAME classifier scripts/auditAppointmentFollowUp.js uses for
  // its full-table sweep — this lead is just the population of one.
  const classifierLead = {
    id: lead.id, external_ref: lead.external_ref, first_name: lead.first_name, last_name: lead.last_name,
    status: lead.status, created_at: lead.created_at,
    follow_up_date: lead.follow_up_date, follow_up_time: lead.follow_up_time, follow_up_type: lead.follow_up_type,
    follow_up_notes: lead.follow_up_notes, follow_up_status: lead.follow_up_status,
  };
  const classification = assess(classifierLead, activeAppts);

  return {
    lead: {
      id: lead.id, external_ref: lead.external_ref, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      status: lead.status, source: lead.source, owner_email: lead.owner_email,
      created_at: lead.created_at, updated_at: lead.updated_at,
    },
    canonical_follow_up: {
      date: lead.follow_up_date, time: lead.follow_up_time, type: lead.follow_up_type,
      notes: lead.follow_up_notes, status: lead.follow_up_status,
    },
    // Legacy denormalized columns some older paths still read (see
    // lib/authorization.js etc.) — included for completeness; the
    // appointments array below is authoritative for the real record.
    legacy_appointment_columns: { date: lead.appointment_date || null, time: lead.appointment_time || null },
    appointments: allAppts.map((a) => {
      const s = serializeAppointment(a);
      return {
        id: a.id, status: a.status, kind: s.kind, date: s.date, time: s.time,
        duration_minutes: s.duration_minutes, start_at: a.start_at, end_at: a.end_at,
        calendar_sync_status: a.calendar_sync_status, google_event_id: a.google_event_id,
        google_travel_event_id: a.google_travel_event_id, calendar_last_error: a.calendar_last_error,
        idempotency_key: a.idempotency_key, created_at: a.created_at, updated_at: a.updated_at,
        created_by: a.created_event_actor || null,
        events: eventsByAppt.get(String(a.id)) || [],
      };
    }),
    activities,
    reminders: {
      reminder_leads_row: reminderLeadsRow,
      reminder_claims: reminderClaims,
      phone_call_calendar_reminder: followupCalendarReminder,
    },
    calendar_outbox: calendarOutboxRows,
    contacts_outbox: contactsOutboxRows,
    classification: classification
      ? { class: classification.cls, sub: classification.sub, would_auto_apply: classification.apply, reason: classification.reason, provenance: classification.prov }
      : { class: 'NONE', sub: 'NONE', would_auto_apply: false, reason: 'no active appointment and no dated Meeting/Phone Call follow-up', provenance: null },
  };
}

module.exports = { getLeadDiagnostic };
