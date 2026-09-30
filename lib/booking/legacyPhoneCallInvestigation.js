/* eslint-disable no-undef */
/**
 * legacyPhoneCallInvestigation — READ-ONLY provenance for the legacy Phone Call
 * appointment rows the conversion recorded as 'ambiguous'
 * (legacy_phone_call_conversions.action = 'ambiguous').
 *
 * Returns, per row, only what decides whether the old call is stale: times,
 * statuses, types, actors and timestamps from the appointment, its audit
 * events and outbox jobs, its Google event, the lead's current follow-up, the
 * reminder projection and reminder sends, and the lead's activity timeline
 * (type/source/timestamp plus keyword flags — never the text). No names,
 * phones, emails, addresses or notes. Never writes. Admin-only
 * (routes/systemHealth.js).
 */
'use strict';

const { query } = require('../../db/client');
const googleCalendarClient = require('./googleCalendarClient');
const { CALENDAR_ID, dwdSubjectFallback } = require('./calendarOutbox');
const { TZ } = require('./phoneCallModel');

const la = (d) => {
  if (!d) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};
const iso = (d) => (d ? new Date(d).toISOString() : null);
const flags = (text) => {
  const t = String(text || '').toLowerCase();
  return {
    phone_call: /phone call|\bcall\b|called/.test(t),
    reschedule: /reschedul|moved|changed/.test(t),
    cancel: /cancel/.test(t),
    follow_up: /follow[- ]?up/.test(t),
    no_answer: /no answer|voicemail|\bvm\b|didn.?t answer/.test(t),
  };
};

