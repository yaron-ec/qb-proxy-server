/* eslint-disable no-undef */
/**
 * followUpReminders — Google Calendar VISIBILITY for EVERY follow-up type.
 *
 * PERMANENT RULE: Canonical source is the lead's follow-up (leads.follow_up_*).
 * Every ACTIVE, timed follow-up — Phone Call, Meeting, Text, Email or Other
 * (phoneCallModel.isActiveFollowUpReminder) — whose time is still ahead gets
 * exactly ONE calendar representation, chosen by type:
 *
 *   - TYPE = MEETING: a real physical customer meeting. Gets the SAME
 *     canonical scheduling semantics as a real Appointment — 1 hour
 *     duration, a BUSY main event, and a Driving/Travel Time event — built
 *     by literally calling calendarOutbox.js#buildOperation against a
 *     "virtual appointment" (lib/booking/followUpMeeting.js), never a
 *     second travel/main-event implementation (see
 *     test/phoneCallNonBlocking.test.js's "ONE travel rule" guard).
 *     Representation = 'meeting' below.
 *   - TYPE = Phone Call / Text / Email / Other: unchanged — a single,
 *     lightweight, FREE, non-blocking 15-minute reminder event.
 *     Representation = 'reminder' below.
 *
 * Both representations share:
 *   - a deterministic Google event id (or pair, for 'meeting') per LEAD +
 *     generation, so a reschedule / owner reassignment / note change
 *     UPDATES the existing event(s) in place when the id doesn't change,
 *     or cleanly cancels-and-recreates when it does (the 'meeting'
 *     representation's id is date/time-dependent, via
 *     calendarOutbox.js#computeGoogleEventId — same reschedule idiom
 *     enqueueUpdate already uses for a real Appointment; the 'reminder'
 *     representation's id is time-independent, unchanged from before);
 *   - idempotent reconciliation — re-running with no change makes no Google call.
 * RETYPING an active follow-up keeps the SAME representation's event(s)
 * updated in place (e.g. Phone Call -> Email); retyping ACROSS the
 * reminder/meeting boundary (e.g. Phone Call -> Meeting, or Meeting ->
 * Email) cancels the OLD representation's event(s), bumps `generation`
 * (so a later switch back to the same representation at the same date/time
 * never resurrects a cancelled event id — see googleCalendarClient.js's
 * 409-adopt-cancelled-event guard), and creates the NEW one's.
 * This stays entirely independent of the Appointment (lib/booking/
 * appointmentView.js), which remains busy/blocking and is synced separately
 * by lib/booking/calendarOutbox.js — neither one ever overwrites, clears,
 * moves or completes the other. A Meeting follow-up's physical-meeting
 * representation never creates an `appointments` row either — see
 * lib/booking/followUpMeeting.js and lib/booking/availabilityService.js for
 * how it occupies availability without one.
 * When the follow-up is completed, cleared, deleted, or its lead is deleted,
 * a still-upcoming event (or pair, for 'meeting') is deleted. One whose time
 * has passed is left on the calendar as history ('expired').
 *
 * reconcileFollowUpReminders() is a desired-state reconciliation (desired =
 * follow-ups, actual = followup_calendar_reminders), so it covers EVERY write
 * path (New Lead, Lead Detail, My Day, Leads list, capture, merges, deletes)
 * without hooks in each one, and is idempotent: re-running it with no change
 * makes no Google call. Runs in the calendar worker loop.
 */
'use strict';

const crypto = require('crypto');
const {
  isActiveFollowUpReminder, followUpStartIso, EC_KIND_FOLLOWUP_REMINDER, REMINDER_DURATION_MIN, TZ,
} = require('./phoneCallModel');
const { isoToLaParts } = require('./calendarOutbox');
const followUpMeeting = require('./followUpMeeting');

// 'Phone Call' -> 'phone_call', 'Meeting' -> 'meeting', etc. — stored on the
// Google event (ec_followup_kind) and in followup_calendar_reminders.followup_kind.
function followupKindSlug(type) {
  return String(type || '').trim().toLowerCase().replace(/\s+/g, '_') || 'other';
}

/** Which calendar representation an active follow-up of this type gets. */
function desiredRepresentation(lead) {
  return followUpMeeting.isActiveMeetingFollowUp(lead) ? 'meeting' : 'reminder';
}

