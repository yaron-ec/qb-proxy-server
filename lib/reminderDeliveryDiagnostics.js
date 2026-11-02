/* eslint-disable no-undef */
/**
 * reminderDeliveryDiagnostics — shared, read-only reminder/SMS delivery
 * tracing logic (November 2026).
 *
 * getReminderDeliveryDiagnostics() is the EXACT pre-existing logic that used
 * to be inlined in routes/cronJobs.js's POST /diagnose-reminder-delivery
 * (X-Worker-Secret only) — extracted verbatim, same queries, same response
 * shape, so that existing worker-secret-gated endpoint's external contract
 * is completely unchanged. Extracted so a SECOND, CRM-admin-authenticated
 * caller (routes/reminderDiagnostics.js) can reuse the identical underlying
 * read-only logic without duplicating it, and without the frontend ever
 * calling the worker-secret route directly (which would require exposing
 * WORKER_SECRET to the browser — never done, never will be).
 *
 * getAppointmentNotificationDiagnostics() is new: a single lead's full
 * appointment-notification picture across every channel the approved
 * six-email/three-SMS schedule defines — 5 email windows (48h/24h/12h/2h/
 * 30min) + SMS confirmation + SMS 12h + SMS 2h — each explicitly classified
 * as one of: sent, delivered, failed, skipped (with its exact reason when
 * recorded — see lib/reminderEngine.js#markSkippedNoRecipient), pending
 * retry (quiet hours), not yet due, or no record / not verified.
 *
 * A missing reminder_claims row is NEVER reported as "skipped" — it is
 * reported as "not yet due" (the window's target time hasn't passed yet)
 * or "no record / not verified" (the target time has passed but nothing
 * was ever recorded) depending on the current time vs. the window's target.
 * This mirrors exactly how an operator would otherwise have to reason about
 * the same data by hand.
 *
 * Purely read-only: every query here is a SELECT. No write of any kind.
 */
'use strict';

const { query } = require('../db/client');

// ── Pre-existing logic, extracted verbatim from routes/cronJobs.js ────────

