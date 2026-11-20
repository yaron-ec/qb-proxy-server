'use strict';

/**
 * followUpAppointmentSync — makes a lead's Follow-Up fields (follow_up_date/
 * follow_up_time/follow_up_type) the single, user-facing source of
 * scheduling truth for an in-person Meeting.
 *
 * PRODUCT CORRECTION (November 2026, explicit owner instruction, supersedes
 * the prior "Appointment vs Follow-Up — never mirror one into the other"
 * rule FOR THE MEETING CASE SPECIFICALLY): a representative is not required
 * to separately open the Appointment editor or click Reschedule. Saving a
 * Meeting Follow-Up's date/time through ANY CRM write path must
 * automatically create or reschedule the real appointment, update/cancel
 * its Google Calendar main + travel events, and keep reminders correct —
 * through the SAME centralized booking service and calendar outbox every
 * other appointment mutation already uses, never a second, parallel
 * implementation. This was built after a real production incident where a
 * rep's Follow-Up edit silently left the actual appointment, Google
 * Calendar, and reminders on the stale date (see git history /
 * CLAUDE.md's "John John" incident for the original investigation that
 * this correction supersedes).
 *
 * MUST be called AFTER the follow-up write's own transaction has committed.
 * bookingService's create/reschedule/cancel functions each own their own
 * Postgres connection and transaction (see bookingService.js's own
 * comments on why a Google Calendar network call must never happen inside
 * a held transaction) — exactly the same "cannot run inside that
 * transaction" precedent routes/leads.js already uses for
 * cancelActiveAppointmentsForTerminalLost. A real booking failure (most
 * plausibly a genuine Google Calendar slot conflict, extremely rarely a
 * race against a concurrent request) is therefore never able to roll back
 * the follow-up field save the user asked for — it is reported back in
 * this function's return value instead, and the caller surfaces it as a
 * non-fatal field on the HTTP response, the same pattern already used for
 * `closed_lost_appointment_cancel_failures`.
 *
 * Only a dated 'Meeting' follow-up drives appointment behavior:
 *  - 'Phone Call' (and Text/Email/Other) never creates, reschedules, or
 *    cancels an appointment — unchanged from the pre-existing, permanent
 *    "a Phone Call is never an appointment" rule.
 *  - No active appointment + a dated Meeting follow-up -> CREATE.
 *  - An active appointment whose time differs from the Meeting follow-up
 *    -> RESCHEDULE (cancels the old Google Calendar main+travel events,
 *    creates the new ones, through bookingService.rescheduleAppointment —
 *    duplicate-event-safe via its existing deterministic
 *    idempotency_key/google_event_id scheme).
 *  - An active appointment whose time already matches -> no-op (idempotent;
 *    saving the same follow-up twice never re-books/re-syncs anything).
 *  - The follow-up changes AWAY from a dated Meeting (cleared, or retyped
 *    to Phone Call/Text/Email/Other) while an active appointment exists
 *    -> CANCEL it (status 'cancelled', kept as history, its Google
 *    Calendar events removed) — BUT ONLY when that appointment's own
 *    start time currently matches what the follow-up held immediately
 *    before this exact change. This is the one safety rail added on top
 *    of the literal instruction: it prevents a plausible, severe failure
 *    mode — a real, independently-booked appointment (e.g. created
 *    directly through the Appointment editor) being silently cancelled
 *    just because a rep happened to also clear an unrelated, stale
 *    Meeting follow-up note on the same lead. An active appointment that
 *    does NOT match the prior follow-up value is left completely
 *    untouched (`action: 'skipped_unrelated'`) — never a second manual
 *    step for the common case this correction is about, but also never a
 *    silent, unrelated cancellation.
 */

const bookingService = require('./bookingService');
const { toUtcIso } = require('./slotBlocking');

const MEETING_TYPE = 'Meeting';

function normalizeDate(d) {
  if (!d) return null;
  return String(d).slice(0, 10);
}
function normalizeTime(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

async function activeAppointmentFor(leadId) {
  const db = require('../../db/client');
  const { rows } = await db.query(
    `SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed') ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  );
  return rows[0] || null;
}

/**
 * @param {string} leadId
 * @param {object} opts
 * @param {{date:?string, time:?string, type:?string}} opts.before - follow_up_date/time/type BEFORE this write
 * @param {{date:?string, time:?string, type:?string}} opts.after - follow_up_date/time/type AFTER this write
 * @param {?string} opts.actor
 * @param {?function} opts.onWrite - forwarded to bookingService (reminder projection)
 * @returns {Promise<{action: 'none'|'created'|'rescheduled'|'cancelled'|'skipped_unrelated'|'error', appointment?: object, appointment_id?: string, error?: {code:string, message:string}}>}
 */
async function syncAppointmentFromFollowUp(leadId, opts = {}) {
  const before = opts.before || {};
  const after = opts.after || {};
  const actor = opts.actor || null;
  const onWrite = opts.onWrite;

  const afterDate = normalizeDate(after.date);
  const afterTime = normalizeTime(after.time) || '09:00';
  const beforeDate = normalizeDate(before.date);
  const beforeTime = normalizeTime(before.time) || '09:00';

  const wantsMeeting = after.type === MEETING_TYPE && !!afterDate;
  const wasTrackingMeeting = before.type === MEETING_TYPE && !!beforeDate;

  try {
    const active = await activeAppointmentFor(leadId);

    if (wantsMeeting) {
      const tz = await require('../companyConfig').getTimezone();
      const startAt = toUtcIso(afterDate, afterTime, tz);

      if (!active) {
        const result = await bookingService.createAppointmentForLead({
          lead_id: leadId, start_at: startAt, skip_travel: false, actor, onWrite,
        });
        return { action: 'created', appointment: result.appointment };
      }

      if (new Date(active.start_at).getTime() === new Date(startAt).getTime()) {
        return { action: 'none' };
      }

      const result = await bookingService.rescheduleAppointment(active.id, {
        new_start_at: startAt, skip_travel: false, actor, onWrite,
      });
      return { action: 'rescheduled', appointment: result.appointment };
    }

    // Follow-up is not currently a dated Meeting — only cancel an active
    // appointment that this follow-up was actually representing.
    if (!active || !wasTrackingMeeting) {
      return { action: 'none' };
    }
    const tz = await require('../companyConfig').getTimezone();
    const priorStartMs = new Date(toUtcIso(beforeDate, beforeTime, tz)).getTime();
    if (new Date(active.start_at).getTime() !== priorStartMs) {
      return { action: 'skipped_unrelated', appointment_id: active.id };
    }
    await bookingService.cancelAppointment(active.id, actor, { onWrite });
    return { action: 'cancelled', appointment_id: active.id };
  } catch (e) {
    return { action: 'error', error: { code: (e && e.code) || 'sync_failed', message: (e && e.message) || String(e) } };
  }
}

module.exports = { syncAppointmentFromFollowUp };