const B32 = '0123456789abcdefghijklmnopqrstuv';
function base32hex(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Deterministic Google event id for a lead's follow-up reminder. `generation`
 * increases each time the reminder is removed, so a new follow-up after a
 * completed one never reuses a deleted event id.
 */
function reminderEventId(leadId, generation = 0) {
  return base32hex(crypto.createHash('sha256').update(`ec|primary|followup_reminder|${leadId}|g${generation}`).digest().slice(0, 16));
}

function laToday(now, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Google event body for one lead's Phone Call/Text/Email/Other follow-up
 * reminder (pure). Never used for an active Meeting follow-up — see
 * lib/booking/followUpMeeting.js for that (it reuses calendarOutbox.js's
 * buildOperation instead of a second implementation).
 * tz: the installation's configured timezone (lib/companyConfig.js#getTimezone).
 * Defaults to America/Los_Angeles when omitted — preserves EC's exact
 * historical behavior and keeps every existing sync caller/test working. */
function buildReminderEvent(lead, crmPublicUrl, generation = 0, tz) {
  const zone = tz || TZ;
  const startIso = followUpStartIso(lead, zone);
  const endIso = new Date(new Date(startIso).getTime() + REMINDER_DURATION_MIN * 60 * 1000).toISOString();
  const s = isoToLaParts(startIso, zone);
  const e = isoToLaParts(endIso, zone);
  const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Lead';
  const link = crmPublicUrl ? `${crmPublicUrl.replace(/\/$/, '')}/leads/${lead.id}` : null;
  const type = String(lead.follow_up_type || 'Other').trim();
  const description = [
    `${type} follow-up reminder (CRM).`,
    'This is a reminder, NOT an appointment — it does not block availability.',
    '',
    `Lead: ${name}`,
    lead.phone ? `Phone: ${lead.phone}` : null,
    lead.follow_up_notes ? `Notes: ${String(lead.follow_up_notes).slice(0, 500)}` : null,
    link ? `Open in CRM: ${link}` : null,
  ].filter((l) => l !== null).join('\n');
  return {
    id: reminderEventId(lead.id, generation),
    status: 'confirmed',
    summary: `${type}: ${name}`,
    description,
    start: { dateTime: `${s.date}T${s.hhmmColon}:00`, timeZone: zone },
    end: { dateTime: `${e.date}T${e.hhmmColon}:00`, timeZone: zone },
    transparency: 'transparent',
    ...(lead.owner_email ? { attendees: [{ email: lead.owner_email }] } : {}),
    guestsCanSeeOtherGuests: false,
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    extendedProperties: { private: {
      ec_kind: EC_KIND_FOLLOWUP_REMINDER,
      ec_followup_kind: followupKindSlug(type),
      ec_blocking: 'false',
      ec_source: 'crm',
      ec_lead_id: String(lead.id),
    } },
  };
}

function fingerprint(body) {
  const { start, end, summary, description, attendees } = body;
  return crypto.createHash('sha256').update(JSON.stringify({ start, end, summary, description, attendees: attendees || [] })).digest('hex');
}

/** Desired reminders: active, timed follow-ups of ANY type whose time is ahead.
 * tz: the installation's configured timezone (lib/companyConfig.js#getTimezone).
 * Defaults to America/Los_Angeles when omitted. */
async function desiredReminders(pool, now, tz) {
  const yesterday = laToday(new Date(now.getTime() - 24 * 3600 * 1000), tz);
  const { rows } = await pool.query(
    `SELECT l.id, l.first_name, l.last_name, l.phone, l.email, l.property_address, l.city, l.project_type,
            l.follow_up_date, l.follow_up_time, l.follow_up_type,
            l.follow_up_status, l.follow_up_notes, o.email AS owner_email,
            (SELECT a.start_at FROM appointments a WHERE a.lead_id = l.id AND a.status IN ('scheduled', 'confirmed')
               ORDER BY a.start_at DESC LIMIT 1) AS appt_start_at
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
      WHERE l.follow_up_type IS NOT NULL
        AND l.follow_up_status IS DISTINCT FROM 'completed'
        AND l.follow_up_date IS NOT NULL AND l.follow_up_time IS NOT NULL
        AND l.follow_up_date >= $1`,
    [yesterday]);
  return rows.filter((l) => {
    if (!isActiveFollowUpReminder(l) || !(new Date(followUpStartIso(l, tz)) > now)) return false;
    // PR #8 mirror-dedup principle, applied to calendar sync (PERMANENT
    // RULE): an active Meeting follow-up whose date/time exactly matches the
    // lead's own real Appointment is the SAME physical meeting recorded
    // twice — the Appointment's own calendarOutbox.js sync already
    // represents it, so the follow-up gets no separate calendar presence
    // here (never two BUSY main+travel pairs for the one meeting). A
    // different time, or no active appointment at all, is never suppressed.
    if (followUpMeeting.isActiveMeetingFollowUp(l) && l.appt_start_at
        && new Date(l.appt_start_at).getTime() === new Date(followUpStartIso(l, tz)).getTime()) {
      return false;
    }
    return true;
  });
}

/**
 * Reconcile Google to the canonical follow-ups. `google` is the
 * googleCalendarClient boundary (injectable for tests). Returns counts.
 */
async function reconcileFollowUpReminders(pool, opts = {}) {
  const google = opts.google || require('./googleCalendarClient');
  const now = opts.now || new Date();
  const outbox = require('./calendarOutbox');
  const calId = opts.calendarId || outbox.CALENDAR_ID;
  // Same DWD subject rule as calendarOutbox.processRow.
  const subject = calId && calId.includes('@') ? calId : await outbox.dwdSubjectFallback();
  const crmUrl = opts.crmPublicUrl != null ? opts.crmPublicUrl : require('../dataAccessRailway').CRM_PUBLIC_URL;
  const limit = opts.limit || 50;
  const delayMs = opts.delayMs != null ? opts.delayMs : 150;
  const tz = opts.tz || await require('../companyConfig').getTimezone();
  const stats = { desired: 0, upserted: 0, removed: 0, expired: 0, unchanged: 0, errors: 0 };

  const desired = await desiredReminders(pool, now, tz);
  stats.desired = desired.length;
  const state = new Map((await pool.query('SELECT * FROM followup_calendar_reminders')).rows.map((r) => [String(r.lead_id), r]));
  const due = (row) => !row || !row.next_attempt_at || new Date(row.next_attempt_at) <= now;

  // Resolved once per reconcile tick — reused for every Meeting follow-up in
  // this run, matching calendarOutbox.js's own per-call resolution of the
  // same configuration (staff attendees, travel buffer minutes).
  let staffAttendees = null;
  let bufferMinutes = null;
  async function meetingDeps() {
    if (staffAttendees === null) staffAttendees = await require('../notificationRecipients').getAllStaffRecipients();
    if (bufferMinutes === null) bufferMinutes = await require('./bookingService').getTravelBufferMinutes();
    return { staffAttendees, bufferMinutes };
  }

  const ops = [];
  const desiredIds = new Set();
  for (const lead of desired) {
    const id = String(lead.id);
    desiredIds.add(id);
    const row = state.get(id);
    const representation = desiredRepresentation(lead);
    const priorRepresentation = row ? row.representation : null;
    const currentGeneration = row ? row.generation : 0;
    // A representation switch invalidates the OLD event(s) outright (they
    // use a completely different id-hash scheme) — bump generation so the
    // NEW representation's id, and a later switch back to this SAME
    // representation, never resurrects a cancelled Google event id.
    const switching = !!(row && priorRepresentation && priorRepresentation !== representation);
    const generation = switching ? currentGeneration + 1 : currentGeneration;

    let mainOp; let travelOp = null; let fp;
    if (representation === 'meeting') {
      const { staffAttendees: sa, bufferMinutes: bm } = await meetingDeps();
      const virtualAppt = followUpMeeting.virtualAppointmentFor(lead, generation, tz);
      mainOp = outbox.buildOperation(virtualAppt, lead, lead.owner_email || null, 'main', sa);
      travelOp = outbox.buildOperation(virtualAppt, lead, lead.owner_email || null, 'travel', sa, bm);
      fp = crypto.createHash('sha256').update(`${fingerprint(mainOp.body)}|${fingerprint(travelOp.body)}`).digest('hex');
    } else {
      const body = buildReminderEvent(lead, crmUrl, generation, tz);
      mainOp = { body, googleEventId: body.id };
      fp = fingerprint(body);
    }

    if (!switching && row && row.status === 'active' && row.representation === representation && row.fingerprint === fp && !row.last_error) {
      stats.unchanged++;
      continue;
    }
    if (!due(row)) continue;
    ops.push({
      kind: 'upsert', leadId: id, representation, switching, generation,
      mainOp, travelOp, fp,
      startAt: followUpStartIso(lead, tz), ownerEmail: lead.owner_email || null,
      followupKind: followupKindSlug(lead.follow_up_type), row,
    });
  }
  for (const [id, row] of state) {
    if (row.status !== 'active' || desiredIds.has(id)) continue;
    if (row.start_at && new Date(row.start_at) <= now) { ops.push({ kind: 'expire', leadId: id, row }); continue; }
    if (!due(row)) continue;
    ops.push({ kind: 'remove', leadId: id, row });
  }

  let token = null;
  for (const op of ops.slice(0, limit)) {
    try {
      if (op.kind === 'expire') {
        await pool.query(`UPDATE followup_calendar_reminders SET status = 'expired', updated_at = NOW() WHERE lead_id = $1`, [op.leadId]);
        stats.expired++;
        continue;
      }
      if (!token) token = await google.getAccessToken(subject);
      if (op.kind === 'upsert') {
        const row = op.row;
        if (op.switching && row) {
          // A representation switch cancels whichever event(s) the OLD
          // representation had — the new representation's id(s) never
          // collide with the old one's (different hash scheme), so this is
          // always a clean switch, never a dangling orphan.
          if (row.google_event_id) await google.cancelEvent(token, calId, row.google_event_id);
          if (row.representation === 'meeting' && row.google_travel_event_id) {
            await google.cancelEvent(token, calId, row.google_travel_event_id);
          }
        } else if (row && row.google_event_id && row.google_event_id !== op.mainOp.googleEventId) {
          // Same representation, but the computed id changed (a 'meeting'
          // reschedule — its id is date/time-dependent) — same reschedule
          // idiom calendarOutbox.js#enqueueUpdate already uses for a real
          // Appointment: cancel the OLD event, create the NEW one.
          await google.cancelEvent(token, calId, row.google_event_id);
        }
        // PUT the deterministic id (updates the existing event, restores one
        // removed earlier); 404 → insert with the same id. Never a duplicate.
        await google.updateEvent(token, calId, op.mainOp.googleEventId, op.mainOp.body);
        let travelEventId = null;
        if (op.representation === 'meeting') {
          if (!op.switching && row && row.google_travel_event_id && row.google_travel_event_id !== op.travelOp.googleEventId) {
            await google.cancelEvent(token, calId, row.google_travel_event_id);
          }
          await google.updateEvent(token, calId, op.travelOp.googleEventId, op.travelOp.body);
          travelEventId = op.travelOp.googleEventId;
        }
        await pool.query(
          `INSERT INTO followup_calendar_reminders
             (lead_id, google_event_id, google_travel_event_id, status, start_at, owner_email, fingerprint, followup_kind, representation, generation, attempts, last_error, next_attempt_at, synced_at, updated_at)
           VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, 0, NULL, NULL, NOW(), NOW())
           ON CONFLICT (lead_id) DO UPDATE SET google_event_id = EXCLUDED.google_event_id, google_travel_event_id = EXCLUDED.google_travel_event_id,
             status = 'active', start_at = EXCLUDED.start_at, owner_email = EXCLUDED.owner_email, fingerprint = EXCLUDED.fingerprint,
             followup_kind = EXCLUDED.followup_kind, representation = EXCLUDED.representation, generation = EXCLUDED.generation, attempts = 0, last_error = NULL,
             next_attempt_at = NULL, synced_at = NOW(), updated_at = NOW()`,
          [op.leadId, op.mainOp.googleEventId, travelEventId, op.startAt, op.ownerEmail, op.fp, op.followupKind, op.representation, op.generation]);
        stats.upserted++;
      } else {
        await google.cancelEvent(token, calId, op.row.google_event_id);
        if (op.row.representation === 'meeting' && op.row.google_travel_event_id) {
          await google.cancelEvent(token, calId, op.row.google_travel_event_id);
        }
        await pool.query(
          `UPDATE followup_calendar_reminders SET status = 'removed', generation = generation + 1, google_travel_event_id = NULL, attempts = 0, last_error = NULL,
                  next_attempt_at = NULL, synced_at = NOW(), updated_at = NOW()
            WHERE lead_id = $1`, [op.leadId]);
        stats.removed++;
      }
    } catch (e) {
      stats.errors++;
      const attempts = ((op.row && op.row.attempts) || 0) + 1;
      const backoffSec = Math.min(30 * 2 ** (attempts - 1), 3600);
      await pool.query(
        `INSERT INTO followup_calendar_reminders (lead_id, google_event_id, status, start_at, attempts, last_error, next_attempt_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' seconds')::interval, NOW())
         ON CONFLICT (lead_id) DO UPDATE SET attempts = $5, last_error = $6, next_attempt_at = NOW() + ($7 || ' seconds')::interval, updated_at = NOW()`,
        [op.leadId, (op.mainOp && op.mainOp.googleEventId) || (op.row && op.row.google_event_id), 'active',
          op.startAt || (op.row && op.row.start_at) || null, attempts, String(e.message || e).slice(0, 500), String(backoffSec)]).catch(() => {});
      console.error(`[followup-reminders] ${op.kind} failed for lead ${op.leadId}:`, e.message);
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return stats;
}

module.exports = {
  reconcileFollowUpReminders, buildReminderEvent, reminderEventId, desiredReminders, fingerprint, desiredRepresentation,
};
