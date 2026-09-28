/* eslint-disable no-undef */
/**
 * legacyPhoneCallConversion — move legacy Phone Call APPOINTMENT rows (created
 * before the "a Phone Call is a follow-up" rule; recognisable by their
 * unbuffered busy_range, see appointmentKind) onto the lead's canonical
 * Phone Call follow-up, so a Phone Call has exactly one calendar presence:
 * the non-blocking follow-up reminder.
 *
 * Narrow, deterministic scope — only ACTIVE ('scheduled'/'confirmed') legacy
 * Phone Call rows whose time is still AHEAD. Past rows are history and are
 * left alone (they are non-blocking by construction anyway).
 *
 *   converted     the lead has NO active follow-up → the lead's follow-up
 *                 becomes this Phone Call (same Pacific date/time, pending);
 *                 the legacy row is cancelled (its Google event is removed via
 *                 the calendar outbox; no travel is ever created).
 *   deduplicated  the lead already has the SAME Phone Call follow-up (same
 *                 date and time) → only the duplicate legacy row is cancelled.
 *   ambiguous     anything else (a different active follow-up, a closed
 *                 lead, a missing lead) → NOTHING is changed; recorded once for
 *                 review. Such a row still never blocks availability.
 *
 * Every change is backed up first in legacy_phone_call_conversions (the full
 * appointment row + the lead's previous follow-up fields) inside the SAME
 * transaction, so it is reversible (scripts/revertLegacyPhoneCallConversion.js).
 * Idempotent: a converted/deduplicated row is no longer active, an ambiguous
 * one is recorded once (appointment_id primary key).
 */
'use strict';

const calendarOutbox = require('./calendarOutbox');
const { isPhoneCallAppointment } = require('./appointmentKind');
const { TZ } = require('./phoneCallModel');

const CLOSED_LEAD_STATUSES = ['Lost', 'DNQ'];

function laDateTime(iso) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

const FOLLOW_UP_FIELDS = ['follow_up_date', 'follow_up_time', 'follow_up_type', 'follow_up_notes', 'follow_up_status'];
const hasActiveFollowUp = (l) => !!l.follow_up_date && l.follow_up_status !== 'completed';

/** Decide what to do with one legacy row (pure). */
function classify(appt, lead) {
  if (!lead) return { action: 'ambiguous', reason: 'lead_missing' };
  if (CLOSED_LEAD_STATUSES.includes(lead.status)) return { action: 'ambiguous', reason: `lead_status_${lead.status}` };
  const { date, time } = laDateTime(appt.start_at);
  if (!hasActiveFollowUp(lead)) return { action: 'converted', date, time };
  const same = lead.follow_up_type === 'Phone Call' && lead.follow_up_date === date && String(lead.follow_up_time || '').slice(0, 5) === time;
  if (same) return { action: 'deduplicated', date, time };
  return { action: 'ambiguous', reason: 'lead_has_different_active_follow_up' };
}

async function convertLegacyPhoneCallAppointments(pool, opts = {}) {
  const now = opts.now || new Date();
  const limit = opts.limit || 25;
  const { syncLeadToReminders } = opts.reminderProjection || require('../reminderProjection');
  const stats = { candidates: 0, converted: 0, deduplicated: 0, ambiguous: 0, errors: 0 };

  const candidates = (await pool.query(
    `SELECT a.id FROM appointments a
      WHERE a.status IN ('scheduled','confirmed')
        AND lower(a.busy_range) >= a.start_at
        AND a.start_at > $1
        AND NOT EXISTS (SELECT 1 FROM legacy_phone_call_conversions c WHERE c.appointment_id = a.id)
      ORDER BY a.start_at LIMIT $2`, [now, limit])).rows;
  stats.candidates = candidates.length;

  for (const { id } of candidates) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const appt = (await client.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!appt || !['scheduled', 'confirmed'].includes(appt.status) || !isPhoneCallAppointment(appt)) {
        await client.query('ROLLBACK');
        continue;
      }
      const lead = appt.lead_id ? (await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [appt.lead_id])).rows[0] : null;
      const c = classify(appt, lead);
      const before = lead ? Object.fromEntries(FOLLOW_UP_FIELDS.map((f) => [f, lead[f] ?? null])) : null;
      await client.query(
        `INSERT INTO legacy_phone_call_conversions (appointment_id, lead_id, action, reason, appointment_before, lead_followup_before)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (appointment_id) DO NOTHING`,
        [appt.id, appt.lead_id || null, c.action, c.reason || null, JSON.stringify(appt), before ? JSON.stringify(before) : null]);

      if (c.action === 'ambiguous') {
        await client.query('COMMIT');
        stats.ambiguous++;
        continue;
      }
      if (c.action === 'converted') {
        await client.query(
          `UPDATE leads SET follow_up_type = 'Phone Call', follow_up_date = $2, follow_up_time = $3,
                  follow_up_status = 'pending', updated_at = NOW()
            WHERE id = $1`, [lead.id, c.date, c.time]);
      }
      // Cancel the legacy row exactly like bookingService.cancelAppointment.
      await client.query(`UPDATE appointments SET status = 'cancelled', version = version + 1, updated_at = NOW() WHERE id = $1`, [appt.id]);
      await client.query(
        `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values)
         VALUES ($1, 'system:legacy-phone-call-conversion', 'cancelled', $2, $3)`,
        [appt.id, JSON.stringify({ status: appt.status, start_at: appt.start_at, end_at: appt.end_at }),
          JSON.stringify({ status: 'cancelled', reason: `phone_call_${c.action}_to_follow_up` })]);
      const cancelled = (await client.query('SELECT * FROM appointments WHERE id = $1', [appt.id])).rows[0];
      await calendarOutbox.enqueueCancel(client, cancelled, cancelled.version, true);
      const leadRow = (await client.query(
        `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
           FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`, [lead.id])).rows[0];
      await client.query('SAVEPOINT legacy_pc_projection');
      try {
        await syncLeadToReminders(client, leadRow);
        await client.query('RELEASE SAVEPOINT legacy_pc_projection');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT legacy_pc_projection');
        console.warn('[legacy-phone-call] reminder projection failed (non-fatal):', e.message);
      }
      await client.query('COMMIT');
      stats[c.action]++;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      stats.errors++;
      console.error('[legacy-phone-call] conversion failed for appointment', id, ':', e.message);
    } finally {
      client.release();
    }
  }
  return stats;
}

module.exports = { convertLegacyPhoneCallAppointments, classify, laDateTime };
