/* eslint-disable no-undef */
/**
 * smsConsentIntake — recording a customer's SMS consent as reported by a
 * representative (phone-based New Lead intake, and a later manual update
 * from Lead Detail), built for the October 2026 "CRM New Lead Intake:
 * Appointment SMS Consent" request.
 *
 * Reuses the EXISTING leads.sms_consent / sms_consent_at / sms_consent_source
 * / sms_consent_disclosure_version columns (2026-43-website-lead-intake.sql)
 * — the SAME ONE gate lib/smsService.js#sendSms already checks for every
 * outbound CRM-triggered SMS. No second consent flag, no parallel mechanism.
 * sms_consent_recorded_by (2026-64-sms-consent-intake.sql) is the one new
 * column — WHO reported/recorded it.
 *
 * Every function here takes a plain `queryFn: (sql, params) => Promise<{rows}>`
 * rather than a client/pool object, so the SAME logic runs either inside an
 * open transaction (`client.query.bind(client)`, from
 * lib/booking/bookingService.js#createBooking — see that file's header on
 * why this must commit in the SAME transaction as the lead/appointment write,
 * never after) or standalone (the exported `query` from db/client.js, for
 * routes/leads.js's later manual-update endpoint).
 *
 * NEVER overrides an existing STOP opt-out (lib/smsService.js's own
 * independent, phone-keyed, forever rule, checked unconditionally before
 * consent on every outbound send) — granting consent=true is refused for an
 * opted-out number, with an activity note explaining why, never silently
 * granted and never silently dropped.
 */
'use strict';

const { normalizePhone } = require('./captureValidation');

const PHONE_INTAKE_CONSENT_SOURCE = 'phone call — Philippines intake representative';
const PHONE_INTAKE_DISCLOSURE_VERSION = 'phone-intake-v1';
const MANUAL_UPDATE_SOURCE = 'manual update — Lead Detail';

async function isPhoneOptedOut(queryFn, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const r = await queryFn('SELECT opted_out FROM sms_opt_outs WHERE phone_number = $1', [normalized]);
  return !!(r.rows[0] && r.rows[0].opted_out);
}

async function noteActivity(queryFn, leadId, content, author) {
  await queryFn(
    `INSERT INTO activities (lead_id, type, content, author, source) VALUES ($1, 'note', $2, $3, 'manual')`,
    [leadId, content, author || 'system']
  );
}

/**
 * Appointment-intake consent (New Lead intake form, phone-based). MUST run
 * inside the SAME transaction as the lead/appointment write when a brand-new
 * booking is being created — see bookingService.js's call site. A no-op
 * (`{applied:false, reason:'not_confirmed'}`) when the representative did not
 * check the box; this function never infers consent from a phone number or
 * an appointment existing.
 */
async function applyAppointmentSmsConsent(queryFn, leadId, { confirmed, recordedBy, source, disclosureVersion, now } = {}) {
  if (!confirmed) return { applied: false, reason: 'not_confirmed' };
  const leadRow = (await queryFn('SELECT phone FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!leadRow) return { applied: false, reason: 'lead_not_found' };
  if (!leadRow.phone) return { applied: false, reason: 'no_phone' };

  if (await isPhoneOptedOut(queryFn, leadRow.phone)) {
    await noteActivity(
      queryFn, leadId,
      'SMS consent was requested during intake, but this phone number has opted out (replied STOP) and cannot be re-consented here — the opt-out was NOT overridden.',
      recordedBy
    );
    return { applied: false, reason: 'opted_out' };
  }

  const ts = (now || new Date()).toISOString();
  await queryFn(
    `UPDATE leads SET
       sms_consent = true, sms_consent_at = $1, sms_consent_source = $2,
       sms_consent_disclosure_version = $3, sms_consent_recorded_by = $4,
       updated_at = NOW()
     WHERE id = $5`,
    [ts, source || PHONE_INTAKE_CONSENT_SOURCE, disclosureVersion || PHONE_INTAKE_DISCLOSURE_VERSION, recordedBy || null, leadId]
  );
  await noteActivity(
    queryFn, leadId,
    `SMS consent confirmed for appointment confirmations/reminders (source: ${source || PHONE_INTAKE_CONSENT_SOURCE}).`,
    recordedBy
  );
  return { applied: true };
}

/**
 * A later consent CHANGE by an authorized CRM user from Lead Detail —
 * granting (with evidence) or revoking. Never requires/assumes a prior
 * intake event; always its own clear audit entry. Revoking is always safe
 * (no opt-out check needed — it can only reduce what gets sent). Granting
 * goes through the SAME opt-out guard as intake: a STOP is never overridden
 * by a manual edit either.
 */
async function recordManualConsentChange(queryFn, leadId, { confirmed, actor, evidenceNote, now } = {}) {
  const leadRow = (await queryFn('SELECT phone FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!leadRow) return { applied: false, reason: 'lead_not_found' };

  if (confirmed) {
    if (await isPhoneOptedOut(queryFn, leadRow.phone)) {
      return { applied: false, reason: 'opted_out' };
    }
    const ts = (now || new Date()).toISOString();
    await queryFn(
      `UPDATE leads SET
         sms_consent = true, sms_consent_at = $1, sms_consent_source = $2,
         sms_consent_recorded_by = $3, updated_at = NOW()
       WHERE id = $4`,
      [ts, MANUAL_UPDATE_SOURCE, actor || null, leadId]
    );
    await noteActivity(
      queryFn, leadId,
      `SMS consent re-confirmed by ${actor || 'a CRM user'} via Lead Detail.${evidenceNote ? ` Evidence: ${evidenceNote}` : ''}`,
      actor
    );
    return { applied: true };
  }

  const ts = (now || new Date()).toISOString();
  await queryFn(
    `UPDATE leads SET
       sms_consent = false, sms_consent_at = $1, sms_consent_source = $2,
       sms_consent_recorded_by = $3, updated_at = NOW()
     WHERE id = $4`,
    [ts, MANUAL_UPDATE_SOURCE, actor || null, leadId]
  );
  await noteActivity(
    queryFn, leadId,
    `SMS consent revoked by ${actor || 'a CRM user'} via Lead Detail.${evidenceNote ? ` Reason: ${evidenceNote}` : ''}`,
    actor
  );
  return { applied: true };
}

module.exports = {
  applyAppointmentSmsConsent, recordManualConsentChange, isPhoneOptedOut,
  PHONE_INTAKE_CONSENT_SOURCE, PHONE_INTAKE_DISCLOSURE_VERSION, MANUAL_UPDATE_SOURCE,
};
