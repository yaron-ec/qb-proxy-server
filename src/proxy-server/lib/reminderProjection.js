/* eslint-disable no-undef */
/**
 * reminderProjection — the SINGLE shared module that projects canonical Railway
 * `leads` rows into the derived `reminder_leads` table.
 *
 * `leads` remains the canonical source of truth. `reminder_leads` is a derived
 * projection used ONLY by the reminder engine. This module is the ONLY place
 * that performs the projection from CRM mutation paths, so every route calls
 * the same function and they can never drift apart.
 *
 * Identifier contract:
 *   reminder_leads.id = lead.external_ref || lead.id
 *   - Legacy Base44 leads: external_ref is the Base44 UUID → use it.
 *   - Railway-native leads: external_ref is NULL → use the Railway UUID (lead.id).
 *   This guarantees ONE stable reminder identity per lead, regardless of origin.
 *
 * Transactional safety:
 *   syncLeadToReminders accepts a transaction client. When called inside the
 *   same transaction as the canonical lead mutation, the projection commits
 *   atomically with the mutation — it can never silently remain stale.
 *   If the projection fails, the transaction rolls back (no partial mutation).
 *
 * Clearing behavior:
 *   When a lead has NO follow_up_date AND NO appointment_date, the reminder
 *   fields are NULLed in reminder_leads so the engine stops scheduling.
 *   customer_reminders_disabled and contact fields are preserved (the row is
 *   not deleted — only the appointment-triggering fields are cleared).
 *
 * Removal behavior:
 *   removeFromReminders deletes the reminder_leads row entirely. Called on
 *   lead deletion so no stale reminder data survives the canonical record.
 *
 * Contract (same as leadIngest):
 *   - imports NEITHER base44 NOR gmailSender
 *   - creates NO reminder claims
 *   - sends NO emails
 *   - logs NO customer PII (callers log only the lead id + action)
 */
'use strict';

const { validateAndNormalizeLead, upsertLead } = require('./leadIngest');

/**
 * Compute the stable reminder identity for a canonical lead row.
 * @param {object} leadRow — must have external_ref (nullable) and id
 * @returns {string} the reminder_leads.id
 */
function reminderIdFor(leadRow) {
  return leadRow.external_ref || leadRow.id;
}

/**
 * Project one canonical lead row into reminder_leads.
 *
 * @param {object} db — a transaction client (client.query) OR { query } from db/client
 * @param {object} leadRow — full lead row with owner join. Required fields:
 *   id, external_ref, first_name, last_name, email, phone, property_address,
 *   city, project_type, follow_up_date, follow_up_time, follow_up_type,
 *   appointment_date, appointment_time, owner_display_name (or assigned_rep),
 *   budget_range, notes, customer_reminders_disabled, crm_created_date, created_at
 * @returns {Promise<{action: 'synced'|'cleared', id: string}>}
 * @throws if validation fails (dates present but required fields missing) —
 *   caller should let this propagate to roll back the transaction.
 */
async function syncLeadToReminders(db, leadRow) {
  if (!leadRow) throw new Error('syncLeadToReminders: leadRow is required');

  const rid = reminderIdFor(leadRow);
  if (!rid) throw new Error('syncLeadToReminders: cannot resolve reminder id (no external_ref and no id)');

  const hasDates = leadRow.follow_up_date || leadRow.appointment_date;

  if (hasDates) {
    // Validate + upsert. If validation fails (shouldn't happen — first_name/
    // last_name are NOT NULL in leads), throw so the transaction rolls back.
    const validation = validateAndNormalizeLead({
      id: rid,
      first_name: leadRow.first_name,
      last_name: leadRow.last_name,
      email: leadRow.email,
      phone: leadRow.phone,
      property_address: leadRow.property_address,
      city: leadRow.city,
      project_type: leadRow.project_type,
      follow_up_date: leadRow.follow_up_date,
      follow_up_time: leadRow.follow_up_time,
      follow_up_type: leadRow.follow_up_type,
      appointment_date: leadRow.appointment_date,
      appointment_time: leadRow.appointment_time,
      assigned_rep: leadRow.owner_display_name || leadRow.assigned_rep || null,
      budget_range: leadRow.budget_range,
      notes: leadRow.notes,
      customer_reminders_disabled: leadRow.customer_reminders_disabled,
      crm_created_date: leadRow.crm_created_date || leadRow.created_at,
    });
    if (!validation.ok) {
      throw new Error(`reminder projection validation failed for ${rid}: ${validation.errors.join(', ')}`);
    }
    await upsertLead(db, validation.lead);
    return { action: 'synced', id: rid };
  }

  // No dates — clear appointment-triggering fields so the engine stops scheduling.
  // No-op if the row doesn't exist (0 rows affected). Preserves contact fields
  // and customer_reminders_disabled in case the lead gets a new appointment later.
  await db.query(
    `UPDATE reminder_leads
        SET follow_up_date = NULL, follow_up_time = NULL, follow_up_type = NULL,
            appointment_date = NULL, appointment_time = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [rid]
  );
  return { action: 'cleared', id: rid };
}

/**
 * Remove a lead's reminder projection entirely (on lead deletion).
 *
 * @param {object} db — transaction client or { query }
 * @param {object} leadRow — must have external_ref (nullable) and id
 * @returns {Promise<{deleted: true, id: string}>}
 */
async function removeFromReminders(db, leadRow) {
  if (!leadRow) return { deleted: false };
  const rid = reminderIdFor(leadRow);
  if (!rid) return { deleted: false };
  await db.query('DELETE FROM reminder_leads WHERE id = $1', [rid]);
  return { deleted: true, id: rid };
}

module.exports = { syncLeadToReminders, removeFromReminders, reminderIdFor };