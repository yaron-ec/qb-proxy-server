#!/usr/bin/env node
/* eslint-disable no-undef */
/**
 * auditAppointmentFollowUp — report (and optionally reconcile) leads whose
 * follow-up fields were used as a mirror of the appointment.
 *
 * Before the appointment/follow-up separation, New Lead (routes/publicCapture
 * → bookingService.createBooking) and the Meta webhook copied the booked
 * appointment into leads.follow_up_date/time with follow_up_type='Meeting',
 * while the lead API never exposed the appointments row. Lead Detail then
 * showed "Appointment: Not set" next to "Follow-up: Meeting <appointment time>".
 *
 * READ-ONLY BY DEFAULT. Classes (per lead):
 *   ORPHANED_TYPE     follow_up_type is set but follow_up_date is NULL. Every
 *                     validated write path (lib/followUp.js#normalizeFollowUp,
 *                     required by PUT /:id/follow-up and bookingService's
 *                     createBooking) REQUIRES a date whenever a type is set —
 *                     "follow_up_date is required for a follow-up" — so this
 *                     combination can never be produced by any app-driven,
 *                     validated write. It is residue from a write path that
 *                     bypassed validation: routes/metaWebhook.js's with-
 *                     appointment branch (fixed 2026-09-25, commit
 *                     "Fix invalid_id on Lead status save...") ran a raw
 *                     `UPDATE leads SET follow_up_type = 'Meeting',
 *                     meeting_stage = 'First Meeting'` on every booked lead —
 *                     never touching follow_up_date/time/notes/status — so a
 *                     lead created through that path before the fix carries
 *                     exactly this signature. Deterministic, appointment-
 *                     independent → reconcilable (clears follow_up_type only;
 *                     meeting_stage is left alone — see MIRROR below).
 *   MIRROR            active appointment + follow-up Meeting/Phone Call whose
 *                     Pacific date+time AND kind equal the appointment's, no
 *                     follow-up notes. Deterministic: the follow-up carries no
 *                     information the appointment does not. → reconcilable.
 *   DIVERGENT         active appointment + dated Meeting/Phone Call follow-up
 *                     at a different date/time/kind. Could be a real next
 *                     update or a stale copy → REPORT ONLY.
 *   FOLLOWUP_ONLY     dated Meeting/Phone Call follow-up, no active
 *                     appointment (legacy meeting never booked) → REPORT ONLY.
 *   MULTI_ACTIVE      more than one active appointment for one lead → REPORT ONLY.
 *   OWNER_OVERLAP     two active appointments of one owner whose busy ranges
 *                     overlap without an authorized override (booked while the
 *                     server-side conflict check was not wired) → REPORT ONLY.
 *
 * meeting_stage is NEVER cleared by --apply, in either class: it documents a
 * true fact (this lead's Nth meeting happened/was booked), set independently
 * by bookingService at appointment-creation time — it is not itself a
 * Follow-Up field and clearing it would delete real information, not residue.
 *
 * --apply clears follow_up_* on MIRROR and ORPHANED_TYPE leads only, one
 * transaction per lead, re-checking the classification under FOR UPDATE, and
 * writes an immutable evidence row (appointment_events for MIRROR, since it
 * has an appointment to attach to; an activities note for ORPHANED_TYPE,
 * since it may have none). It requires --confirm-host=<database host> to
 * match DATABASE_URL (CLAUDE.md: confirm DATABASE_URL before any destructive
 * script).
 *
 *   node scripts/auditAppointmentFollowUp.js [--since=YYYY-MM-DD] [--json]
 *   node scripts/auditAppointmentFollowUp.js --apply --confirm-host=<host>
 */
'use strict';

const { pool } = require('../db/client');
const { serializeAppointment } = require('../lib/booking/appointmentView');

const args = process.argv.slice(2);
const flag = (name) => args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
const flagVal = (name) => { const f = flag(name); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };

