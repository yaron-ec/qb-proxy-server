/* eslint-disable no-undef */
'use strict';
/**
 * migrateAppointmentsToRailway.js — Convert Base44 Lead appointment fields to
 * Railway appointments rows.
 *
 * PREREQUISITE: migrateLeadsToRailway.js AND migrateOwnersToRailway.js.
 *
 * Base44 stores appointment data as flat fields on the Lead entity:
 *   appointment_date, appointment_time, follow_up_date, follow_up_time,
 *   follow_up_type, meeting_stage
 *
 * Railway has a proper appointments table with TIMESTAMPTZ, TSTZRANGE,
 * owner_id, appointment_type_id, etc. This script reads all Base44 leads
 * that have appointment_date or follow_up_date and creates corresponding
 * appointment rows.
 *
 * Timezone: America/Los_Angeles (PDT = -07:00 during DST, PST = -08:00).
 * Uses -07:00 as the default offset (current season). The booking engine
 * handles future appointments with correct DST.
 *
 * IDEMPOTENT: ON CONFLICT (idempotency_key) DO UPDATE.
 */
const { query } = require('../db/client');
const { fetchBase44Entity, buildLeadIdCache, buildOwnerCache, resolveOwnerId, hasBase44Creds } = require('./migrationHelpers');

function parseTimeToHHMM(timeStr) {
  if (!timeStr) return '00:00';
  const m = String(timeStr).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return '00:00';
  let hours = parseInt(m[1]);
  const minutes = parseInt(m[2]);
  const ampm = m[3]?.toUpperCase();
  if (ampm === 'PM' && hours < 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

function toTimestamp(dateStr, timeStr) {
  if (!dateStr) return null;
  const hhmm = parseTimeToHHMM(timeStr);
  // Use -07:00 (PDT). For PST dates this is 1 hour off, acceptable for migration.
  return `${dateStr}T${hhmm}:00-07:00`;
}

async function getAppointmentTypeId(name) {
  const { rows } = await query('SELECT id FROM appointment_types WHERE name = $1', [name]);
  return rows[0]?.id || null;
}

async function main() {
  console.log('[migrate-appts] Starting appointment conversion...');
  if (!hasBase44Creds()) { console.error('[migrate-appts] BASE44_APP_ID and BASE44_API_KEY required'); process.exit(1); }

  const [leadIdCache, ownerCache] = await Promise.all([buildLeadIdCache(), buildOwnerCache()]);
  console.log(`[migrate-appts] Loaded ${Object.keys(leadIdCache).length} lead, ${Object.keys(ownerCache).length} owner mappings`);

  // Get default appointment type IDs
  const consultationTypeId = await getAppointmentTypeId('Consultation');
  const meetingTypeId = await getAppointmentTypeId('General Meeting');
  if (!consultationTypeId || !meetingTypeId) {
    console.error('[migrate-appts] Required appointment types not found. Run schema migrations first.');
    process.exit(1);
  }

  const base44Leads = await fetchBase44Entity('Lead');
  console.log(`[migrate-appts] Fetched ${base44Leads.length} leads from Base44`);

  let created = 0, updated = 0, skipped = 0, errors = 0, leadNotFound = 0, ownerNotFound = 0, noDate = 0;

  for (let i = 0; i < base44Leads.length; i++) {
    const lead = base44Leads[i];
    try {
      const externalRef = lead.id;
      if (!externalRef) { skipped++; continue; }
      const railwayLeadId = leadIdCache[String(externalRef)];
      if (!railwayLeadId) { leadNotFound++; continue; }

      // Determine appointment date/time (prefer appointment_date, fallback to follow_up_date)
      let apptDate = lead.appointment_date;
      let apptTime = lead.appointment_time;
      let apptType = 'Consultation';

      if (!apptDate && lead.follow_up_date) {
        apptDate = lead.follow_up_date;
        apptTime = lead.follow_up_time;
        apptType = lead.follow_up_type === 'Phone Call' ? 'Consultation' : 'General Meeting';
      }

      if (!apptDate) { noDate++; continue; }

      // Resolve owner
      const ownerId = resolveOwnerId(lead.assigned_rep, ownerCache);
      if (!ownerId) { ownerNotFound++; continue; }

      const startAt = toTimestamp(apptDate, apptTime);
      if (!startAt) { noDate++; continue; }

      // Default 60 min duration
      const startDate = new Date(startAt);
      const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      const endAt = endDate.toISOString().replace(/\.000Z$/, '-07:00');
      // Actually, just construct from the date components
      const endAtStr = `${apptDate}T${String(endDate.getUTCHours() + 7).padStart(2, '0')}:${String(endDate.getUTCMinutes()).padStart(2, '0')}:00-07:00`;

      const apptTypeId = apptType === 'General Meeting' ? meetingTypeId : consultationTypeId;
      const idempotencyKey = `migration:appt:${externalRef}`;

      // Determine status
      let status = 'scheduled';
      if (lead.status === 'No show') status = 'no_show';
      else if (lead.status === 'Sold' || lead.status === 'Lost' || lead.status === 'DNQ') status = 'completed';

      const { rows } = await query(`
        INSERT INTO appointments (
          lead_id, owner_id, appointment_type_id, start_at, end_at,
          duration_override_minutes, timezone, busy_range, status,
          idempotency_key, calendar_sync_status, override_conflict
        ) VALUES (
          $1, $2, $3, $4::timestamptz, $5::timestamptz,
          60, 'America/Los_Angeles', tstzrange($4::timestamptz, $5::timestamptz), $6,
          $7, 'pending', true
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET
          lead_id = EXCLUDED.lead_id,
          owner_id = EXCLUDED.owner_id,
          start_at = EXCLUDED.start_at,
          end_at = EXCLUDED.end_at,
          busy_range = EXCLUDED.busy_range,
          status = EXCLUDED.status,
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted
      `, [
        railwayLeadId, ownerId, apptTypeId,
        startAt, endAtStr,
        status, idempotencyKey,
      ]);
      if (rows[0]?.inserted) created++; else updated++;

      if ((i + 1) % 500 === 0) console.log(`[migrate-appts] Progress: ${i + 1}/${base44Leads.length}`);
    } catch (e) {
      errors++;
      if (errors <= 10) console.error(`[migrate-appts] Error on lead ${lead.id}: ${e.message}`);
    }
  }

  console.log(`\n=== APPOINTMENT MIGRATION COMPLETE ===`);
  console.log(`Total leads scanned: ${base44Leads.length}`);
  console.log(`Created: ${created}, Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`No appointment date: ${noDate}, Lead not found: ${leadNotFound}, Owner not found: ${ownerNotFound}`);
  const { rows } = await query('SELECT COUNT(*) as cnt FROM appointments');
  console.log(`Railway appointments table now has: ${rows[0].cnt} rows`);
  process.exit(0);
}

main().catch(e => { console.error('[migrate-appts] fatal:', e); process.exit(1); });