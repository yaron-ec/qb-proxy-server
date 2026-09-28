/* eslint-disable no-undef */
/**
 * phoneCallIntegrity — READ-ONLY, aggregate proof that a Phone Call is a
 * follow-up/reminder and never an appointment, against live data:
 *
 *   - legacy Phone Call appointment rows still active in the future (should be
 *     0 after conversion, except rows recorded as 'ambiguous');
 *   - conversions by action (+ the ambiguous rows, by short ref only);
 *   - active future Phone Call follow-ups vs. their reminder events
 *     (synced / pending / failed);
 *   - Google: reminder events per lead (duplicates), reminder events that are
 *     not "free", orphan reminders, legacy Phone Call main events and Travel
 *     events tied to Phone Call rows, external events;
 *   - availability probes: for the next Phone Call follow-ups, whether the
 *     Phone Call's own slot is blocked and by what (a Phone Call-attributable
 *     blocker must be 0), and — for the same days — whether genuine external
 *     Google events still block their slots;
 *   - calendar outbox + worker heartbeat.
 *
 * No names, phones, emails, notes, event titles, record ids, dates or times
 * are returned — counts and booleans only. Never writes anything. Served
 * admin-only by routes/systemHealth.js.
 */
'use strict';

const { query } = require('../../db/client');
const googleCalendarClient = require('./googleCalendarClient');
const { getAvailability, CALENDAR_ID } = require('./availabilityService');
const { isExcluded, eventTimesToUtcMs, BUFFER_MS } = require('./googleAvailability');
const { desiredReminders, buildReminderEvent } = require('./followUpReminders');
const { followUpStartIso, TZ, EC_KIND_FOLLOWUP_REMINDER, EC_KIND_TRAVEL } = require('./phoneCallModel');
const { toUtcIso, SLOTS } = require('./slotBlocking');

const LOOKAHEAD_DAYS = 30;
const PROBES = 5;
const laDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function tableExists(name) {
  const r = await query('SELECT to_regclass($1) AS t', [name]);
  return !!r.rows[0].t;
}

async function listGoogleEvents(from, days) {
  const out = [];
  for (let i = 0; i < days; i += 7) {
    const a = new Date(from.getTime() + i * 86400000);
    const b = new Date(from.getTime() + Math.min(i + 7, days) * 86400000);
    out.push(...await googleCalendarClient.listEvents(CALENDAR_ID, a.toISOString(), b.toISOString()));
  }
  const seen = new Set();
  return out.filter((e) => e && e.id && !seen.has(e.id) && seen.add(e.id));
}

