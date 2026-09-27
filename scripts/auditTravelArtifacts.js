#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditTravelArtifacts — find (and, only where provenance is PROVEN, remove)
 * "Driving / Travel Time" calendar events that do not belong to an active real
 * Appointment / Site Visit.
 *
 * READ-ONLY BY DEFAULT.
 *
 *   node scripts/auditTravelArtifacts.js [--json] [--no-google] [--days=120]
 *   node scripts/auditTravelArtifacts.js --apply --confirm-host=<db host> [--json]
 *
 * ── The rule (lib/booking/appointmentKind.js#travelAllowed) ───────────────────
 * A travel event may exist only for an ACTIVE appointment whose busy_range is a
 * Site Visit's (1h before + duration + 1h after). A Phone Call is a follow-up;
 * a legacy Phone Call booking (unbuffered row), a cancelled/rescheduled
 * appointment and every follow-up must never have one.
 *
 * ── Where invalid travel came from (traced in code) ──────────────────────────
 *  - A Phone Call was modelled as an appointment "kind" inferred from the
 *    busy_range shape; PUT /leads/:id/appointment defaulted a missing
 *    appointment_type to 'Meeting', so re-saving a Phone Call booking without
 *    the type re-booked it as a Site Visit WITH a 1h buffer and a Driving /
 *    Travel Time event. (Fixed: a Phone Call can no longer be an appointment.)
 *  - The calendar worker processed a queued create_travel without re-checking
 *    the appointment, so a travel job queued before the row changed (cancelled,
 *    rescheduled, converted) still created the event. (Fixed: re-validated.)
 *  - A successful cancel_travel never cleared appointments.google_travel_event_id,
 *    so links to already-deleted events accumulated. (Fixed.)
 *
 * ── Classes ──────────────────────────────────────────────────────────────────
 *  Google-side (our own events carry extendedProperties.private.ec_kind='travel'
 *  and ec_appointment_id — that marker is the provenance proof):
 *   TRAVEL_VALID               active Site Visit, event = its current travel id → untouched
 *   TRAVEL_ON_PHONE_CALL       appointment is a (legacy) Phone Call            → APPLY cancel
 *   TRAVEL_ON_INACTIVE         appointment cancelled/rescheduled               → APPLY cancel
 *                              (a completed / no-show Site Visit's travel is history → valid)
 *   TRAVEL_ON_MIGRATED_MEETING Base44-migrated 'General Meeting' stored unbuffered → report
 *                              (looks like a Phone Call, is not provably one)
 *   TRAVEL_STALE_SLOT          active Site Visit, but not its current travel id → APPLY cancel
 *   TRAVEL_NO_APPOINTMENT      ec_appointment_id matches no row                → report
 *   TRAVEL_UNMARKED            "Driving / Travel Time" without our marker      → report
 *  DB-side:
 *   LINK_ON_PHONE_CALL / LINK_ON_INACTIVE  google_travel_event_id on such a row,
 *                              upcoming, no completed cancel on record          → APPLY cancel
 *   LINK_ALREADY_CANCELLED     a synced cancel_travel exists for it            → report (stale link)
 *   INVALID_TRAVEL_JOB         queued create/update_travel for such a row      → report (the
 *                              worker now refuses it: 'skipped: travel_not_allowed')
 *   LEGACY_PHONE_CALL_BOOKING  active upcoming Phone Call appointment row       → report only
 *                              (a data-model conversion, not an artifact cleanup)
 *
 * Only past-safe, upcoming (start >= now - 12h) artifacts are applied; past
 * calendar history is reported, never touched. --apply never deletes rows and
 * never calls Google directly: it enqueues calendar_outbox 'cancel_travel' rows
 * (the calendar worker deletes the event; a successful cancel clears the link)
 * and writes an immutable appointment_events audit row with the before-image.
 * Idempotent: fixed idempotency keys; a cancelled event is no longer listed.
 * The JSON report carries the full before-image (event bodies + links).
 */
'use strict';

const crypto = require('crypto');
const { pool } = require('../db/client');
const { travelAllowed, isPhoneCallAppointment } = require('../lib/booking/appointmentKind');

const ACTOR_PREFIX = 'audit:travel-artifacts:';
const args = process.argv.slice(2);
const flag = (n) => args.some(a => a === `--${n}` || a.startsWith(`--${n}=`));
const flagVal = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const APPLY_FROM_MS = () => Date.now() - 12 * 3600 * 1000;

function kindOf(a) { return isPhoneCallAppointment(a) ? 'Phone Call' : 'Site Visit'; }

// Why a travel event on this appointment is invalid — or null when it is legit.
// A completed / no-show Site Visit's travel is real history (valid). A Base44
// migration row typed 'General Meeting' was stored unbuffered, so it only LOOKS
// like a Phone Call: never proven, always reported (see auditAppointmentFollowUp).
function invalidReason(a) {
  if (a.idempotency_key && String(a.idempotency_key).startsWith('migration:appt:') && a.type_name === 'General Meeting'
      && isPhoneCallAppointment(a)) return 'ambiguous_migrated_meeting';
  if (isPhoneCallAppointment(a)) return 'phone_call';
  if (['cancelled', 'rescheduled'].includes(a.status)) return 'inactive';
  return null;
}

function classifyGoogleEvent(ev, apptById, currentTravelId) {
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  const isOurs = priv.ec_kind === 'travel' && priv.ec_appointment_id;
  if (!isOurs) {
    return /driving\s*\/\s*travel time/i.test(ev.summary || '') ? { cls: 'TRAVEL_UNMARKED', apply: false } : null;
  }
  const a = apptById.get(String(priv.ec_appointment_id));
  if (!a) return { cls: 'TRAVEL_NO_APPOINTMENT', apply: false };
  const why = invalidReason(a);
  if (why === 'ambiguous_migrated_meeting') return { cls: 'TRAVEL_ON_MIGRATED_MEETING', apply: false, appt: a };
  if (why === 'phone_call') return { cls: 'TRAVEL_ON_PHONE_CALL', apply: true, appt: a };
  if (why === 'inactive') return { cls: 'TRAVEL_ON_INACTIVE', apply: true, appt: a };
  if (ev.id === a.google_travel_event_id || ev.id === currentTravelId(a)) return { cls: 'TRAVEL_VALID', apply: false, appt: a };
  if (!travelAllowed(a)) return { cls: 'TRAVEL_VALID', apply: false, appt: a }; // completed/no-show history
  return { cls: 'TRAVEL_STALE_SLOT', apply: true, appt: a };
}

async function listGoogleTravel(days) {
  const gc = require('../lib/booking/googleCalendarClient');
  const { CALENDAR_ID } = require('../lib/booking/calendarOutbox');
  const out = [];
  const DAY = 86400000;
  const start = Date.now() - DAY;
  for (let t = start; t < start + days * DAY; t += DAY) {
    const items = await gc.listEvents(CALENDAR_ID, new Date(t).toISOString(), new Date(t + DAY).toISOString());
    for (const ev of items) {
      const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
      if (priv.ec_kind === 'travel' || /driving\s*\/\s*travel time/i.test(ev.summary || '')) out.push(ev);
    }
  }
  return out;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return '?'; } })();
  const apply = flag('apply');
  if (apply && flagVal('confirm-host') !== host) {
    console.error(`--apply requires --confirm-host=${host} (the DATABASE_URL host). Nothing changed.`);
    process.exit(2);
  }
  const days = Math.max(1, Math.min(365, Number(flagVal('days')) || 120));
  const runId = apply ? `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}` : null;
  const outbox = require('../lib/booking/calendarOutbox');
  const currentTravelId = (a) => outbox.buildOperation(a, null, null, 'travel').googleEventId;

  const report = { database_host: host, generated_at: new Date().toISOString(), mode: apply ? 'apply' : 'report-only',
    run_id: runId, google_scanned: false, google_error: null, window_days: days,
    counts: {}, apply_candidates: {}, records: [], backup: [], applied: null };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const add = (rec) => { bump(report.counts, rec.class); if (rec.apply) bump(report.apply_candidates, rec.class); report.records.push(rec); };

  // DB: every appointment that carries a travel link, or is a legacy Phone Call, or has a queued travel job.
  const appts = (await pool.query(
    `SELECT a.*, t.name AS type_name,
            EXISTS (SELECT 1 FROM calendar_outbox o WHERE o.appointment_id = a.id AND o.action = 'cancel_travel'
                     AND o.google_event_id = a.google_travel_event_id AND o.status = 'synced') AS travel_cancel_done
       FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
      WHERE a.google_travel_event_id IS NOT NULL
         OR (lower(a.busy_range) >= a.start_at AND a.status IN ('scheduled','confirmed'))
         OR EXISTS (SELECT 1 FROM calendar_outbox o WHERE o.appointment_id = a.id
                     AND o.action IN ('create_travel','update_travel') AND o.status IN ('pending','failed','processing'))`)).rows;
  const apptById = new Map(appts.map(a => [String(a.id), a]));
  const upcoming = (a) => new Date(a.start_at).getTime() >= APPLY_FROM_MS();
  const targets = new Map(); // google event id → { appt, source }

  for (const a of appts) {
    const base = { appointment_id: a.id, lead_id: a.lead_id, status: a.status, kind: kindOf(a),
      start_at: a.start_at, google_travel_event_id: a.google_travel_event_id };
    const why = invalidReason(a);
    if (a.google_travel_event_id && why === 'ambiguous_migrated_meeting') {
      add({ class: 'LINK_ON_MIGRATED_MEETING', apply: false, reason: 'migrated General Meeting stored unbuffered — not provably a Phone Call', ...base });
    } else if (a.google_travel_event_id && why) {
      if (a.travel_cancel_done) add({ class: 'LINK_ALREADY_CANCELLED', apply: false, ...base });
      else {
        const cls = why === 'phone_call' ? 'LINK_ON_PHONE_CALL' : 'LINK_ON_INACTIVE';
        const ok = upcoming(a);
        add({ class: cls, apply: ok, reason: ok ? null : 'past — history left untouched', ...base });
        if (ok) targets.set(a.google_travel_event_id, { appt: a, source: cls });
      }
    }
    if (why === 'phone_call' && ['scheduled', 'confirmed'].includes(a.status) && upcoming(a)) {
      add({ class: 'LEGACY_PHONE_CALL_BOOKING', apply: false, reason: 'report only: converting a booking is a data-model change', ...base });
    }
  }
  const jobs = (await pool.query(
    `SELECT o.id, o.appointment_id, o.action, o.status FROM calendar_outbox o
      WHERE o.action IN ('create_travel','update_travel') AND o.status IN ('pending','failed','processing')`)).rows;
  for (const j of jobs) {
    const a = apptById.get(String(j.appointment_id));
    if (a && !travelAllowed(a) && invalidReason(a) !== 'ambiguous_migrated_meeting') add({ class: 'INVALID_TRAVEL_JOB', apply: false, reason: 'worker refuses it (skipped: travel_not_allowed)', outbox_id: j.id, appointment_id: j.appointment_id, action: j.action, status: j.status });
  }

  // Google: our own travel events (read-only listing).
  if (!flag('no-google')) {
    try {
      const events = await listGoogleTravel(days);
      report.google_scanned = true;
      const ids = [...new Set(events.map(e => (e.extendedProperties && e.extendedProperties.private || {}).ec_appointment_id).filter(Boolean))];
      if (ids.length) {
        const more = (await pool.query(
          'SELECT a.*, t.name AS type_name FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id WHERE a.id = ANY($1::uuid[])', [ids])).rows;
        for (const a of more) if (!apptById.has(String(a.id))) apptById.set(String(a.id), a);
      }
      for (const ev of events) {
        const c = classifyGoogleEvent(ev, apptById, currentTravelId);
        if (!c) continue;
        const rec = { class: c.cls, apply: c.apply, google_event_id: ev.id, summary: ev.summary || null,
          start: ev.start, end: ev.end, appointment_id: c.appt ? c.appt.id : ((ev.extendedProperties || {}).private || {}).ec_appointment_id || null,
          lead_id: c.appt ? c.appt.lead_id : null, appointment_status: c.appt ? c.appt.status : null, kind: c.appt ? kindOf(c.appt) : null };
        add(rec);
        if (c.apply) {
          targets.set(ev.id, { appt: c.appt, source: c.cls });
          report.backup.push({ kind: 'google_event', event: ev });
        }
      }
    } catch (e) {
      report.google_error = String(e.message || e).slice(0, 300);
    }
  }
  for (const [eid, t] of targets) {
    report.backup.push({ kind: 'appointment_travel_link', appointment_id: t.appt.id, google_travel_event_id: t.appt.google_travel_event_id, target_event_id: eid });
  }

  if (apply) {
    const done = {};
    const actor = ACTOR_PREFIX + runId;
    for (const [eid, t] of targets) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const a = (await client.query(
          `SELECT a.*, t.name AS type_name FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id
            WHERE a.id = $1 FOR UPDATE OF a`, [t.appt.id])).rows[0];
        // Re-verified under the row lock: still provably invalid right now?
        const why = a && invalidReason(a);
        const still = a && why !== 'ambiguous_migrated_meeting'
          && (why || (travelAllowed(a) && eid !== a.google_travel_event_id && eid !== currentTravelId(a)));
        if (!still) { await client.query('ROLLBACK'); bump(done, 'skipped_now_valid'); continue; }
        const ins = await client.query(
          `INSERT INTO calendar_outbox (appointment_id, action, slot, version, google_event_id, calendar_id, payload, idempotency_key, status)
           VALUES ($1, 'cancel_travel', $2, $3, $4, $5, NULL, $6, 'pending') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
          [a.id, 'audit:' + eid, a.version || 1, eid, outbox.CALENDAR_ID, `audit-travel-cancel:${eid}`]);
        if (ins.rows[0]) {
          await client.query(
            `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values) VALUES ($1, $2, 'updated', $3, $4)`,
            [a.id, actor, JSON.stringify({ travel_event_id: eid, google_travel_event_id: a.google_travel_event_id, class: t.source }),
              JSON.stringify({ travel_cancel_enqueued: eid, outbox_id: ins.rows[0].id })]);
          bump(done, `${t.source}:enqueued`);
        } else bump(done, `${t.source}:already_enqueued`);
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        bump(done, `error:${String(e.message).slice(0, 80)}`);
      } finally { client.release(); }
    }
    report.applied = done;
  }

  if (flag('json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[travel-audit] db host=${host} mode=${report.mode} run=${runId || '-'} google=${report.google_scanned ? 'scanned' : (report.google_error || 'skipped')}`);
    console.log('[travel-audit] counts', JSON.stringify(report.counts));
    console.log('[travel-audit] provably invalid (apply)', JSON.stringify(report.apply_candidates));
    if (report.applied) console.log('[travel-audit] applied', JSON.stringify(report.applied));
  }
  await pool.end();
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { classifyGoogleEvent, invalidReason };
