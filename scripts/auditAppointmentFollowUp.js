#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditAppointmentFollowUp — classify (and, only where provenance is PROVEN,
 * reconcile) historical leads whose follow-up fields duplicate an appointment.
 *
 * READ-ONLY BY DEFAULT.
 *
 *   node scripts/auditAppointmentFollowUp.js [--json] [--since=YYYY-MM-DD]
 *   node scripts/auditAppointmentFollowUp.js --apply --confirm-host=<db host> [--json]
 *   node scripts/auditAppointmentFollowUp.js --revert=<run_id> --confirm-host=<db host> [--json]
 *
 * ── Where the duplicates came from (traced in git history) ─────────────────────
 *  1. Base44 → Railway migration (scripts/migrateAppointmentsToRailway.js,
 *     removed in cd84358; see git history). For every Base44 lead WITHOUT an
 *     appointment_date it built an appointments row FROM the follow-up fields:
 *       idempotency_key = 'migration:appt:<base44 lead id>' (= leads.external_ref)
 *       start_at        = `${follow_up_date}T${HH:MM || '00:00'}:00-07:00`
 *                         (fixed -07:00 — winter dates land 1h off Pacific time;
 *                          a missing time became 00:00)
 *       type            = 'Consultation' for a Phone Call follow-up, else 'General Meeting'
 *       busy_range      = [start, end) UNBUFFERED for every row — so the current
 *                         kind rule (lib/booking/appointmentKind) reads every
 *                         migrated appointment as a 'Phone Call', even Meetings.
 *     The follow-up fields were migrated too → one Base44 fact became BOTH a
 *     follow-up and an appointment.
 *  2. Pre-separation booking (before commit 2516ff8, 2026-09-24 22:07:24Z):
 *     bookingService.createBooking / publicCapture wrote every new booking into
 *     leads.follow_up_date/time with follow_up_type hard-coded to 'Meeting'
 *     (even for Phone Call bookings).
 *  3. Pre-fix metaWebhook: set follow_up_type='Meeting' with no date (ORPHANED_TYPE).
 *
 * ── Classes ────────────────────────────────────────────────────────────────────
 *  ORPHANED_TYPE  type set, date NULL — impossible via any validated save.     → APPLY
 *  MIRROR         follow-up date/time/kind == the active appointment, no notes.
 *                   provenance migration | pre_separation_booking              → APPLY
 *                   provenance unproven (post-separation) → MIRROR_UNPROVEN     → report
 *  DIVERGENT      active appointment + dated Meeting/Phone Call follow-up that
 *                 differs in date, time or kind. Sub-classes:
 *                   DIV_MIGRATION_SOURCE — the appointment is THE migration row of
 *                     this lead and its start equals the migration formula applied
 *                     to this follow-up, with the matching Base44 type: the follow-up
 *                     is the source the appointment was made from               → APPLY
 *                   DIV_PRE_SEPARATION_MIRROR — Phone Call appointment booked
 *                     before 2516ff8 + 'Meeting' follow-up at the same Pacific
 *                     date/time (the hard-coded mirror)                          → APPLY
 *                   DIV_OTHER (different_date | different_time | kind_only)    → report
 *  FOLLOWUP_ONLY  dated Meeting/Phone Call follow-up, no active appointment:
 *                 a legitimate follow-up under the current model               → report
 *  MULTI_ACTIVE   >1 active appointment                                        → report
 *  OWNER_OVERLAP  overlapping active appointments of one owner, no override   → report
 *  MIGRATED_KIND  (appointment-level) migration row typed 'General Meeting' whose
 *                 unbuffered range makes it read as a Phone Call:
 *                   ended in the past, never on Google Calendar → busy_range set
 *                   to the Meeting range [start-1h, end+1h) so it reads as the
 *                   Meeting it was (no availability effect: it is in the past) → APPLY
 *                   future / synced to Google → MIGRATED_KIND_UNSAFE            → report
 *
 * Never touched by --apply: follow-ups with notes or status 'completed',
 * meeting_stage, appointment status/times, activities, calendar events,
 * reminders already sent. Every apply is one transaction per lead/appointment,
 * re-verified under FOR UPDATE, re-projects reminder_leads, and writes an
 * immutable appointment_events row (actor 'audit:appointment-followup:<run_id>')
 * holding the previous values. --revert=<run_id> restores exactly those values
 * (only where the row still holds what the run wrote). --apply and --revert
 * require --confirm-host=<DATABASE_URL host> (CLAUDE.md: confirm before any
 * destructive script). The JSON report carries a before-image backup and
 * equivalent revert SQL.
 *
 * ── DIV_OTHER: the live-misentry pattern (the Barry Jacobson case) ────────────
 * A DIV_OTHER "different_date" record — an active appointment at one date plus
 * a dated Meeting follow-up at a DIFFERENT date — is report-only here: it
 * could be a genuinely independent future follow-up (e.g. "call to confirm"
 * on top of a real appointment) or it could be the SAME real appointment,
 * recorded via Follow-Up instead of the Appointment editor by mistake, with
 * the old appointment simply never closed out. Data alone cannot tell these
 * apart — this tool never guesses. Once a human has looked at the record
 * above and confirmed it's the latter:
 *
 *   node scripts/auditAppointmentFollowUp.js --promote=<lead_id> --confirm-host=<host>
 *
 * invokes lib/booking/bookingService.js#promoteFollowUpToAppointment for
 * that ONE lead: the old active appointment is superseded (marked
 * 'completed', kept as history, never deleted), a real Appointment is
 * created from the Follow-Up's date/time through the exact same booking
 * service every other appointment uses (conflict checks, travel buffer,
 * Google Calendar outbox, reminders all apply identically), and the
 * Follow-Up fields are cleared. A Phone Call follow-up can never be
 * promoted (a Phone Call is never an appointment).
 *
 *   node scripts/auditAppointmentFollowUp.js --lead-name="Barry Jacobson" --json
 *
 * is a targeted, always-read-only lookup by name (ILIKE, partial match,
 * case-insensitive) for investigating one specific person before deciding
 * whether to --promote them — reuses the exact same classify()/assess() the
 * full sweep uses, so its verdict is authoritative, not a guess.
 */