async function phoneCallIntegrity({ now = new Date(), google = true } = {}) {
  const report = { generated_at: now.toISOString(), commit: process.env.RAILWAY_GIT_COMMIT_SHA || null, lookahead_days: LOOKAHEAD_DAYS };
  const schemaReady = await tableExists('followup_calendar_reminders') && await tableExists('legacy_phone_call_conversions');
  report.schema_ready = schemaReady;

  // ── Legacy Phone Call appointment rows (unbuffered busy_range) ────────────
  const legacy = (await query(
    `SELECT count(*) FILTER (WHERE status IN ('scheduled','confirmed') AND start_at > $1)::int AS active_future,
            count(*) FILTER (WHERE status IN ('scheduled','confirmed') AND start_at > $1 AND google_event_id IS NOT NULL)::int AS active_future_with_google_event,
            count(*) FILTER (WHERE google_travel_event_id IS NOT NULL)::int AS with_travel_event_any_status,
            count(*) FILTER (WHERE google_travel_event_id IS NOT NULL AND start_at > $1)::int AS future_with_travel_event,
            count(*)::int AS total_any_status
       FROM appointments WHERE lower(busy_range) >= start_at`, [now])).rows[0];
  report.legacy_phone_call_rows = legacy;

  const travelOutbox = (await query(
    `SELECT count(*)::int AS n FROM calendar_outbox o JOIN appointments a ON a.id = o.appointment_id
      WHERE lower(a.busy_range) >= a.start_at AND o.action IN ('create_travel','update_travel')
        AND o.status IN ('pending','processing','failed')`)).rows[0].n;
  report.phone_call_travel_outbox_pending = travelOutbox;

  if (schemaReady) {
    report.conversions = Object.fromEntries((await query(
      'SELECT action, count(*)::int AS n FROM legacy_phone_call_conversions GROUP BY action')).rows.map((r) => [r.action, r.n]));
    report.ambiguous_legacy_rows = (await query(
      `SELECT c.appointment_id, c.reason, a.start_at, a.status
         FROM legacy_phone_call_conversions c LEFT JOIN appointments a ON a.id = c.appointment_id
        WHERE c.action = 'ambiguous' ORDER BY a.start_at`)).rows
      .map((r) => ({ reason: r.reason, status: r.status, future: !!r.start_at && new Date(r.start_at) > now }));
  }

  // ── Canonical follow-ups vs. reminder state ───────────────────────────────
  const desired = await desiredReminders({ query }, now);
  const state = schemaReady
    ? new Map((await query('SELECT * FROM followup_calendar_reminders')).rows.map((r) => [String(r.lead_id), r]))
    : new Map();
  const rem = { active_future_phone_call_followups: desired.length, synced: 0, pending: 0, failed: 0 };
  const expectedIds = new Map();
  const expectedStart = new Map();
  for (const lead of desired) {
    const row = state.get(String(lead.id));
    const body = buildReminderEvent(lead, '', row ? row.generation : 0);
    expectedIds.set(body.id, String(lead.id));
    expectedStart.set(body.id, followUpStartIso(lead));
    if (row && row.status === 'active' && !row.last_error && row.google_event_id === body.id
      && new Date(row.start_at).getTime() === new Date(followUpStartIso(lead)).getTime()) rem.synced++;
    else if (row && row.last_error) rem.failed++;
    else rem.pending++;
  }
  rem.state_rows_by_status = {};
  for (const r of state.values()) rem.state_rows_by_status[r.status] = (rem.state_rows_by_status[r.status] || 0) + 1;
  report.reminders = rem;

  // ── Calendar outbox + worker heartbeat ────────────────────────────────────
  report.calendar_outbox = Object.fromEntries((await query(
    `SELECT status, count(*)::int AS n FROM calendar_outbox WHERE status <> 'synced' GROUP BY status`)).rows.map((r) => [r.status, r.n]));
  if (await tableExists('followup_reminder_runs')) {
    const hb = (await query('SELECT last_run_at, last_stats, commit_sha FROM followup_reminder_runs WHERE id = 1')).rows[0];
    report.worker = hb ? { last_run_at: hb.last_run_at, commit: hb.commit_sha, last_stats: hb.last_stats } : null;
  }

  if (!google) return report;

  // ── Google Calendar (read-only listing) ───────────────────────────────────
  const g = { calendar_events_listed: 0, reminder_events: 0, reminder_leads_with_duplicates: 0, reminder_events_not_transparent: 0,
    reminder_events_unexpected: 0, expected_reminders_missing: 0, legacy_phone_call_main_events: 0,
    travel_events_for_phone_calls: 0, external_events: 0, external_events_free: 0, external_events_all_day: 0, external_events_blocking: 0 };
  let events = [];
  try {
    // Past window too: external busy events there prove blocking just as well
    // (availability for a past date is a pure read).
    events = await listGoogleEvents(new Date(now.getTime() - LOOKAHEAD_DAYS * 86400000), 2 * LOOKAHEAD_DAYS);
  } catch (e) {
    report.google = { error: 'calendar_unavailable', message: String(e.message || e).slice(0, 120) };
    return report;
  }
  g.calendar_events_listed = events.length;
  const apptIds = [...new Set(events.map((e) => ((e.extendedProperties || {}).private || {}).ec_appointment_id).filter(Boolean))]
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const phoneCallRowIds = new Set(apptIds.length ? (await query(
    'SELECT id FROM appointments WHERE id = ANY($1::uuid[]) AND lower(busy_range) >= start_at', [apptIds])).rows.map((r) => String(r.id)) : []);
  const perLead = new Map();
  const seenExpected = new Set();
  const externalByDay = new Map();
  for (const e of events) {
    const p = (e.extendedProperties || {}).private || {};
    const et = eventTimesToUtcMs(e, TZ);
    const future = !!et && et.endMs > now.getTime();
    // Past CRM events are history; only external ones are used (blocking probes).
    if (!future && (p.ec_kind || p.ec_appointment_id)) continue;
    if (p.ec_kind === EC_KIND_FOLLOWUP_REMINDER) {
      g.reminder_events++;
      perLead.set(p.ec_lead_id, (perLead.get(p.ec_lead_id) || 0) + 1);
      if (e.transparency !== 'transparent') g.reminder_events_not_transparent++;
      if (expectedIds.has(e.id)) seenExpected.add(e.id); else g.reminder_events_unexpected++;
      continue;
    }
    const isPhoneCallRow = p.ec_appointment_id && phoneCallRowIds.has(String(p.ec_appointment_id));
    if (p.ec_kind === EC_KIND_TRAVEL) { if (isPhoneCallRow) g.travel_events_for_phone_calls++; continue; }
    if (isPhoneCallRow || p.ec_appointment_kind === 'phone_call') { g.legacy_phone_call_main_events++; continue; }
    if (p.ec_appointment_id) continue; // a real CRM appointment (Meeting / Site Visit)
    g.external_events++;
    if (e.transparency === 'transparent') g.external_events_free++;
    if (e.start && !e.start.dateTime) g.external_events_all_day++;
    if (!isExcluded(e)) {
      g.external_events_blocking++;
      const t = et;
      if (t && e.start && e.start.dateTime) {
        const day = laDate(new Date(t.startMs));
        if (!externalByDay.has(day)) externalByDay.set(day, t);
      }
    }
  }
  g.reminder_leads_with_duplicates = [...perLead.values()].filter((n) => n > 1).length;
  // Only reminders inside the listed window can be compared.
  g.expected_reminders_missing = [...expectedIds.keys()].filter((id) => !seenExpected.has(id)
    && Date.parse(expectedStart.get(id)) < now.getTime() + LOOKAHEAD_DAYS * 86400000).length;
  g.expected_reminders_beyond_window = [...expectedIds.keys()].filter((id) => !seenExpected.has(id)).length - g.expected_reminders_missing;
  report.google = g;

  // ── Availability probes (read-only getAvailability) ───────────────────────
  const ownerIds = new Map((await query('SELECT id, lower(email) AS email FROM owners WHERE is_active = true')).rows.map((r) => [r.email, r.id]));
  const probes = [];
  for (const lead of desired.slice().sort((a, b) => followUpStartIso(a).localeCompare(followUpStartIso(b))).slice(0, PROBES)) {
    const time = String(lead.follow_up_time).slice(0, 5);
    const ownerId = lead.owner_email ? ownerIds.get(String(lead.owner_email).toLowerCase()) || null : null;
    try {
      const a = await getAvailability({ owner_id: ownerId, date: lead.follow_up_date, timezone: TZ, duration_minutes: 60 });
      const cs = new Date(followUpStartIso(lead)).getTime();
      const ce = cs + 60 * 60000;
      const blockers = a.busy_windows.filter((w) => cs < Date.parse(w.end) && ce > Date.parse(w.start));
      const reminderIds = new Set(expectedIds.keys());
      probes.push({
        owner_resolved: !!ownerId,
        slot_on_grid: SLOTS.includes(time),
        slot_blocked: a.blocked_slots.includes(time) || blockers.length > 0,
        blockers_by_source: blockers.reduce((m, w) => { m[w.source] = (m[w.source] || 0) + 1; return m; }, {}),
        phone_call_attributable_blockers: blockers.filter((w) => (w.google_event_id && reminderIds.has(w.google_event_id))
          || (w.ec_appointment_id && phoneCallRowIds.has(String(w.ec_appointment_id)))).length,
      });
    } catch (e) {
      probes.push({ error: e.code || 'error' });
    }
  }
  report.phone_call_slot_probes = probes;

  // External busy events must still block: probe up to PROBES days that have one.
  const ext = [];
  for (const [day, t] of [...externalByDay.entries()].slice(0, PROBES)) {
    try {
      const a = await getAvailability({ owner_id: null, date: day, timezone: TZ, duration_minutes: 60 });
      // Every grid slot whose [slot, slot+60m] overlaps the event ±1h must be blocked.
      const expected = SLOTS.filter((s) => {
        const st = Date.parse(toUtcIso(day, s, TZ));
        return st < t.endMs + BUFFER_MS && st + 3600000 > t.startMs - BUFFER_MS;
      });
      ext.push({ expected_blocked_slots: expected.length,
        actually_blocked: expected.filter((s) => a.blocked_slots.includes(s)).length });
    } catch (e) {
      ext.push({ error: e.code || 'error' });
    }
  }
  report.external_busy_probes = ext;

  // Deployed-code probe (in memory, nothing written or sent): an unmarked,
  // opaque external event still becomes a ±1h busy window that blocks slots,
  // while the same event carrying the CRM reminder marker does not.
  const { eventToBusyWindow } = require('./googleAvailability');
  const { computeBlockedSlots } = require('./slotBlocking');
  const day = laDate(new Date(now.getTime() + 86400000));
  const synthetic = { id: 'synthetic', status: 'confirmed', start: { dateTime: toUtcIso(day, '13:00', TZ) }, end: { dateTime: toUtcIso(day, '14:00', TZ) } };
  const blockedBy = (ev) => (isExcluded(ev) ? [] : computeBlockedSlots(SLOTS, day, TZ, 60, [eventToBusyWindow(ev, TZ)]));
  report.classifier_probe = {
    external_opaque_blocked_slots: blockedBy(synthetic).length,
    same_event_as_crm_reminder_blocked_slots: blockedBy({ ...synthetic, extendedProperties: { private: { ec_kind: EC_KIND_FOLLOWUP_REMINDER, ec_blocking: 'false' } } }).length,
  };
  return report;
}

module.exports = { phoneCallIntegrity };
