#!/usr/bin/env node
/* eslint-disable no-undef */
'use strict';
/**
 * revertLegacyPhoneCallConversion.js — undo lib/booking/legacyPhoneCallConversion.js
 * from its backups (legacy_phone_call_conversions).
 *
 * For each 'converted' / 'deduplicated' record (optionally one appointment):
 *   - the lead's follow-up fields are restored from lead_followup_before, but
 *     ONLY if the lead still holds the follow-up the conversion wrote (same
 *     Phone Call date/time) — a follow-up edited since is never overwritten
 *     (reported as 'follow_up_changed_since');
 *   - the appointment's status is restored from appointment_before (version+1,
 *     audited in appointment_events). Its Google main event is NOT re-created:
 *     a Phone Call's only calendar presence is its follow-up reminder;
 *   - the record is marked 'reverted'.
 * 'ambiguous' records changed nothing and have nothing to revert.
 *
 * REPORT-ONLY by default. APPLY=1 to write. APPOINTMENT_ID=<uuid> to limit.
 * Env: DATABASE_URL.
 */
const { pool } = require('../db/client');
const { laDateTime } = require('../lib/booking/legacyPhoneCallConversion');

async function main() {
  const apply = process.env.APPLY === '1';
  const only = process.env.APPOINTMENT_ID || null;
  const recs = (await pool.query(
    `SELECT * FROM legacy_phone_call_conversions
      WHERE action IN ('converted','deduplicated') AND ($1::uuid IS NULL OR appointment_id = $1::uuid)
      ORDER BY created_at`, [only])).rows;
  const out = { mode: apply ? 'APPLY' : 'REPORT-ONLY', records: recs.length, reverted: 0, skipped: [] };

  for (const rec of recs) {
    const before = rec.appointment_before;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const appt = (await client.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [rec.appointment_id])).rows[0];
      if (!appt) { out.skipped.push({ appointment_id: rec.appointment_id, reason: 'appointment_missing' }); await client.query('ROLLBACK'); continue; }
      let restoreLead = false;
      if (rec.action === 'converted' && rec.lead_id) {
        const lead = (await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [rec.lead_id])).rows[0];
        const { date, time } = laDateTime(before.start_at);
        const untouched = lead && lead.follow_up_type === 'Phone Call' && lead.follow_up_date === date
          && String(lead.follow_up_time || '').slice(0, 5) === time;
        if (!untouched) {
          out.skipped.push({ appointment_id: rec.appointment_id, reason: lead ? 'follow_up_changed_since' : 'lead_missing' });
          await client.query('ROLLBACK');
          continue;
        }
        restoreLead = true;
      }
      if (!apply) { await client.query('ROLLBACK'); out.reverted++; continue; }
      if (restoreLead) {
        const f = rec.lead_followup_before || {};
        await client.query(
          `UPDATE leads SET follow_up_date = $2, follow_up_time = $3, follow_up_type = $4, follow_up_notes = $5,
                  follow_up_status = $6, updated_at = NOW() WHERE id = $1`,
          [rec.lead_id, f.follow_up_date || null, f.follow_up_time || null, f.follow_up_type || null,
            f.follow_up_notes || null, f.follow_up_status || null]);
      }
      await client.query(`UPDATE appointments SET status = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
        [rec.appointment_id, before.status]);
      await client.query(
        `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values)
         VALUES ($1, 'system:legacy-phone-call-revert', 'status_changed', $2, $3)`,
        [rec.appointment_id, JSON.stringify({ status: appt.status }), JSON.stringify({ status: before.status })]);
      await client.query(`UPDATE legacy_phone_call_conversions SET action = 'reverted', reverted_at = NOW() WHERE appointment_id = $1`,
        [rec.appointment_id]);
      await client.query('COMMIT');
      out.reverted++;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      out.skipped.push({ appointment_id: rec.appointment_id, reason: 'error: ' + e.message });
    } finally {
      client.release();
    }
  }
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