async function getReminderDeliveryDiagnostics({ lead_id, name }) {
  let leadRows;
  if (name) {
    const parts = name.trim().split(/\s+/);
    const first = parts[0] || '';
    const last = parts.slice(1).join(' ') || '';
    const { rows } = await query(
      `SELECT id, first_name, last_name, email, phone, assigned_rep,
              appointment_date, appointment_time, follow_up_date, follow_up_time, follow_up_type,
              customer_reminders_disabled
       FROM reminder_leads WHERE first_name ILIKE $1 AND last_name ILIKE $2 LIMIT 5`,
      [`%${first}%`, `%${last}%`]
    );
    leadRows = rows;
  } else {
    const { rows } = await query(
      `SELECT id, first_name, last_name, email, phone, assigned_rep,
              appointment_date, appointment_time, follow_up_date, follow_up_time, follow_up_type,
              customer_reminders_disabled
       FROM reminder_leads WHERE id = $1 LIMIT 1`,
      [lead_id]
    );
    leadRows = rows;
  }
  const lead = leadRows[0];
  if (!lead) return { found: false, lead_id: lead_id || name, message: 'Lead not found in reminder_leads' };
  if (leadRows.length > 1) return { found: true, multiple: true, leads: leadRows.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name}` })) };
  const effectiveLeadId = lead.id;

  const { rows: claims } = await query(
    `SELECT id, reminder_key, reminder_window, status, owner, sent_at, last_error, last_error_type,
            gmail_message_ids, created_at, appointment_date
     FROM reminder_claims WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [effectiveLeadId]
  );

  const { rows: emailClaims } = await query(
    `SELECT id, idempotency_key, status, recipient, subject, gmail_message_id, last_error, attempts,
            created_at, sent_at
     FROM email_send_claims
     WHERE idempotency_key LIKE $1
     ORDER BY created_at DESC LIMIT 30`,
    [`%${effectiveLeadId}%`]
  );

  let emailLogs = [];
  if (emailClaims.length > 0) {
    const claimIds = emailClaims.map(c => c.id);
    const { rows: logs } = await query(
      `SELECT id, claim_id, role, recipient, sender, subject, gmail_message_id, status, error, attempts, created_at
       FROM email_send_logs WHERE claim_id::text = ANY($1::text[]) ORDER BY created_at DESC LIMIT 30`,
      [claimIds]
    );
    emailLogs = logs;
  }

  const customerClaims = emailClaims.filter(c => c.idempotency_key.includes(':customer:'));
  const staffClaims = emailClaims.filter(c => c.idempotency_key.includes(':staff:'));
  const customerLogs = emailLogs.filter(l => l.role === 'customer');
  const staffLogs = emailLogs.filter(l => l.role === 'staff');

  return {
    found: true,
    lead: {
      id: lead.id,
      name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      email: lead.email,
      phone: lead.phone,
      assigned_rep: lead.assigned_rep,
      appointment_date: lead.appointment_date,
      appointment_time: lead.appointment_time,
      customer_reminders_disabled: lead.customer_reminders_disabled,
    },
    reminder_claims: claims.map(c => ({
      window: c.reminder_window,
      status: c.status,
      sent_at: c.sent_at,
      gmail_message_ids: c.gmail_message_ids,
      last_error: c.last_error,
      last_error_type: c.last_error_type,
      created_at: c.created_at,
    })),
    customer_delivery: {
      email_exists: !!lead.email,
      claims_count: customerClaims.length,
      claims: customerClaims.map(c => ({
        status: c.status, recipient: c.recipient, subject: c.subject,
        gmail_message_id: c.gmail_message_id, sent_at: c.sent_at, last_error: c.last_error,
      })),
      logs_count: customerLogs.length,
      logs: customerLogs.map(l => ({
        status: l.status, recipient: l.recipient, gmail_message_id: l.gmail_message_id, subject: l.subject,
      })),
      gmail_message_ids: customerLogs.filter(l => l.gmail_message_id).map(l => l.gmail_message_id),
    },
    staff_delivery: {
      claims_count: staffClaims.length,
      claims: staffClaims.map(c => ({
        status: c.status, recipient: c.recipient, subject: c.subject,
        gmail_message_id: c.gmail_message_id, sent_at: c.sent_at, last_error: c.last_error,
      })),
      logs_count: staffLogs.length,
      logs: staffLogs.map(l => ({
        status: l.status, recipient: l.recipient, gmail_message_id: l.gmail_message_id, subject: l.subject,
      })),
      gmail_message_ids: staffLogs.filter(l => l.gmail_message_id).map(l => l.gmail_message_id),
    },
  };
}

// ── New: full per-appointment, all-channel notification diagnostic ────────

const SMS_SENDER_PREFIX = { '12h': 'system:reminder_12h', '2h': 'system:reminder_2h' };
const CONFIRMATION_SENDER = 'system:booking_confirmation';

// A Twilio Message status that means the carrier confirmed delivery/non-
// delivery — see lib/smsService.js#KNOWN_SMS_STATUSES for the full set this
// installation can receive. 'sent'/'accepted'/'queued'/'sending' are
// in-flight/accepted states, not a delivery outcome either way.
const SMS_TERMINAL_FAILURE_STATUSES = new Set(['undelivered', 'failed', 'canceled']);

/**
 * Classify one reminder_claims-backed window (an email window, or sms_12h/
 * sms_2h). `smsMessage` (the matching sms_messages row, or null) is only
 * meaningful when `channel === 'sms'`; pass `null` for an email window.
 */