async function investigateAmbiguousLegacyPhoneCalls({ now = new Date(), google = googleCalendarClient } = {}) {
  const recs = (await query(
    `SELECT c.*, a.* , c.created_at AS recorded_at, a.created_at AS appt_created_at, a.updated_at AS appt_updated_at,
            t.name AS appointment_type_name
       FROM legacy_phone_call_conversions c
       JOIN appointments a ON a.id = c.appointment_id
       LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
      WHERE c.action = 'ambiguous' ORDER BY a.start_at`)).rows;
  const out = [];
  for (const a of recs) {
    const lead = a.lead_id ? (await query('SELECT * FROM leads WHERE id = $1', [a.lead_id])).rows[0] : null;
    const leadKeys = lead ? [String(lead.id), lead.external_ref].filter(Boolean) : [];

    const events = (await query(
      `SELECT action, actor, previous_values, new_values, created_at FROM appointment_events WHERE appointment_id = $1 ORDER BY created_at`, [a.id])).rows
      .map((e) => ({
        action: e.action, actor: e.actor, at: iso(e.created_at),
        prev_start: la(e.previous_values && e.previous_values.start_at), new_start: la(e.new_values && e.new_values.start_at),
        prev_status: e.previous_values && e.previous_values.status, new_status: e.new_values && e.new_values.status,
      }));
    const outbox = (await query(
      `SELECT action, status, created_at, updated_at, last_error FROM calendar_outbox WHERE appointment_id = $1 ORDER BY created_at`, [a.id])).rows
      .map((o) => ({ action: o.action, status: o.status, at: iso(o.created_at), note: o.last_error ? String(o.last_error).slice(0, 80) : null }));

    let googleEvent = { has_event_id: !!a.google_event_id };
    if (a.google_event_id) {
      try {
        const subject = CALENDAR_ID && CALENDAR_ID.includes('@') ? CALENDAR_ID : await dwdSubjectFallback();
        const token = await google.getAccessToken(subject);
        const g = await google.getEvent(token, CALENDAR_ID, a.google_event_id);
        const ev = g.event || {};
        const p = (ev.extendedProperties && ev.extendedProperties.private) || {};
        const startMs = ev.start && ev.start.dateTime ? Date.parse(ev.start.dateTime) : null;
        googleEvent = {
          has_event_id: true, exists: !!g.exists, status: ev.status || null, start: startMs ? la(startMs) : null,
          future: startMs ? startMs > now.getTime() : null, transparency: ev.transparency || 'opaque',
          ec_kind: p.ec_kind || null, ec_appointment_kind: p.ec_appointment_kind || null,
          matches_row_start: startMs ? startMs === new Date(a.start_at).getTime() : null,
        };
      } catch (e) { googleEvent = { has_event_id: true, error: String(e.message || e).slice(0, 80) }; }
    }

    const activities = lead ? (await query(
      `SELECT type, source, author, content, metadata, created_at FROM activities WHERE lead_id = $1 ORDER BY created_at`, [lead.id])).rows
      .map((x) => ({ type: x.type, source: x.source, by_system: !x.author || /system|crm|worker|website|meta/i.test(String(x.author)),
        at: iso(x.created_at), mentions: flags(x.content), metadata_keys: x.metadata ? Object.keys(x.metadata).slice(0, 10) : [] })) : [];

    const projection = leadKeys.length ? (await query(
      `SELECT follow_up_date, follow_up_time, follow_up_type, appointment_date, appointment_time, appointment_type, updated_at
         FROM reminder_leads WHERE id = ANY($1::text[])`, [leadKeys])).rows.map((r) => ({ ...r, updated_at: iso(r.updated_at) })) : [];
    const claims = leadKeys.length ? (await query(
      `SELECT reminder_key, appointment_date, reminder_window, status, sent_at, created_at FROM reminder_claims
        WHERE lead_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 30`, [leadKeys])).rows
      .map((c) => ({ kind: String(c.reminder_key || '').split(':')[0], date: c.appointment_date ? iso(c.appointment_date).slice(0, 10) : null,
        window: c.reminder_window, status: c.status, sent_at: iso(c.sent_at) })) : [];
    const notifications = leadKeys.length ? (await query(
      `SELECT notification_type, status, created_at, sent_at FROM reminder_notifications WHERE lead_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 30`,
      [leadKeys])).rows.map((n) => ({ type: n.notification_type, status: n.status, at: iso(n.created_at), sent_at: iso(n.sent_at) })) : [];
    const reminderEvent = lead ? (await query(
      `SELECT status, start_at, synced_at FROM followup_calendar_reminders WHERE lead_id = $1`, [lead.id])).rows
      .map((r) => ({ status: r.status, start: la(r.start_at), synced_at: iso(r.synced_at) }))[0] || null : null;
    const otherAppointments = lead ? (await query(
      `SELECT start_at, status, created_at, lower(busy_range) >= start_at AS phone_call_shaped FROM appointments
        WHERE lead_id = $1 AND id <> $2 ORDER BY created_at`, [lead.id, a.id])).rows
      .map((o) => ({ start: la(o.start_at), status: o.status, created_at: iso(o.created_at), phone_call_shaped: o.phone_call_shaped })) : [];

    out.push({
      ref: String(a.id).slice(0, 8),
      reason: a.reason,
      legacy_appointment: {
        start: la(a.start_at), duration_min: Math.round((new Date(a.end_at) - new Date(a.start_at)) / 60000),
        status: a.status, type: a.appointment_type_name || null, created_at: iso(a.appt_created_at), updated_at: iso(a.appt_updated_at),
        version: a.version, calendar_sync_status: a.calendar_sync_status, has_travel_event: !!a.google_travel_event_id,
        idempotency_source: a.idempotency_key ? String(a.idempotency_key).split(/[-:_]/)[0] : null,
        future: new Date(a.start_at) > now,
      },
      audit_events: events,
      outbox_jobs: outbox,
      google_event: googleEvent,
      lead: lead ? {
        status: lead.status, source: lead.source || null, created_at: iso(lead.created_at), updated_at: iso(lead.updated_at),
        follow_up: { type: lead.follow_up_type, date: lead.follow_up_date, time: lead.follow_up_time, status: lead.follow_up_status,
          has_notes: !!lead.follow_up_notes },
      } : null,
      reminder_projection: projection,
      reminder_claims: claims,
      reminder_notifications: notifications,
      followup_reminder_event: reminderEvent,
      other_appointments: otherAppointments,
      activities,
    });
  }
  return { generated_at: now.toISOString(), commit: process.env.RAILWAY_GIT_COMMIT_SHA || null, rows: out };
}

module.exports = { investigateAmbiguousLegacyPhoneCalls };