'use strict';

const crypto = require('crypto');
const { pool } = require('../db/client');
const { serializeAppointment } = require('../lib/booking/appointmentView');

const SEPARATION_CUTOVER = new Date('2026-09-24T22:07:24Z'); // commit 2516ff8
const ACTOR_PREFIX = 'audit:appointment-followup:';

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

function normTime(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// Exact copy of the migration's parser (scripts/migrateAppointmentsToRailway.js).
function migrationHHMM(timeStr) {
  if (!timeStr) return '00:00';
  const m = String(timeStr).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return '00:00';
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const ampm = m[3] ? m[3].toUpperCase() : null;
  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}
function migrationStartMs(dateStr, timeStr) {
  if (!dateStr) return NaN;
  return Date.parse(`${String(dateStr).slice(0, 10)}T${migrationHHMM(timeStr)}:00-07:00`);
}

/** Backward-compatible base class (unit-tested; unchanged semantics). */
function classify(lead, appts) {
  if (lead.follow_up_type && !lead.follow_up_date) return { cls: 'ORPHANED_TYPE' };
  const fuDated = !!lead.follow_up_date;
  const fuSched = fuDated && (lead.follow_up_type === 'Meeting' || lead.follow_up_type === 'Phone Call');
  if (appts.length > 1) return { cls: 'MULTI_ACTIVE' };
  const appt = appts[0] ? serializeAppointment(appts[0]) : null;
  if (!appt) return fuSched ? { cls: 'FOLLOWUP_ONLY' } : null;
  if (!fuSched) return null;
  const same = String(lead.follow_up_date).slice(0, 10) === appt.date
    && normTime(lead.follow_up_time) === appt.time
    && lead.follow_up_type === appt.kind;
  if (same && !lead.follow_up_notes) return { cls: 'MIRROR', appt };
  return { cls: 'DIVERGENT', appt };
}

/**
 * Provenance of an active appointment relative to the lead's follow-up.
 * rawAppt needs: idempotency_key, type_name, start_at, created_event_at.
 */
function provenance(lead, rawAppt) {
  const isMigrationRow = !!(lead.external_ref && rawAppt.idempotency_key === `migration:appt:${lead.external_ref}`);
  const expectType = lead.follow_up_type === 'Phone Call' ? 'Consultation' : 'General Meeting';
  const formulaMatch = isMigrationRow
    && migrationStartMs(lead.follow_up_date, lead.follow_up_time) === new Date(rawAppt.start_at).getTime();
  const createdAt = rawAppt.created_event_at ? new Date(rawAppt.created_event_at) : null;
  return {
    migration_row: isMigrationRow,
    migration_formula_match: formulaMatch,
    migration_type_match: isMigrationRow && rawAppt.type_name === expectType,
    pre_separation: !isMigrationRow && !!createdAt && createdAt < SEPARATION_CUTOVER,
    created_event_at: createdAt ? createdAt.toISOString() : null,
    idempotency_key: rawAppt.idempotency_key || null,
    type_name: rawAppt.type_name || null,
  };
}

/** Full assessment: sub-class + whether --apply may touch it + why. */
function assess(lead, rawAppts) {
  const base = classify(lead, rawAppts);
  if (!base) return null;
  const out = { cls: base.cls, sub: base.cls, apply: false, reason: null, appt: base.appt || null, prov: null };
  const guard = () => {
    if (lead.follow_up_notes) return 'follow-up has notes';
    if (lead.follow_up_status === 'completed') return 'follow-up marked completed by a user';
    return null;
  };
  if (base.cls === 'ORPHANED_TYPE') { out.apply = true; out.reason = 'type without date — never a validated save'; return out; }
  if (base.cls === 'FOLLOWUP_ONLY') { out.reason = 'legitimate follow-up (no appointment) under the current model'; return out; }
  if (base.cls === 'MULTI_ACTIVE') { out.reason = 'more than one active appointment — needs a human'; return out; }
  const raw = rawAppts[0];
  const prov = provenance(lead, raw);
  out.prov = prov;
  const blocked = guard();
  if (base.cls === 'MIRROR') {
    if (prov.migration_row && prov.migration_formula_match) {
      out.sub = 'MIRROR'; out.apply = !blocked; out.reason = blocked || 'appointment was built by the Base44 migration from this follow-up';
    } else if (prov.pre_separation) {
      out.sub = 'MIRROR'; out.apply = !blocked; out.reason = blocked || 'booked before the separation fix, which copied every booking into the follow-up';
    } else {
      out.sub = 'MIRROR_UNPROVEN'; out.reason = 'identical, but created after the separation fix — could be user-entered';
    }
    return out;
  }
  // DIVERGENT
  const a = base.appt;
  const fuDate = String(lead.follow_up_date).slice(0, 10);
  const sameDate = fuDate === a.date;
  const sameTime = normTime(lead.follow_up_time) === a.time;
  if (prov.migration_row && prov.migration_formula_match && prov.migration_type_match) {
    out.sub = 'DIV_MIGRATION_SOURCE'; out.apply = !blocked;
    out.reason = blocked || `appointment is this lead's migration row, built from this follow-up (type ${prov.type_name}; kind reads '${a.kind}' only because the migration stored no buffer${sameTime ? '' : '; fixed -07:00 offset'})`;
    return out;
  }
  if (prov.pre_separation && lead.follow_up_type === 'Meeting' && a.kind === 'Phone Call' && sameDate && sameTime) {
    out.sub = 'DIV_PRE_SEPARATION_MIRROR'; out.apply = !blocked;
    out.reason = blocked || "Phone Call booked before the separation fix, which hard-coded follow_up_type='Meeting' at the booking time";
    return out;
  }
  out.sub = 'DIV_OTHER';
  out.reason = !sameDate ? 'different_date' : !sameTime ? 'different_time' : 'kind_only';
  return out;
}

/** Migration appointments typed 'General Meeting' that read as Phone Call. */
function assessMigratedKind(rawAppt, now = Date.now()) {
  if (!/^migration:appt:/.test(rawAppt.idempotency_key || '')) return null;
  if (rawAppt.type_name !== 'General Meeting') return null;
  if (new Date(rawAppt.busy_start).getTime() !== new Date(rawAppt.start_at).getTime()) return null; // already buffered
  const past = new Date(rawAppt.end_at).getTime() < now;
  const onGoogle = !!(rawAppt.google_event_id || rawAppt.google_travel_event_id);
  if (past && !onGoogle) return { sub: 'MIGRATED_KIND', apply: true, reason: "past migration Meeting stored without buffer (reads as 'Phone Call')" };
  return { sub: 'MIGRATED_KIND_UNSAFE', apply: false, reason: past ? 'already on Google Calendar' : 'future appointment — changing its range could alter availability' };
}

// ── DB helpers ──────────────────────────────────────────────────────────────
const APPT_SQL = `
  SELECT a.*, t.name AS type_name, lower(a.busy_range) AS busy_start, upper(a.busy_range) AS busy_end,
         (SELECT min(e.created_at) FROM appointment_events e WHERE e.appointment_id = a.id AND e.action = 'created') AS created_event_at,
         (SELECT e.actor FROM appointment_events e WHERE e.appointment_id = a.id AND e.action = 'created' ORDER BY e.created_at LIMIT 1) AS created_event_actor
    FROM appointments a LEFT JOIN appointment_types t ON t.id = a.appointment_type_id`;
const LEAD_COLS = `l.id, l.external_ref, l.first_name, l.last_name, l.status, l.created_at, l.follow_up_date, l.follow_up_time,
  l.follow_up_type, to_jsonb(l) ->> 'follow_up_notes' AS follow_up_notes, to_jsonb(l) ->> 'follow_up_status' AS follow_up_status`;

async function reproject(client, leadId) {
  const { syncLeadToReminders } = require('../lib/reminderProjection');
  const full = (await client.query(
    `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`, [leadId])).rows[0];
  if (full) await syncLeadToReminders(client, full);
}

async function writeEvidence(client, apptId, actor, previous, next) {
  await client.query(
    `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values)
     VALUES ($1, $2, 'updated', $3, $4)`, [apptId, actor, JSON.stringify(previous), JSON.stringify(next)]);
}

async function applyFollowUpClear(r, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const l = (await client.query(`SELECT ${LEAD_COLS} FROM leads l WHERE l.id = $1 FOR UPDATE`, [r.lead_id])).rows[0];
    const a = (await client.query(`${APPT_SQL} WHERE a.lead_id = $1 AND a.status IN ('scheduled','confirmed') FOR UPDATE OF a`, [r.lead_id])).rows;
    const now = l && assess(l, a);
    if (!now || !now.apply || now.sub !== r.sub) { await client.query('ROLLBACK'); return 'skipped_changed'; }
    const prev = { date: l.follow_up_date, time: l.follow_up_time, type: l.follow_up_type, status: l.follow_up_status, notes: l.follow_up_notes };
    if (now.sub === 'ORPHANED_TYPE') {
      await client.query(`UPDATE leads SET follow_up_type = NULL, follow_up_status = NULL, updated_at = NOW() WHERE id = $1`, [r.lead_id]);
      await client.query(
        `INSERT INTO activities (lead_id, type, content, author, source) VALUES ($1, 'note', $2, $3, 'manual')`,
        [r.lead_id, `Automated data cleanup: cleared orphaned follow_up_type='${prev.type}' (no follow-up date was ever set; residue from the pre-fix Meta webhook). meeting_stage untouched.`, actor]);
    } else {
      await client.query(
        `UPDATE leads SET follow_up_date = NULL, follow_up_time = NULL, follow_up_type = NULL, follow_up_status = NULL, updated_at = NOW()
          WHERE id = $1`, [r.lead_id]);
      await writeEvidence(client, a[0].id, actor,
        { lead_follow_up: prev, lead_id: r.lead_id },
        { lead_follow_up: null, class: now.sub, reason: now.reason });
    }
    await reproject(client, r.lead_id);
    await client.query('COMMIT');
    return 'cleared';
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    return 'error: ' + e.message;
  } finally { client.release(); }
}

