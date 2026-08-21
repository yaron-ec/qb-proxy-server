/* eslint-disable no-undef */
/**
 * Shared lead validation + upsert for the Railway reminder ingestion path.
 *
 * Used by the HTTP upsert endpoint (lib/leadIngestRouter.js) and the one-time
 * importer (db/importLeads.js). This single module is the ONLY place that
 * validates and writes a lead into the reminder_leads table, so the endpoint
 * and the importer can never drift apart.
 *
 * Contract:
 *   - imports NEITHER lib/base44.js NOR lib/gmailSender.js
 *   - creates NO reminder claims
 *   - sends NO emails
 *   - logs NO customer PII (callers log only the lead id + action)
 *
 * All appointment date/time values are interpreted as America/Los_Angeles
 * (Pacific) by the reminder engine (lib/reminderTime.js). This module stores
 * them verbatim as 'YYYY-MM-DD' / 'HH:MM' strings, exactly as the engine
 * expects — no timezone column is stored because the engine never reads one.
 */
'use strict';

const repDir = require('./repDirectory');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function str(v) {
  return v == null ? null : String(v);
}

// Accept 'YYYY-MM-DD' verbatim, or an ISO datetime, or a Date-parseable string.
// Always returns 'YYYY-MM-DD' (the engine's expected format) or null.
function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (DATE_RE.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// Accept '9:00' or '09:00'; always return 'HH:MM' or null.
function normalizeTime(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':');
    s = `${h.padStart(2, '0')}:${m}`;
  }
  return TIME_RE.test(s) ? s : null;
}

function boolish(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  return String(v).toLowerCase() === 'true';
}

/**
 * Validate and normalize a single lead payload.
 * @returns {{ ok: true, lead: object } | { ok: false, errors: string[] }}
 */
function validateAndNormalizeLead(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const errors = [];

  const id = str(input.id);
  const firstName = str(input.first_name);
  const lastName = str(input.last_name);
  if (!id) errors.push('id is required');
  if (!firstName) errors.push('first_name is required');
  if (!lastName) errors.push('last_name is required');

  const followUpDate = normalizeDate(input.follow_up_date);
  const appointmentDate = normalizeDate(input.appointment_date);
  // The engine needs at least one appointment source to compute a reminder time.
  if (!followUpDate && !appointmentDate) {
    errors.push('at least one of follow_up_date or appointment_date is required');
  }

  if (errors.length) return { ok: false, errors };

  const lead = {
    id,
    first_name: firstName,
    last_name: lastName,
    email: str(input.email),
    phone: str(input.phone),
    property_address: str(input.property_address),
    city: str(input.city),
    project_type: str(input.project_type),
    follow_up_date: followUpDate,
    follow_up_time: normalizeTime(input.follow_up_time),
    follow_up_type: str(input.follow_up_type),
    appointment_date: appointmentDate,
    appointment_time: normalizeTime(input.appointment_time),
    assigned_rep: str(input.assigned_rep),
    budget_range: str(input.budget_range),
    notes: str(input.notes),
    customer_reminders_disabled: boolish(input.customer_reminders_disabled),
    crm_created_date: input.crm_created_date ? new Date(input.crm_created_date).toISOString() : null,
  };

  // Representative snapshot, stored at ingestion time so the reminder action
  // flow never reads representative data from Base44.
  const _rep = repDir.getRepContact(lead.assigned_rep);
  lead.assigned_rep_name = _rep.name;
  lead.assigned_rep_email = _rep.email;
  lead.assigned_rep_phone = _rep.directPhone;

  return { ok: true, lead };
}

// Idempotent upsert by external lead id. (xmax = 0) is true only on a fresh
// INSERT (no conflicting row was updated), so we can report created vs updated.
const UPSERT_SQL = `
  INSERT INTO reminder_leads
    (id, first_name, last_name, email, phone, property_address, city, project_type,
     follow_up_date, follow_up_time, follow_up_type, appointment_date, appointment_time,
     assigned_rep, assigned_rep_name, assigned_rep_email, assigned_rep_phone,
     budget_range, notes, customer_reminders_disabled, crm_created_date)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
  ON CONFLICT (id) DO UPDATE SET
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    email = EXCLUDED.email,
    phone = EXCLUDED.phone,
    property_address = EXCLUDED.property_address,
    city = EXCLUDED.city,
    project_type = EXCLUDED.project_type,
    follow_up_date = EXCLUDED.follow_up_date,
    follow_up_time = EXCLUDED.follow_up_time,
    follow_up_type = EXCLUDED.follow_up_type,
    appointment_date = EXCLUDED.appointment_date,
    appointment_time = EXCLUDED.appointment_time,
    assigned_rep = EXCLUDED.assigned_rep,
    assigned_rep_name = EXCLUDED.assigned_rep_name,
    assigned_rep_email = EXCLUDED.assigned_rep_email,
    assigned_rep_phone = EXCLUDED.assigned_rep_phone,
    budget_range = EXCLUDED.budget_range,
    notes = EXCLUDED.notes,
    customer_reminders_disabled = EXCLUDED.customer_reminders_disabled,
    crm_created_date = COALESCE(EXCLUDED.crm_created_date, reminder_leads.crm_created_date),
    updated_at = NOW()
  RETURNING (xmax = 0) AS inserted`;

/**
 * @param {import('../db/client')} db
 * @param {object} lead — output of validateAndNormalizeLead
 * @returns {Promise<{ action: 'created'|'updated', id: string }>}
 */
async function upsertLead(db, lead) {
  const { rows } = await db.query(UPSERT_SQL, [
    lead.id, lead.first_name, lead.last_name, lead.email, lead.phone,
    lead.property_address, lead.city, lead.project_type, lead.follow_up_date,
    lead.follow_up_time, lead.follow_up_type, lead.appointment_date, lead.appointment_time,
    lead.assigned_rep, lead.assigned_rep_name, lead.assigned_rep_email, lead.assigned_rep_phone,
    lead.budget_range, lead.notes, lead.customer_reminders_disabled,
    lead.crm_created_date,
  ]);
  const inserted = !!(rows[0] && rows[0].inserted);
  return { action: inserted ? 'created' : 'updated', id: lead.id };
}

module.exports = { validateAndNormalizeLead, upsertLead };