function classifyClaimRow({ claim, smsMessage, channel, nowMs, targetMs }) {
  if (claim) {
    if (claim.status === 'sent') {
      if (channel === 'sms') {
        if (!smsMessage) {
          return { outcome: 'sent', label: 'Sent', detail: 'Marked sent, but no matching sms_messages record was found to confirm delivery status.' };
        }
        if (SMS_TERMINAL_FAILURE_STATUSES.has(smsMessage.status)) {
          return { outcome: 'failed', label: 'Failed', detail: smsMessage.error_message || smsMessage.error_code || `Twilio status: ${smsMessage.status}` };
        }
        if (smsMessage.status === 'delivered') return { outcome: 'delivered', label: 'Delivered', detail: null };
        return { outcome: 'sent', label: 'Sent', detail: `Twilio status: ${smsMessage.status}` };
      }
      return { outcome: 'sent', label: 'Sent', detail: 'Accepted for sending by Gmail — this system does not track email delivery beyond acceptance.' };
    }
    if (claim.status === 'skipped_no_recipient') {
      if (claim.last_error_type) return { outcome: 'skipped', label: 'Skipped', reason: claim.last_error_type };
      return {
        outcome: 'skipped',
        label: 'Skipped',
        reason: channel === 'sms'
          ? 'Not recorded — this skip happened before the skip-reason persistence fix.'
          : 'No eligible recipient (customer opted out of reminders, or no staff configured for this window).',
      };
    }
    if (claim.status === 'failed') {
      if (claim.last_error_type === 'quiet_hours') {
        return { outcome: 'pending_retry', label: 'Pending retry (quiet hours)', detail: claim.last_error || null };
      }
      return { outcome: 'failed', label: 'Failed', detail: claim.last_error_type || claim.last_error || null };
    }
    if (claim.status === 'processing') return { outcome: 'in_progress', label: 'In progress', detail: null };
    return { outcome: 'unknown', label: `Unrecognized claim status: ${claim.status}`, detail: null };
  }
  if (targetMs == null) return { outcome: 'no_record', label: 'No record / not verified', detail: 'No appointment date/time available to compute this window.' };
  if (nowMs < targetMs) return { outcome: 'not_yet_due', label: 'Not yet due', detail: null };
  return { outcome: 'no_record', label: 'No record / not verified', detail: null };
}

/** Booking confirmation SMS has no claim row at all (fire-and-forget) — classified purely from sms_messages, or "no record" if absent. Never "skipped": there is no persisted evidence to support that label. */
function classifyConfirmationSms(smsMessage) {
  if (!smsMessage) return { outcome: 'no_record', label: 'No record / not verified', detail: null };
  if (SMS_TERMINAL_FAILURE_STATUSES.has(smsMessage.status)) {
    return { outcome: 'failed', label: 'Failed', detail: smsMessage.error_message || smsMessage.error_code || `Twilio status: ${smsMessage.status}` };
  }
  if (smsMessage.status === 'delivered') return { outcome: 'delivered', label: 'Delivered', detail: null };
  return { outcome: 'sent', label: 'Sent', detail: `Twilio status: ${smsMessage.status}` };
}

/** YYYY-MM-DD / HH:MM (24h) for `ms` in the given IANA zone — used only as a
 * fallback when no reminder_leads projection exists for this lead but a live
 * appointments row still does (e.g. a cancelled/completed appointment whose
 * projection has since been cleared). */
function localDateTimeParts(ms, tz) {
  const date = new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
  const time = new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  return { date, time };
}