async function applyKindFix(r, actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(`${APPT_SQL} WHERE a.id = $1 FOR UPDATE OF a`, [r.appointment_id])).rows[0];
    const now = a && assessMigratedKind(a);
    if (!now || !now.apply) { await client.query('ROLLBACK'); return 'skipped_changed'; }
    await client.query(
      `UPDATE appointments
          SET busy_range = tstzrange(start_at - interval '1 hour', end_at + interval '1 hour', '[)'), updated_at = NOW()
        WHERE id = $1`, [a.id]);
    await writeEvidence(client, a.id, actor,
      { busy_range: [new Date(a.busy_start).toISOString(), new Date(a.busy_end).toISOString()] },
      { busy_range: 'meeting buffer (start-1h, end+1h)', class: 'MIGRATED_KIND', reason: now.reason });
    if (a.lead_id) await reproject(client, a.lead_id);
    await client.query('COMMIT');
    return 'fixed';
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    return 'error: ' + e.message;
  } finally { client.release(); }
}

async function revertRun(runId) {
  const actor = ACTOR_PREFIX + runId;
  const evs = (await pool.query(
    `SELECT id, appointment_id, previous_values, new_values FROM appointment_events WHERE actor = $1 ORDER BY created_at DESC`, [actor])).rows;
  const notes = (await pool.query(`SELECT id, lead_id, content FROM activities WHERE author = $1`, [actor])).rows;
  const results = [];
  for (const ev of evs) {
    const prev = ev.previous_values || {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (prev.lead_follow_up && prev.lead_id) {
        const l = (await client.query(`SELECT follow_up_date, follow_up_type FROM leads WHERE id = $1 FOR UPDATE`, [prev.lead_id])).rows[0];
        if (!l || l.follow_up_date || l.follow_up_type) { await client.query('ROLLBACK'); results.push({ event: ev.id, result: 'skipped_changed' }); continue; }
        const p = prev.lead_follow_up;
        await client.query(
          `UPDATE leads SET follow_up_date = $2, follow_up_time = $3, follow_up_type = $4, follow_up_status = $5, updated_at = NOW() WHERE id = $1`,
          [prev.lead_id, p.date, p.time, p.type, p.status]);
        await reproject(client, prev.lead_id);
      } else if (prev.busy_range) {
        const r = await client.query(
          `UPDATE appointments SET busy_range = tstzrange($2::timestamptz, $3::timestamptz, '[)'), updated_at = NOW()
            WHERE id = $1 AND lower(busy_range) = start_at - interval '1 hour' RETURNING lead_id`,
          [ev.appointment_id, prev.busy_range[0], prev.busy_range[1]]);
        if (!r.rows[0]) { await client.query('ROLLBACK'); results.push({ event: ev.id, result: 'skipped_changed' }); continue; }
        if (r.rows[0].lead_id) await reproject(client, r.rows[0].lead_id);
      } else { await client.query('ROLLBACK'); continue; }
      await writeEvidence(client, ev.appointment_id, actor + ':revert', ev.new_values, { reverted_event: ev.id });
      await client.query('COMMIT');
      results.push({ event: ev.id, result: 'reverted' });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      results.push({ event: ev.id, result: 'error: ' + e.message });
    } finally { client.release(); }
  }
  for (const n of notes) {
    const m = /follow_up_type='([^']+)'/.exec(n.content || '');
    if (!m) continue;
    const r = await pool.query(`UPDATE leads SET follow_up_type = $2 WHERE id = $1 AND follow_up_type IS NULL AND follow_up_date IS NULL RETURNING id`, [n.lead_id, m[1]]);
    results.push({ activity: n.id, result: r.rows[0] ? 'reverted' : 'skipped_changed' });
  }
  return results;
}

