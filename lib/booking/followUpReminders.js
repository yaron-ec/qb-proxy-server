/* eslint-disable no-undef */
/**
 * followUpReminders — Google Calendar VISIBILITY for Phone Call follow-ups.
 *
 * Canonical source: the lead's follow-up (leads.follow_up_*). Every ACTIVE,
 * timed Phone Call follow-up (phoneCallModel.isActivePhoneCallFollowUp) whose
 * time is still ahead gets exactly ONE reminder event on the CRM calendar:
 *   - deterministic Google event id per LEAD (a lead has one follow-up), so a
 *     reschedule / owner reassignment / note change UPDATES that same event —
 *     never a second one;
 *   - transparency 'transparent' (shown as "free") AND a private marker
 *     ec_kind='followup_reminder', ec_blocking='false' that the availability
 *     engine uses to ignore it — the backend never relies on Google's
 *     free/busy flag alone;
 *   - only the owner is an attendee (the customer is never invited to an
 *     internal call reminder); no travel event, ever.
 * When the follow-up is completed, cleared, retyped, deleted, or its lead is
 * deleted, a still-upcoming reminder event is deleted. A reminder whose time
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
  isActivePhoneCallFollowUp, followUpStartIso, EC_KIND_FOLLOWUP_REMINDER, REMINDER_DURATION_MIN, TZ,
} = require('./phoneCallModel');
const { isoToLaParts } = require('./calendarOutbox');

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

function laToday(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Google event body for one lead's Phone Call follow-up reminder (pure). */
function buildReminderEvent(lead, crmPublicUrl, generation = 0) {
  const startIso = followUpStartIso(lead);
  const endIso = new Date(new Date(startIso).getTime() + REMINDER_DURATION_MIN * 60 * 1000).toISOString();
  const s = isoToLaParts(startIso, TZ);
  const e = isoToLaParts(endIso, TZ);
  const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Lead';
  const link = crmPublicUrl ? `${crmPublicUrl.replace(/\/$/, '')}/leads/${lead.id}` : null;
  const description = [
    'Phone Call follow-up reminder (CRM).',
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
    summary: `Phone Call: ${name}`,
    description,
    start: { dateTime: `${s.date}T${s.hhmmColon}:00`, timeZone: TZ },
    end: { dateTime: `${e.date}T${e.hhmmColon}:00`, timeZone: TZ },
    transparency: 'transparent',
    ...(lead.owner_email ? { attendees: [{ email: lead.owner_email }] } : {}),
    guestsCanSeeOtherGuests: false,
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    extendedProperties: { private: {
      ec_kind: EC_KIND_FOLLOWUP_REMINDER,
      ec_followup_kind: 'phone_call',
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

/** Desired reminders: active, timed Phone Call follow-ups whose time is ahead. */
async function desiredReminders(pool, now) {
  const yesterday = laToday(new Date(now.getTime() - 24 * 3600 * 1000));
  const { rows } = await pool.query(
    `SELECT l.id, l.first_name, l.last_name, l.phone, l.follow_up_date, l.follow_up_time, l.follow_up_type,
            l.follow_up_status, l.follow_up_notes, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
      WHERE l.follow_up_type = 'Phone Call'
        AND l.follow_up_status IS DISTINCT FROM 'completed'
        AND l.follow_up_date IS NOT NULL AND l.follow_up_time IS NOT NULL
        AND l.follow_up_date >= $1`,
    [yesterday]);
  return rows.filter((l) => isActivePhoneCallFollowUp(l) && new Date(followUpStartIso(l)) > now);
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
  const subject = calId && calId.includes('@') ? calId : outbox.YARON_EMAIL;
  const crmUrl = opts.crmPublicUrl != null ? opts.crmPublicUrl : require('../dataAccessRailway').CRM_PUBLIC_URL;
  const limit = opts.limit || 50;
  const delayMs = opts.delayMs != null ? opts.delayMs : 150;
  const stats = { desired: 0, upserted: 0, removed: 0, expired: 0, unchanged: 0, errors: 0 };

  const desired = await desiredReminders(pool, now);
  stats.desired = desired.length;
  const state = new Map((await pool.query('SELECT * FROM followup_calendar_reminders')).rows.map((r) => [String(r.lead_id), r]));
  const due = (row) => !row || !row.next_attempt_at || new Date(row.next_attempt_at) <= now;

  const ops = [];
  const desiredIds = new Set();
  for (const lead of desired) {
    const id = String(lead.id);
    desiredIds.add(id);
    const row = state.get(id);
    const body = buildReminderEvent(lead, crmUrl, row ? row.generation : 0);
    const fp = fingerprint(body);
    if (row && row.status === 'active' && row.fingerprint === fp && !row.last_error) { stats.unchanged++; continue; }
    if (!due(row)) continue;
    ops.push({ kind: 'upsert', leadId: id, body, fp, startAt: followUpStartIso(lead), ownerEmail: lead.owner_email || null, row });
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
        // PUT the deterministic id (updates the existing event, restores one
        // removed earlier); 404 → insert with the same id. Never a duplicate.
        await google.updateEvent(token, calId, op.body.id, op.body);
        await pool.query(
          `INSERT INTO followup_calendar_reminders (lead_id, google_event_id, status, start_at, owner_email, fingerprint, attempts, last_error, next_attempt_at, synced_at, updated_at)
           VALUES ($1, $2, 'active', $3, $4, $5, 0, NULL, NULL, NOW(), NOW())
           ON CONFLICT (lead_id) DO UPDATE SET google_event_id = EXCLUDED.google_event_id, status = 'active', start_at = EXCLUDED.start_at,
             owner_email = EXCLUDED.owner_email, fingerprint = EXCLUDED.fingerprint, attempts = 0, last_error = NULL,
             next_attempt_at = NULL, synced_at = NOW(), updated_at = NOW()`,
          [op.leadId, op.body.id, op.startAt, op.ownerEmail, op.fp]);
        stats.upserted++;
      } else {
        await google.cancelEvent(token, calId, op.row.google_event_id);
        await pool.query(
          `UPDATE followup_calendar_reminders SET status = 'removed', generation = generation + 1, attempts = 0, last_error = NULL,
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
        [op.leadId, (op.body && op.body.id) || op.row.google_event_id, 'active',
          op.startAt || (op.row && op.row.start_at) || null, attempts, String(e.message || e).slice(0, 500), String(backoffSec)]).catch(() => {});
      console.error(`[followup-reminders] ${op.kind} failed for lead ${op.leadId}:`, e.message);
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return stats;
}

module.exports = { reconcileFollowUpReminders, buildReminderEvent, reminderEventId, desiredReminders, fingerprint };