async function getAppointmentNotificationDiagnostics(leadId) {
  const { rows: leadRows } = await query(
    `SELECT id, external_ref, first_name, last_name, sms_consent, phone, email, assigned_rep
     FROM leads WHERE id = $1 LIMIT 1`,
    [leadId]
  );
  const leadRow = leadRows[0];
  if (!leadRow) return { found: false, message: 'Lead not found.' };

  // Mirrors lib/reminderProjection.js#reminderIdFor exactly — the SAME id
  // reminder_claims/reminder_leads are keyed by (external_ref when present,
  // the lead's own id otherwise). sms_messages, separately, is ALWAYS keyed
  // by the real leads.id (a direct FK) regardless of external_ref.
  const reminderLeadId = leadRow.external_ref || leadRow.id;

  const { rows: apptRows } = await query(
    `SELECT start_at, appointment_type, status, created_at
     FROM appointments WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [leadRow.id]
  );
  const liveAppt = apptRows[0] || null;

  const { rows: projRows } = await query(
    `SELECT appointment_date, appointment_time FROM reminder_leads WHERE id = $1 LIMIT 1`,
    [reminderLeadId]
  );
  const projection = projRows[0] || null;

  const companyConfig = require('./companyConfig');
  const tz = await companyConfig.getTimezone();

  let appointmentDate = projection?.appointment_date || null;
  let appointmentTime = projection?.appointment_time || null;
  let resolvedFrom = projection ? 'reminder_projection' : null;
  if (!appointmentDate && liveAppt?.start_at) {
    const parts = localDateTimeParts(new Date(liveAppt.start_at).getTime(), tz);
    appointmentDate = parts.date;
    appointmentTime = parts.time;
    resolvedFrom = 'live_appointment_record';
  }

  const { rows: claims } = await query(
    `SELECT reminder_window, status, sent_at, last_error, last_error_type, created_at, appointment_date
     FROM reminder_claims WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [reminderLeadId]
  );

  const { rows: smsMessages } = await query(
    `SELECT sent_by, status, error_code, error_message, created_at
     FROM sms_messages WHERE lead_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 30`,
    [leadRow.id]
  );

  const result = {
    found: true,
    lead: {
      id: leadRow.id,
      name: `${leadRow.first_name || ''} ${leadRow.last_name || ''}`.trim(),
      assigned_rep: leadRow.assigned_rep || null,
      sms_consent: leadRow.sms_consent === true,
      phone_on_file: !!leadRow.phone,
      email_on_file: !!leadRow.email,
    },
    appointment: {
      date: appointmentDate,
      time: appointmentTime,
      status: liveAppt?.status || null,
      type: liveAppt?.appointment_type || null,
      resolved_from: resolvedFrom,
    },
    notifications: null,
    generated_at: new Date().toISOString(),
  };

  if (!appointmentDate || !appointmentTime) {
    result.appointment.note = 'No appointment date/time could be resolved for this lead — nothing to diagnose.';
    return result;
  }

  const time = require('./reminderTime');
  const { REMINDER_WINDOWS, SMS_WINDOW_KEYS } = require('./reminderEngine');
  const apptMs = time.pacificToUtcMs(appointmentDate, appointmentTime, tz);
  const nowMs = Date.now();

  const emailWindows = REMINDER_WINDOWS.map((w) => {
    const targetMs = apptMs - w.minutesBefore * 60 * 1000;
    const claim = claims.find((c) => c.reminder_window === w.key) || null;
    const classification = classifyClaimRow({ claim, smsMessage: null, channel: 'email', nowMs, targetMs });
    return {
      window: w.key,
      target_at: new Date(targetMs).toISOString(),
      ...classification,
      claim_created_at: claim?.created_at || null,
    };
  });

  const smsWindows = Array.from(SMS_WINDOW_KEYS).sort().map((key) => {
    const targetMs = apptMs - REMINDER_WINDOWS.find((w) => w.key === key).minutesBefore * 60 * 1000;
    const claim = claims.find((c) => c.reminder_window === `sms_${key}`) || null;
    const smsMessage = smsMessages.find((m) => m.sent_by && m.sent_by.startsWith(SMS_SENDER_PREFIX[key])) || null;
    const classification = classifyClaimRow({ claim, smsMessage, channel: 'sms', nowMs, targetMs });
    return {
      window: `sms_${key}`,
      target_at: new Date(targetMs).toISOString(),
      ...classification,
      claim_created_at: claim?.created_at || null,
    };
  });

  const confirmationSms = smsMessages.find((m) => m.sent_by === CONFIRMATION_SENDER) || null;

  result.notifications = {
    email: emailWindows,
    sms_confirmation: { window: 'sms_confirmation', ...classifyConfirmationSms(confirmationSms) },
    sms: smsWindows,
  };
  return result;
}

module.exports = { getReminderDeliveryDiagnostics, getAppointmentNotificationDiagnostics, classifyClaimRow, classifyConfirmationSms };