function revertSqlFor(rec) {
  const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  if (rec.kind === 'lead_follow_up') {
    const p = rec.before;
    return `UPDATE leads SET follow_up_date=${q(p.date)}, follow_up_time=${q(p.time)}, follow_up_type=${q(p.type)}, follow_up_status=${q(p.status)} WHERE id=${q(rec.lead_id)} AND follow_up_date IS NULL AND follow_up_type IS NULL;`;
  }
  return `UPDATE appointments SET busy_range=tstzrange(${q(rec.before.busy_range[0])}::timestamptz, ${q(rec.before.busy_range[1])}::timestamptz, '[)') WHERE id=${q(rec.appointment_id)};`;
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return '?'; } })();
  const apply = !!flag('apply');
  const revert = flagVal('revert');
  const promote = flagVal('promote');
  const since = flagVal('since');
  if ((apply || revert || promote) && flagVal('confirm-host') !== host) {
    console.error(`--apply/--revert/--promote require --confirm-host=${host} (the DATABASE_URL host). Nothing changed.`);
    process.exit(2);
  }
  if (revert) {
    const results = await revertRun(revert);
    console.log(JSON.stringify({ mode: 'revert', run_id: revert, results }, null, 2));
    await pool.end();
    return;
  }
  if (promote) {
    // --promote=<lead_id>: a HUMAN has looked at this specific lead's
    // DIV_OTHER (different_date) record above and confirmed the Follow-Up
    // genuinely represents the real, current appointment — e.g. it was
    // entered via Follow-Up / Next Update -> Meeting instead of through the
    // Appointment editor (the Barry Jacobson pattern). This is NEVER
    // inferred/auto-applied by the classifier above — --apply only ever
    // touches MIRROR/ORPHANED_TYPE/DIV_MIGRATION_SOURCE/DIV_PRE_SEPARATION_MIRROR,
    // all deterministically proven by provenance. DIV_OTHER always requires
    // this explicit, per-lead, human-confirmed step.
    const { promoteFollowUpToAppointment } = require('../lib/booking/bookingService');
    const actor = `audit:appointment-followup:promote:${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    try {
      const result = await promoteFollowUpToAppointment(promote, actor, {});
      console.log(JSON.stringify({
        mode: 'promote', lead_id: promote, ok: true,
        appointment: { id: result.appointment.id, start_at: result.appointment.start_at, end_at: result.appointment.end_at, status: result.appointment.status },
        superseded_appointment: result.superseded ? { id: result.superseded.id, start_at: result.superseded.start_at, status: result.superseded.status } : null,
      }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ mode: 'promote', lead_id: promote, ok: false, error: (e && e.code) || 'error', message: (e && e.message) || String(e) }, null, 2));
      await pool.end();
      process.exitCode = 1;
      return;
    }
    await pool.end();
    return;
  }
  const runId = apply ? `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}` : null;
  const actor = runId ? ACTOR_PREFIX + runId : null;
  const leadName = flagVal('lead-name');
  if (apply && leadName) {
    console.error('--lead-name is a read-only targeted lookup; it cannot be combined with --apply. Use --promote for a targeted per-lead action.');
    process.exit(2);
  }

  // --lead-name: every matching lead's current state, regardless of whether
  // it has follow-up/appointment activity — a targeted investigation, not
  // the production-wide sweep, so it skips that filter.
  const leads = leadName
    ? (await pool.query(
        `SELECT ${LEAD_COLS} FROM leads l WHERE (l.first_name || ' ' || l.last_name) ILIKE $1 ORDER BY l.created_at DESC`,
        [`%${leadName}%`]
      )).rows
    : (await pool.query(
        `SELECT ${LEAD_COLS} FROM leads l
          WHERE ($1::date IS NULL OR l.created_at >= $1::date)
            AND (l.follow_up_date IS NOT NULL OR l.follow_up_type IS NOT NULL
                 OR EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.status IN ('scheduled','confirmed')))
          ORDER BY l.created_at DESC`, [since])).rows;
  if (leadName && !leads.length) {
    console.log(JSON.stringify({ lead_name_query: leadName, found: false, message: 'No lead matched this name.' }, null, 2));
    await pool.end();
    return;
  }
  const appts = (await pool.query(
    `${APPT_SQL} WHERE a.status IN ('scheduled','confirmed') AND a.lead_id = ANY($1::uuid[]) ORDER BY a.created_at`,
    [leads.map(l => l.id)])).rows;
  const byLead = new Map();
  for (const a of appts) { const k = String(a.lead_id); if (!byLead.has(k)) byLead.set(k, []); byLead.get(k).push(a); }

  const report = {
    database_host: host, generated_at: new Date().toISOString(), since, mode: apply ? 'apply' : 'report-only',
    run_id: runId, counts: {}, subclass_counts: {}, apply_candidates: {}, records: [], backup: [], revert_sql: [],
  };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const lead of leads) {
    const raw = byLead.get(String(lead.id)) || [];
    const as = assess(lead, raw);
    if (!as) {
      // --lead-name mode: report this lead's raw state even when assess()
      // finds nothing actionable — the caller is investigating a specific
      // person, not sweeping for a known bug class.
      if (leadName) {
        report.records.push({
          class: 'NONE', sub: 'NONE', apply: false, reason: 'no active appointment and no dated Meeting/Phone Call follow-up',
          lead_id: lead.id, external_ref: lead.external_ref, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
          lead_status: lead.status, lead_created_at: lead.created_at,
          follow_up: { date: lead.follow_up_date, time: lead.follow_up_time, type: lead.follow_up_type,
            status: lead.follow_up_status || null, notes: lead.follow_up_notes || null },
          appointment: null, provenance: null,
        });
      }
      continue;
    }
    bump(report.counts, as.cls);
    bump(report.subclass_counts, as.sub);
    if (as.apply) bump(report.apply_candidates, as.sub);
    report.records.push({
      class: as.cls, sub: as.sub, apply: as.apply, reason: as.reason,
      lead_id: lead.id, external_ref: lead.external_ref, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      lead_status: lead.status, lead_created_at: lead.created_at,
      follow_up: { date: lead.follow_up_date, time: lead.follow_up_time, type: lead.follow_up_type,
        status: lead.follow_up_status || null, notes: lead.follow_up_notes || null },
      appointment: as.appt ? { id: as.appt.id, date: as.appt.date, time: as.appt.time, kind: as.appt.kind,
        status: as.appt.status, calendar: as.appt.calendar_sync_status } : null,
      provenance: as.prov,
    });
  }
  // Appointment-level: migrated Meetings mislabelled as Phone Call (all statuses).
  const migrated = (await pool.query(`${APPT_SQL} WHERE a.idempotency_key LIKE 'migration:appt:%'`)).rows;
  for (const a of migrated) {
    const k = assessMigratedKind(a);
    if (!k) continue;
    bump(report.counts, k.sub);
    bump(report.subclass_counts, k.sub);
    if (k.apply) bump(report.apply_candidates, k.sub);
    report.records.push({ class: k.sub, sub: k.sub, apply: k.apply, reason: k.reason, appointment_id: a.id, lead_id: a.lead_id,
      appointment: { start_at: a.start_at, end_at: a.end_at, status: a.status, type: a.type_name, calendar: a.calendar_sync_status } });
  }
  // Owner overlaps among ALL active appointments.
  const overlaps = (await pool.query(
    `SELECT a.id AS a_id, b.id AS b_id, a.owner_id, a.lead_id AS a_lead, b.lead_id AS b_lead,
            a.start_at AS a_start, b.start_at AS b_start, to_jsonb(b) ->> 'override_authorized' AS b_override
       FROM appointments a JOIN appointments b
         ON a.owner_id = b.owner_id AND a.id < b.id AND a.busy_range && b.busy_range
      WHERE a.status IN ('scheduled','confirmed') AND b.status IN ('scheduled','confirmed')
        AND b.start_at >= NOW() - interval '1 day'`)).rows.filter(r => r.b_override !== 'true');
  report.counts.OWNER_OVERLAP = overlaps.length;
  for (const o of overlaps) report.records.push({ class: 'OWNER_OVERLAP', sub: 'OWNER_OVERLAP', apply: false, ...o });

  // Before-image backup + equivalent revert SQL for everything --apply would touch.
  for (const r of report.records.filter(x => x.apply)) {
    if (r.sub === 'MIGRATED_KIND') {
      const a = migrated.find(m => m.id === r.appointment_id);
      const rec = { kind: 'appointment_busy_range', appointment_id: r.appointment_id, lead_id: r.lead_id,
        before: { busy_range: [new Date(a.busy_start).toISOString(), new Date(a.busy_end).toISOString()] } };
      report.backup.push(rec); report.revert_sql.push(revertSqlFor(rec));
    } else {
      const rec = { kind: 'lead_follow_up', lead_id: r.lead_id, class: r.sub, before: r.follow_up };
      report.backup.push(rec); report.revert_sql.push(revertSqlFor(rec));
    }
  }

  if (apply) {
    const done = {};
    for (const r of report.records.filter(x => x.apply)) {
      r.apply_result = r.sub === 'MIGRATED_KIND' ? await applyKindFix(r, actor) : await applyFollowUpClear(r, actor);
      bump(done, `${r.sub}:${r.apply_result.startsWith('error') ? 'error' : r.apply_result}`);
    }
    report.applied = done;
  }

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[audit] db host=${host} mode=${report.mode} run=${runId || '-'} since=${since || 'all'}`);
    console.log('[audit] counts', JSON.stringify(report.counts));
    console.log('[audit] sub-classes', JSON.stringify(report.subclass_counts));
    console.log('[audit] provably safe to apply', JSON.stringify(report.apply_candidates));
    if (report.applied) console.log('[audit] applied', JSON.stringify(report.applied));
    if (!apply) console.log('[audit] report only — nothing changed.');
  }
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { classify, assess, provenance, assessMigratedKind, migrationStartMs, SEPARATION_CUTOVER };