function normTime(t) {
  if (!t) return null;
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function classify(lead, appts) {
  // Checked before anything appointment-related: a type with no date can
  // never come from a validated write (normalizeFollowUp requires a date
  // whenever a type is set), regardless of whether an appointment exists.
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

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return '?'; } })();
  const apply = !!flag('apply');
  const since = flagVal('since');
  if (apply && flagVal('confirm-host') !== host) {
    console.error(`--apply requires --confirm-host=${host} (the DATABASE_URL host). Nothing changed.`);
    process.exit(2);
  }

  const leads = (await pool.query(
    `SELECT l.id, l.first_name, l.last_name, l.status, l.created_at, l.follow_up_date, l.follow_up_time,
            l.follow_up_type, to_jsonb(l) ->> 'follow_up_notes' AS follow_up_notes
       FROM leads l
      WHERE ($1::date IS NULL OR l.created_at >= $1::date)
        AND (l.follow_up_date IS NOT NULL
             OR l.follow_up_type IS NOT NULL
             OR EXISTS (SELECT 1 FROM appointments a WHERE a.lead_id = l.id AND a.status IN ('scheduled','confirmed')))
      ORDER BY l.created_at DESC`, [since]
  )).rows;
  const appts = (await pool.query(
    `SELECT * FROM appointments WHERE status IN ('scheduled','confirmed') AND lead_id = ANY($1::uuid[])
      ORDER BY created_at`, [leads.map(l => l.id)]
  )).rows;
  const byLead = new Map();
  for (const a of appts) { const k = String(a.lead_id); if (!byLead.has(k)) byLead.set(k, []); byLead.get(k).push(a); }
  const created = (await pool.query(
    `SELECT DISTINCT ON (appointment_id) appointment_id, actor, created_at FROM appointment_events
      WHERE action = 'created' AND appointment_id = ANY($1::uuid[]) ORDER BY appointment_id, created_at`,
    [appts.map(a => a.id)]
  )).rows;
  const createdBy = new Map(created.map(r => [String(r.appointment_id), r]));

  const report = { database_host: host, generated_at: new Date().toISOString(), since, mode: apply ? 'apply' : 'report-only', counts: {}, records: [] };
  for (const lead of leads) {
    const c = classify(lead, byLead.get(String(lead.id)) || []);
    if (!c) continue;
    report.counts[c.cls] = (report.counts[c.cls] || 0) + 1;
    const ev = c.appt ? createdBy.get(String(c.appt.id)) : null;
    report.records.push({
      class: c.cls, lead_id: lead.id, name: `${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      lead_status: lead.status, lead_created_at: lead.created_at,
      follow_up: { date: lead.follow_up_date, time: lead.follow_up_time, type: lead.follow_up_type, notes: lead.follow_up_notes || null },
      appointment: c.appt ? { id: c.appt.id, date: c.appt.date, time: c.appt.time, kind: c.appt.kind, status: c.appt.status,
        calendar: c.appt.calendar_sync_status, created_by: ev ? ev.actor : null } : null,
    });
  }

  // Owner overlaps among ALL active appointments (not only the audited leads).
  const overlaps = (await pool.query(
    `SELECT a.id AS a_id, b.id AS b_id, a.owner_id, a.lead_id AS a_lead, b.lead_id AS b_lead,
            a.start_at AS a_start, b.start_at AS b_start,
            to_jsonb(b) ->> 'override_authorized' AS b_override
       FROM appointments a JOIN appointments b
         ON a.owner_id = b.owner_id AND a.id < b.id AND a.busy_range && b.busy_range
      WHERE a.status IN ('scheduled','confirmed') AND b.status IN ('scheduled','confirmed')
        AND b.start_at >= NOW() - interval '1 day'`
  )).rows.filter(r => r.b_override !== 'true');
  report.counts.OWNER_OVERLAP = overlaps.length;
  for (const o of overlaps) report.records.push({ class: 'OWNER_OVERLAP', ...o });

  if (apply) {
    let cleared = 0;
    for (const r of report.records.filter(x => x.class === 'MIRROR')) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const l = (await client.query(
          `SELECT id, first_name, last_name, status, created_at, follow_up_date, follow_up_time, follow_up_type,
                  to_jsonb(leads) ->> 'follow_up_notes' AS follow_up_notes FROM leads WHERE id = $1 FOR UPDATE`, [r.lead_id])).rows[0];
        const a = (await client.query(
          `SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed') FOR UPDATE`, [r.lead_id])).rows;
        const c = l && classify(l, a);
        if (!c || c.cls !== 'MIRROR') { await client.query('ROLLBACK'); r.apply = 'skipped_changed'; continue; }
        await client.query(
          `UPDATE leads SET follow_up_date = NULL, follow_up_time = NULL, follow_up_type = NULL, updated_at = NOW()
            WHERE id = $1`, [r.lead_id]);
        await client.query(
          `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values)
           VALUES ($1, 'audit:appointment-followup-mirror', 'updated', $2, $3)`,
          [c.appt.id,
           JSON.stringify({ lead_follow_up: { date: l.follow_up_date, time: l.follow_up_time, type: l.follow_up_type } }),
           JSON.stringify({ lead_follow_up: null, reason: 'follow-up was an exact copy of this appointment (pre-separation mirror)' })]
        );
        const { syncLeadToReminders } = require('../lib/reminderProjection');
        const full = (await client.query(
          `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
             FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`, [r.lead_id])).rows[0];
        await syncLeadToReminders(client, full);
        await client.query('COMMIT');
        r.apply = 'cleared';
        cleared++;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        r.apply = 'error: ' + e.message;
      } finally {
        client.release();
      }
    }
    // ORPHANED_TYPE: no appointment necessarily exists, so the evidence trail
    // is a lead-scoped activities note (visible in Lead Detail's own
    // timeline) rather than an appointment_events row. meeting_stage is
    // deliberately left untouched (see header comment).
    for (const r of report.records.filter(x => x.class === 'ORPHANED_TYPE')) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const l = (await client.query(
          `SELECT id, follow_up_type, follow_up_date FROM leads WHERE id = $1 FOR UPDATE`, [r.lead_id])).rows[0];
        if (!l || !l.follow_up_type || l.follow_up_date) { await client.query('ROLLBACK'); r.apply = 'skipped_changed'; continue; }
        const priorType = l.follow_up_type;
        await client.query(
          `UPDATE leads SET follow_up_type = NULL, follow_up_status = NULL, updated_at = NOW() WHERE id = $1`, [r.lead_id]);
        await client.query(
          `INSERT INTO activities (lead_id, type, content, author, source)
           VALUES ($1, 'note', $2, 'audit:appointment-followup-mirror', 'manual')`,
          [r.lead_id, `Automated data cleanup: cleared orphaned follow_up_type='${priorType}' (no follow_up_date was ever set — this value could not have come from a validated follow-up save; residue from the pre-fix metaWebhook appointment/follow-up conflation). meeting_stage was left untouched.`]
        );
        const { syncLeadToReminders } = require('../lib/reminderProjection');
        const full = (await client.query(
          `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
             FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`, [r.lead_id])).rows[0];
        await syncLeadToReminders(client, full);
        await client.query('COMMIT');
        r.apply = 'cleared';
        cleared++;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
        r.apply = 'error: ' + e.message;
      } finally {
        client.release();
      }
    }
    report.applied = cleared;
  }

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[audit] db host=${host} mode=${report.mode} since=${since || 'all'}`);
    console.log('[audit] counts', JSON.stringify(report.counts));
    for (const r of report.records) {
      if (r.class === 'OWNER_OVERLAP') {
        console.log(`  OWNER_OVERLAP owner=${r.owner_id} appt ${r.a_id} (${new Date(r.a_start).toISOString()}) ⟷ ${r.b_id} (${new Date(r.b_start).toISOString()})`);
      } else {
        console.log(`  ${r.class.padEnd(13)} lead=${r.lead_id} "${r.name}" follow_up=${r.follow_up.type || '-'} ${r.follow_up.date || '-'} ${r.follow_up.time || ''}`
          + (r.appointment ? ` | appointment=${r.appointment.kind} ${r.appointment.date} ${r.appointment.time} (${r.appointment.calendar}, by ${r.appointment.created_by || '?'})` : '')
          + (r.apply ? ` → ${r.apply}` : ''));
      }
    }
    if (!apply) console.log('[audit] report only — nothing changed. MIRROR and ORPHANED_TYPE records are the only ones --apply would touch.');
  }
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { classify };
