/* eslint-disable no-undef */
/**
 * /api/v1/leads — Railway CRM Lead API (R1A foundation: read + activities).
 *
 *   GET  /api/v1/leads                       list (owner-scoped, filtered)
 *   GET  /api/v1/leads/:id                    single lead (owner-scoped)
 *   GET  /api/v1/leads/:id/activities          activities for a lead
 *   POST /api/v1/leads/:id/activities          create an activity
 *
 * Auth: Railway JWT (requireAuth) + owner-scope authorization.
 *   admin/manager: all leads. office: read-only, all. sales_rep: own owner only.
 *
 * R1A is READ-ONLY (list/get/activities). Writes (create/update/duplicate-check)
 * arrive in R1B. This endpoint reads the canonical Railway `leads` table.
 *
 * Response shape mirrors the Base44 Lead entity (camelCase) so the frontend
 * can adopt it with a one-line import swap in R1B.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { canonicalEmail } = require('../lib/authorization');
const { isOverrideAdminEmail } = require('../lib/captureOverrideAuth');
const { query, pool } = require('../db/client');
const calendarOutbox = require('../lib/booking/calendarOutbox');
const googleContactsClient = require('../lib/googleContactsClient');
const { toUtcIso } = require('../lib/booking/slotBlocking');
const { syncLeadToReminders, removeFromReminders } = require('../lib/reminderProjection');
const { notifyCrmActivity } = require('../lib/crmActivityNotifier');
const { processAddress, buildAddressFieldMap, ensureAddressColumns } = require('../lib/addressPipeline');
const bookingService = require('../lib/booking/bookingService');
const { lockLeadIdentity } = require('../lib/booking/leadResolution');
const { serializeAppointment, fetchActiveAppointmentsForLeads } = require('../lib/booking/appointmentView');
const { normalizeFollowUp, FOLLOW_UP_FIELDS } = require('../lib/followUp');
const router = express.Router();

// ── Lead field diff helper ──────────────────────────────────────────────────
// Computes a changes[] array for the notification email by comparing old and
// new lead rows. Only includes fields that actually changed.
const LEAD_DIFF_FIELDS = [
  { col: 'status', label: 'Status' },
  { col: 'first_name', label: 'First Name' },
  { col: 'last_name', label: 'Last Name' },
  { col: 'phone', label: 'Phone' },
  { col: 'email', label: 'Email' },
  { col: 'property_address', label: 'Property Address' },
  { col: 'city', label: 'City' },
  { col: 'project_type', label: 'Project Type' },
  { col: 'budget_range', label: 'Budget' },
  { col: 'source', label: 'Source' },
  { col: 'notes', label: 'Notes' },
  { col: 'follow_up_date', label: 'Follow-Up Date' },
  { col: 'follow_up_time', label: 'Follow-Up Time' },
  { col: 'follow_up_type', label: 'Follow-Up Type' },
  { col: 'follow_up_notes', label: 'Follow-Up Notes' },
  { col: 'follow_up_status', label: 'Follow-Up Status' },
  { col: 'meeting_stage', label: 'Meeting Stage' },
  { col: 'assigned_rep', label: 'Owner' },
];

function computeLeadDiff(oldRow, newRow) {
  const changes = [];
  for (const { col, label } of LEAD_DIFF_FIELDS) {
    const oldVal = oldRow ? String(oldRow[col] == null ? '' : oldRow[col]) : '';
    const newVal = newRow ? String(newRow[col] == null ? '' : newRow[col]) : '';
    if (oldVal !== newVal) {
      changes.push({ label, prev: oldVal || '\u2014', next: newVal || '\u2014' });
    }
  }
  return changes;
}

// ── Post-commit notification helper (best-effort, non-blocking) ──────────────
function sendLeadNotification(action, leadRow, changes, actorEmail, activityType, content) {
  if (!leadRow) return;
  const leadName = `${leadRow.first_name || ''} ${leadRow.last_name || ''}`.trim() || 'Unknown';
  const repName = leadRow.owner_display_name || leadRow.owner_email || 'Unassigned';
  // Fire-and-forget — never block the response. Errors are caught inside.
  Promise.resolve().then(() => notifyCrmActivity({
    action,
    leadId: leadRow.id,
    leadName,
    repName,
    actorEmail,
    changes,
    activityType,
    content,
  })).catch(e => console.error('[leads] notification failed:', action, e.message));
}

// ── Lead deletion helper: clean up TEXT lead_id tables ───────────────────
// These tables reference leads by TEXT lead_id (no FK), so PostgreSQL won't
// cascade-delete them. They must be cleaned up explicitly within the same
// transaction as the lead DELETE to prevent orphan rows and prevent future
// reminder/worker processing for a deleted Lead.
async function cleanupLeadTextRefs(client, leadId) {
  // reminder_claims: Lead-owned reminder claim state — DELETE
  await client.query(`DELETE FROM reminder_claims WHERE lead_id = $1`, [leadId]);
  // reminder_activity_queue: Lead-owned Activity write retry queue — DELETE
  await client.query(`DELETE FROM reminder_activity_queue WHERE lead_id = $1`, [leadId]);
  // reminder_runs: historical run log — unlink (SET NULL), preserve audit trail
  await client.query(`UPDATE reminder_runs SET last_reminder_lead_id = NULL WHERE last_reminder_lead_id = $1`, [leadId]);
  // qb_invoice_sale_map: invoice->sale mapping — unlink (SET empty), preserve QB invoice mapping
  // Cast $1::text — PostgreSQL cannot infer the type of an empty string literal in a prepared statement.
  await client.query(`UPDATE qb_invoice_sale_map SET crm_lead_id = $1::text WHERE crm_lead_id = $2`, ['', leadId]);
}

// ── Lead deletion helper: cancel active appointments ──────────────────────
// The appointments table is IMMUTABLE — a RULE blocks physical DELETE (audit
// trail). The FK is ON DELETE SET NULL (not CASCADE), so the appointment rows
// survive with lead_id = NULL. But we must first cancel any active
// appointments (status → 'cancelled') and enqueue calendar outbox
// cancellations so Google Calendar events are removed. This runs inside the
// same atomic transaction as the lead DELETE.
async function cancelAppointmentsForLeadDelete(client, leadId) {
  const { rows } = await client.query(
    `SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed')`,
    [leadId]
  );
  for (const appt of rows) {
    const newVersion = (appt.version || 1) + 1;
    await client.query(
      'UPDATE appointments SET status = $1, version = $2, updated_at = NOW() WHERE id = $3',
      ['cancelled', newVersion, appt.id]
    );
    // Enqueue calendar outbox cancellation (Google Calendar event removal)
    try {
      const cancelledAppt = (await client.query('SELECT * FROM appointments WHERE id = $1', [appt.id])).rows[0];
      await calendarOutbox.enqueueCancel(client, cancelledAppt, cancelledAppt.version);
    } catch (e) {
      console.warn('[leads] calendar outbox cancel failed (non-blocking):', e.message);
    }
  }
}

// ── Owner-scope resolution ───────────────────────────────────────────────────
// admin/manager: no filter. office: no filter (read-only). sales_rep: own owner.
async function resolveOwnerScope(user) {
  const role = String((user && user.role) || '').toLowerCase();
  if (!role) return { denied: true };
  if (role === 'admin' || role === 'manager') return { ownerFilter: null };
  if (role === 'office') return { ownerFilter: null, readOnly: true };
  if (role === 'sales_rep') {
    const email = canonicalEmail(user.email);
    if (!email) return { denied: true };
    const r = await query('SELECT id FROM owners WHERE lower(email) = lower($1) AND is_active = true', [email]);
    if (!r.rows[0]) return { ownerFilter: '00000000-0000-0000-0000-000000000000' }; // no matches → empty
    return { ownerFilter: r.rows[0].id };
  }
  return { denied: true };
}

// ── Row serializer: snake_case DB row → camelCase API response ───────────────
// Fetch the active (scheduled/confirmed) appointment for a lead.
// Returns null if no active appointment exists.
async function fetchActiveAppointment(leadId) {
  const { rows } = await query(
    `SELECT * FROM appointments
     WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed')
     ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  );
  return rows[0] || null;
}

function serializeLead(row, appointment = null) {
  if (!row) return null;
  // APPOINTMENT (canonical: the active appointments row — lib/booking/appointmentView).
  // FOLLOW-UP (canonical: leads.follow_up_*). The two are independent; the
  // appointment is never read from, or mirrored into, the follow-up fields.
  const appt = serializeAppointment(appointment);
  return {
    id: row.id,
    external_ref: row.external_ref,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
    email: row.email,
    phone: row.phone,
    property_address: row.property_address,
    city: row.city,
    zip: row.zip,
    state: row.state,
    // ── Address verification state (canonical: lib/addressPipeline.js) ──
    // Written by the SAME geocoding pipeline used for routing/My Day Map —
    // never a second, independent geocode. 'verified' = Google resolved a
    // high-confidence exact match; 'needs_review' = Google found something
    // but it materially differs from what was entered (never silently
    // applied — property_address/city/state/zip stay as originally entered
    // until a human confirms verified_property_address).
    property_geocode_status: row.property_geocode_status || null,
    verified_property_address: row.verified_property_address || null,
    property_lat: row.property_lat != null ? Number(row.property_lat) : null,
    property_lng: row.property_lng != null ? Number(row.property_lng) : null,
    google_place_id: row.google_place_id || null,
    original_property_address: row.original_property_address || null,
    original_city: row.original_city || null,
    project_type: row.project_type,
    budget_range: row.budget_range,
    start_timeframe: row.start_timeframe,
    source: row.source,
    referral_name: row.referral_name,
    owner_id: row.owner_id,
    assigned_rep: row.owner_display_name || row.owner_email || null,
    status: row.status,
    notes: row.notes,
    message: row.message || null,
    lead_score: row.lead_score || 0,
    is_new_intake_lead: row.is_new_intake_lead || false,
    customer_reminders_disabled: row.customer_reminders_disabled || false,
    photo_urls: row.photo_urls || [],
    record_type: row.record_type || 'Lead',
    follow_up_date: row.follow_up_date || null,
    follow_up_time: row.follow_up_time || null,
    follow_up_type: row.follow_up_type || null,
    follow_up_notes: row.follow_up_notes || null,
    follow_up_status: row.follow_up_status || (row.follow_up_date ? 'pending' : null),
    meeting_stage: row.meeting_stage || null,
    appointment: appt,
    appointment_id: appt ? appt.id : null,
    appointment_date: appt ? appt.date : null,
    appointment_time: appt ? appt.time : null,
    appointment_type: appt ? appt.kind : null,
    appointment_status: appt ? appt.status : null,
    crm_created_date: row.crm_created_date || row.created_at,
    reviewed_at: row.reviewed_at || null,
    created_date: row.created_at,
    updated_date: row.updated_at,
    // ── Calendar sync state (canonical: appointments table, NOT leads) ──
    // The Base44-era leads.google_calendar_sync_status column does NOT exist in
    // the Railway schema. The canonical state lives in appointments:
    //   calendar_sync_status, google_event_id, google_travel_event_id,
    //   calendar_last_error, calendar_synced_at
    // We expose them on the lead object under the legacy field names so the
    // frontend CalendarSyncPanel works without interface changes.
    google_calendar_sync_status: appt ? appt.calendar_sync_status : null,
    google_event_id: appointment?.google_event_id || null,
    google_travel_event_id: appointment?.google_travel_event_id || null,
    google_calendar_sync_error: appointment?.calendar_last_error || null,
    last_google_sync: appointment?.calendar_synced_at || null,
    // Google Contacts sync state (canonical: leads table — these columns
    // were added by the 2026-09-crm-core migration)
    google_contact_sync_status: row.google_contact_sync_status || null,
    google_contact_resource_name: row.google_contact_resource_name || null,
    google_contact_sync_error: row.google_contact_sync_error || null,
  };
}

function serializeActivity(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    type: row.type,
    content: row.content,
    author: row.author,
    source: row.source,
    metadata: row.metadata || {},
    timestamp: row.created_at,
    created_date: row.created_at,
  };
}

// ── Contact-field validation helpers ────────────────────────────────────────
const CONTACT_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'property_address', 'city', 'state', 'zip'];

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+1${digits.slice(1)}`;
  return null;
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Safe identifier resolution (shared module) ───────────────────────────────
// Extracted to lib/leadResolver.js so all routes (leads, leadQB, activities,
// etc.) use the SAME safe identifier resolution. PostgreSQL throws "invalid
// input syntax for type uuid" if a non-UUID string is compared against a uuid
// column. The shared leadIdWhere() only compares against `id` when the
// identifier is a valid UUID, and always compares against external_ref.
const { UUID_RE, leadIdWhere, resolveLeadByIdentifier } = require('../lib/leadResolver');

// ── GET /by-external/:externalRef — get lead by external_ref OR Railway UUID ──
router.get('/by-external/:externalRef', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const leadRow = await resolveLeadByIdentifier(externalRef);
    if (!leadRow) return res.status(404).json({ error: 'not_found' });
    const appointment = await fetchActiveAppointment(leadRow.id);
    res.json({ lead: serializeLead(leadRow, appointment) });
  } catch (e) {
    console.error('[leads] get-by-external error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /by-external/:externalRef — upsert + update contact fields ───────────
// Updates ONLY contact fields (first_name, last_name, phone, email,
// property_address, city, state, zip). Does NOT touch appointment fields,
// status, owner_id, or any other column. No side effects (no calendar,
// no reminders, no emails, no QB, no projection).
router.put('/by-external/:externalRef', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    if (!externalRef) return res.status(400).json({ error: 'external_ref required' });

    // office role is read-only
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    const body = req.body || {};

    // Build cleaned contact fields (only allow known contact fields)
    const cleaned = {};
    for (const f of CONTACT_FIELDS) {
      if (body[f] !== undefined) {
        const val = typeof body[f] === 'string' ? body[f].trim() : body[f];
        cleaned[f] = val || null;
      }
    }

    // first_name and last_name are NOT NULL in the DB — required for upsert
    if (cleaned.first_name === null) delete cleaned.first_name;
    if (cleaned.last_name === null) delete cleaned.last_name;

    // Validate email format
    if (cleaned.email !== undefined && cleaned.email !== null && !isValidEmail(cleaned.email)) {
      return res.status(400).json({ error: 'invalid_email', message: 'Invalid email format' });
    }

    // Normalize + validate phone
    if (cleaned.phone !== undefined && cleaned.phone !== null && cleaned.phone !== '') {
      const normalized = normalizePhone(cleaned.phone);
      if (!normalized) {
        return res.status(400).json({ error: 'invalid_phone', message: 'Phone must be a valid US number (10 digits)' });
      }
      cleaned.phone = normalized;
    } else if (cleaned.phone === '') {
      cleaned.phone = null;
    }

    // Duplicate check: if email or phone is changing, check other leads
    if (cleaned.email) {
      const dup = await query(
        `SELECT id, external_ref, first_name, last_name FROM leads
         WHERE lower(email) = lower($1) AND external_ref != $2 LIMIT 1`,
        [cleaned.email, externalRef]
      );
      if (dup.rows[0]) {
        return res.status(409).json({
          error: 'duplicate_email',
          message: `Email already belongs to another lead: ${dup.rows[0].first_name} ${dup.rows[0].last_name}`,
          conflict: { id: dup.rows[0].id, external_ref: dup.rows[0].external_ref, name: `${dup.rows[0].first_name} ${dup.rows[0].last_name}` },
        });
      }
    }
    if (cleaned.phone) {
      const dup = await query(
        `SELECT id, external_ref, first_name, last_name FROM leads
         WHERE phone = $1 AND external_ref != $2 LIMIT 1`,
        [cleaned.phone, externalRef]
      );
      if (dup.rows[0]) {
        return res.status(409).json({
          error: 'duplicate_phone',
          message: `Phone already belongs to another lead: ${dup.rows[0].first_name} ${dup.rows[0].last_name}`,
          conflict: { id: dup.rows[0].id, external_ref: dup.rows[0].external_ref, name: `${dup.rows[0].first_name} ${dup.rows[0].last_name}` },
        });
      }
    }

    // For INSERT (new Railway row), first_name + last_name are NOT NULL.
    // Use provided values, or fetch from existing row if the lead already exists.
    // Use safe identifier resolution (external_ref OR Railway UUID).
    let insertFirstName = cleaned.first_name;
    let insertLastName = cleaned.last_name;

    if (!insertFirstName || !insertLastName) {
      const { whereSql: existWhere, params: existParams } = leadIdWhere(externalRef);
      const existing = await query(`SELECT first_name, last_name FROM leads WHERE ${existWhere}`, existParams);
      if (existing.rows[0]) {
        insertFirstName = insertFirstName || existing.rows[0].first_name;
        insertLastName = insertLastName || existing.rows[0].last_name;
      }
    }
    if (!insertFirstName || !insertLastName) {
      return res.status(400).json({ error: 'first_name and last_name are required' });
    }

    // Build a combined field set: contact fields + CRM fields.
    // Contact fields use cleaned[] (validated/normalized above).
    // CRM fields pass through from body with minimal normalization.
    const CRM_FIELDS = [
      'status', 'notes', 'follow_up_date', 'follow_up_time', 'follow_up_type',
      'meeting_stage', 'project_type', 'budget_range', 'start_timeframe', 'source',
      'referral_name', 'lead_score', 'is_new_intake_lead', 'customer_reminders_disabled',
      'record_type', 'reviewed_at', 'message', 'photo_urls',
    ];

    // Build the combined field map
    const allFields = {};
    // Contact fields (from cleaned, which has validation applied)
    for (const col of CONTACT_FIELDS) {
      if (cleaned[col] !== undefined) allFields[col] = cleaned[col];
    }
    // CRM fields (from body, pass through)
    for (const col of CRM_FIELDS) {
      if (body[col] !== undefined) {
        let val = body[col];
        // Handle boolean fields
        if (['is_new_intake_lead', 'customer_reminders_disabled'].includes(col)) {
          val = val === true || val === 'true';
        }
        // Handle photo_urls (array → JSONB)
        if (col === 'photo_urls' && Array.isArray(val)) {
          val = JSON.stringify(val);
        }
        allFields[col] = val;
      }
    }
    // Handle assigned_rep → owner_id mapping (look up by display name)
    // owner_id is NOT NULL in the DB — never set it to null/empty. If the
    // frontend clears assigned_rep, preserve the existing DB value by simply
    // not including owner_id in the update.
    if (body.assigned_rep !== undefined && body.owner_id === undefined) {
      const ownerR = await query('SELECT id FROM owners WHERE display_name = $1 AND is_active = true', [body.assigned_rep]);
      if (ownerR.rows[0]) {
        allFields.owner_id = ownerR.rows[0].id;
      }
    }
    // Only set owner_id from body if it's a non-null, non-empty value
    if (body.owner_id !== undefined && body.owner_id !== null && body.owner_id !== '') {
      allFields.owner_id = body.owner_id;
    }

    // ── Canonical address pipeline (when address fields are present) ──
    // Run the canonical pipeline on the address fields and merge the
    // canonical Street/City/State/ZIP + verified/lat/lng/placeId into allFields.
    if (allFields.property_address !== undefined && allFields.property_address) {
      await ensureAddressColumns();
      try {
        const addressResult = await processAddress({
          street: allFields.property_address,
          city: allFields.city || '',
          state: allFields.state || '',
          zip: allFields.zip || '',
        });
        const addrMap = buildAddressFieldMap(addressResult, null);
        // Canonical fields override the raw values
        for (const col of ['property_address', 'city', 'state', 'zip',
                           'verified_property_address', 'property_lat', 'property_lng',
                           'google_place_id', 'property_geocode_status',
                           'original_property_address', 'original_city']) {
          if (addrMap[col] !== undefined) {
            allFields[col] = addrMap[col];
          }
        }
      } catch (e) { console.warn('[leads] address pipeline (upsert) failed (non-blocking):', e.message); }
    }

    // ── Railway UUID resolution: if the identifier is a valid UUID and a lead
    // exists with that id, UPDATE by id instead of upserting. The upsert's
    // ON CONFLICT (external_ref) would INSERT a duplicate row for Railway-native
    // leads (external_ref = NULL) when called with their Railway UUID.
    const { whereSql: upsertWhere, params: upsertParams } = leadIdWhere(externalRef);
    const existingById = await query(`SELECT id, external_ref FROM leads WHERE ${upsertWhere} LIMIT 1`, upsertParams);
    const isRailwayNativeUpdate = existingById.rows[0] && UUID_RE.test(String(externalRef)) && existingById.rows[0].id === externalRef;

    let sql, params;
    if (isRailwayNativeUpdate) {
      // UPDATE by canonical Railway UUID — no external_ref upsert, no duplicate.
      const setCols = Object.keys(allFields);
      const setClause = setCols.map((col, i) => `${col} = $${i + 1}`).join(', ');
      params = [...setCols.map(c => allFields[c]), existingById.rows[0].id];
      sql = `UPDATE leads SET ${setClause}, updated_at = NOW() WHERE id = $${setCols.length + 1} RETURNING *`;
    } else {
      // Upsert by external_ref (legacy leads or new inserts from Base44).
      const insertCols = ['external_ref', 'first_name', 'last_name'];
      params = [externalRef, insertFirstName, insertLastName];
      for (const col of Object.keys(allFields)) {
        if (insertCols.includes(col)) continue; // skip duplicates (first_name, last_name)
        insertCols.push(col);
        params.push(allFields[col]);
      }
      const setParts = Object.keys(allFields).map(col => `${col} = EXCLUDED.${col}`);
      setParts.push('updated_at = NOW()');
      const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
      sql = `
        INSERT INTO leads (${insertCols.join(', ')})
        VALUES (${insertPlaceholders})
        ON CONFLICT (external_ref) DO UPDATE SET ${setParts.join(', ')}
        RETURNING *
      `;
    }

    // ── Atomic: lead upsert + reminder projection in ONE transaction ──────
    // If the reminder projection fails, the lead upsert rolls back too —
    // the CRM and the reminder engine can never diverge.
    const client = await pool.connect();
    let fullRow;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(sql, params);
      const updated = rows[0];
      if (!updated) { await client.query('ROLLBACK'); return res.status(500).json({ error: 'upsert failed' }); }

      fullRow = (await client.query(
        `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
         FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
         WHERE l.id = $1`,
        [updated.id]
      )).rows[0];

      // Project the updated lead into reminder_leads (same transaction).
      await syncLeadToReminders(client, fullRow);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('[leads] put-by-external error:', e.message);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }

    // ── Post-commit: notify admins (best-effort) ─────────────────────────
    const wasNew = !existingById.rows[0];
    sendLeadNotification(
      wasNew ? 'lead_created' : 'lead_updated',
      fullRow,
      wasNew ? [] : computeLeadDiff(null, fullRow),
      req.user?.email
    );

    // Post-commit: enqueue Google Contacts sync — this legacy upsert-by-
    // external-ref path previously never enqueued at all (unlike POST / and
    // publicCapture.js), so any lead created OR edited only through this
    // route would never sync to Google Contacts, and a phone/email/name
    // correction made through it would leave an existing Google Contact
    // stale. Enqueue whenever the lead is new, or any contact field was
    // part of this request.
    const contactFieldsTouched = CONTACT_FIELDS.some(f => cleaned[f] !== undefined);
    if (wasNew || contactFieldsTouched) {
      try {
        const contactsOutbox = require('../lib/googleContactsOutbox');
        await contactsOutbox.enqueueContactSync(pool, fullRow.id);
      } catch (e) { console.warn('[leads] contacts outbox enqueue failed (non-fatal):', e.message); }
    }

    const appt = await fetchActiveAppointment(fullRow.id);
    res.json({ lead: serializeLead(fullRow, appt) });
  } catch (e) {
    console.error('[leads] put-by-external error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /by-external/:externalRef — delete by Base44 ID ───────────────────
router.delete('/by-external/:externalRef', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    if (!externalRef) return res.status(400).json({ error: 'external_ref required' });

    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    const { whereSql: delWhere, params: delParams } = leadIdWhere(externalRef);
    const leadR = await query(`SELECT id, external_ref, owner_id FROM leads WHERE ${delWhere}`, delParams);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // ── Atomic: lead delete + dependency cleanup in ONE transaction ────
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await removeFromReminders(client, leadR.rows[0]);
      await cancelAppointmentsForLeadDelete(client, leadR.rows[0].id);
      await cleanupLeadTextRefs(client, leadR.rows[0].id);
      await client.query('DELETE FROM leads WHERE id = $1', [leadR.rows[0].id]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('[leads] delete-by-external error:', e.message);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
    res.json({ success: true, external_ref: externalRef });
  } catch (e) {
    console.error('[leads] delete-by-external error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /by-external/:externalRef/detail — composite lead detail ──────────────
// Returns lead + activities + deals + contactOwners + projectTypes + leadSources
// in a single call, replacing the Base44 getLeadDetail function.
// Resolves by external_ref (legacy Base44 ID) OR Railway UUID — so Lead Detail
// opens correctly regardless of which identifier the route param carries.
router.get('/by-external/:externalRef/detail', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const leadRow = await resolveLeadByIdentifier(externalRef);
    if (!leadRow) return res.status(404).json({ error: 'not_found' });

    const railwayLeadId = leadRow.id;

    // Parallel fetch: appointment, activities, deals, owners, settings
    // The canonical source is the app_settings KV table (key='app_lists').
    // The value JSONB holds projectTypes, sources, etc. (camelCase — matches
    // the Settings UI). The old settings singleton (id=1) is NOT the source
    // of truth for app lists.
    const [apptRes, actRes, dealRes, ownerRes, settingsRes] = await Promise.all([
      query(`SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed')
             ORDER BY created_at DESC LIMIT 1`, [railwayLeadId]),
      query('SELECT * FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 500', [railwayLeadId]),
      query('SELECT * FROM deals WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100', [railwayLeadId]),
      query('SELECT id, display_name, email FROM owners WHERE is_active = true ORDER BY display_name ASC'),
      query(`SELECT value FROM app_settings WHERE key = 'app_lists'`),
    ]);

    const lead = serializeLead(leadRow, apptRes.rows[0]);

    // Extract projectTypes and sources from the canonical app_settings JSONB
    const appLists = (settingsRes.rows[0] && settingsRes.rows[0].value) || {};

    res.json({
      lead,
      activities: actRes.rows.map(serializeActivity),
      deals: dealRes.rows,
      contactOwners: ownerRes.rows.map(o => ({ id: o.id, display_name: o.display_name, email: o.email })),
      projectTypes: appLists.projectTypes || [],
      leadSources: appLists.sources || [],
    });
  } catch (e) {
    console.error('[leads] get-detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Appointment vs Follow-Up — two independent write paths ────────────────────
//
//   APPOINTMENT  PUT /:id/appointment  (and /by-external/:ref/appointment)
//     body { appointment_date:'YYYY-MM-DD', appointment_time:'HH:MM',
//            appointment_type:'Meeting'|'Phone Call', duration_minutes?,
//            admin_override?, expected_appointment_id? }   → create / reschedule
//     body { cancel: true }                                   → cancel
//     Always goes through lib/booking/bookingService (owner-schedule lock +
//     overlap check, travel buffers, audit events, calendar outbox, reminder
//     projection — all in ONE transaction).
//
//   FOLLOW-UP    PUT /:id/follow-up
//     body { follow_up_date, follow_up_time, follow_up_type, follow_up_notes,
//            follow_up_status, meeting_stage? } — partial updates merge onto the
//     stored follow-up. Never touches appointments or Google Calendar.
//
// Backward compatibility: an older client that PUTs a follow-up-shaped body
// (follow_up_* only) to /appointment is handled as a follow-up update — it can
// no longer silently create, move or cancel the appointment.
const APPOINTMENT_KINDS = ['Meeting', 'Phone Call'];
const MEETING_STAGES = ['First Meeting', 'Second Meeting', 'Third Meeting'];
const LEAD_WITH_OWNER_SQL = `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`;

async function projectReminders(client, leadId) {
  const lr = await client.query(LEAD_WITH_OWNER_SQL, [leadId]);
  if (lr.rows[0]) await syncLeadToReminders(client, lr.rows[0]);
}

function validDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseAppointmentBody(body) {
  if (body.cancel === true) return { ok: true, cancel: true };
  const errors = [];
  const date = body.appointment_date == null ? '' : String(body.appointment_date).trim();
  const rawTime = body.appointment_time == null ? '' : String(body.appointment_time).trim();
  const tm = rawTime.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  const time = tm ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null;
  const kind = body.appointment_type == null || body.appointment_type === '' ? 'Meeting' : String(body.appointment_type);
  if (!validDateStr(date)) errors.push('appointment_date must be a valid YYYY-MM-DD date');
  if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.push('appointment_time must be HH:MM (24h)');
  if (!APPOINTMENT_KINDS.includes(kind)) errors.push(`appointment_type must be one of: ${APPOINTMENT_KINDS.join(', ')}`);
  let duration;
  if (body.duration_minutes !== undefined && body.duration_minutes !== null && body.duration_minutes !== '') {
    duration = Number(body.duration_minutes);
    if (!Number.isInteger(duration) || duration <= 0 || duration > 480) errors.push('duration_minutes must be an integer between 1 and 480');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, cancel: false, date, time, kind, duration };
}

function fmtApptChange(appt) {
  if (!appt) return { date: '—', time: '—', kind: '—' };
  const a = serializeAppointment(appt);
  return { date: a.date, time: a.time, kind: a.kind };
}

// Resolve + authorize a lead for a write (UUID or external_ref). Sends the
// error response itself and returns null when the caller may not write.
async function authorizeLeadWrite(req, res) {
  const scope = await resolveOwnerScope(req.user);
  if (scope.denied) { res.status(403).json({ error: 'forbidden' }); return null; }
  if (scope.readOnly) { res.status(403).json({ error: 'forbidden', message: 'office role is read-only' }); return null; }
  const id = req.params.id || req.params.externalRef;
  const leadRow = UUID_RE.test(String(id))
    ? (await query('SELECT id, owner_id FROM leads WHERE id = $1', [id])).rows[0]
    : await resolveLeadByIdentifier(id);
  if (!leadRow) { res.status(404).json({ error: 'not_found' }); return null; }
  if (scope.ownerFilter && String(leadRow.owner_id) !== String(scope.ownerFilter)) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  return leadRow;
}

async function respondWithLead(res, leadId, extra) {
  const full = (await query(LEAD_WITH_OWNER_SQL, [leadId])).rows[0];
  const appt = await fetchActiveAppointment(leadId);
  return { full, appt, body: { lead: serializeLead(full, appt), appointment: serializeAppointment(appt), ...(extra || {}) } };
}

// ── Follow-Up update ─────────────────────────────────────────────────────────
async function executeFollowUpUpdate(req, res, leadId, opts) {
  opts = opts || {};
  const body = req.body || {};
  const touched = FOLLOW_UP_FIELDS.filter(f => body[f] !== undefined);
  const stageTouched = body.meeting_stage !== undefined;
  if (!touched.length && !stageTouched) {
    return res.status(400).json({ error: 'no_follow_up_fields', message: 'No follow-up fields to update.' });
  }
  if (stageTouched && body.meeting_stage !== null && body.meeting_stage !== '' && !MEETING_STAGES.includes(body.meeting_stage)) {
    return res.status(400).json({ error: 'validation_failed', details: [`meeting_stage must be one of: ${MEETING_STAGES.join(', ')}`] });
  }

  const client = await pool.connect();
  let before;
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [leadId]);
    before = cur.rows[0];
    if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }

    // Merge the partial update onto the stored follow-up, then validate the
    // RESULT as a whole (so a status-only or notes-only edit keeps the date).
    const merged = {};
    for (const f of FOLLOW_UP_FIELDS) merged[f] = body[f] !== undefined ? body[f] : before[f];
    const isBlank = v => v == null || String(v).trim() === '';
    // Clearing the date and type clears the whole follow-up (notes/status too).
    const clearing = touched.length > 0 && isBlank(merged.follow_up_date) && isBlank(merged.follow_up_type);
    const fu = clearing ? normalizeFollowUp({}) : (touched.length ? normalizeFollowUp(merged) : null);
    if (fu && !fu.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'validation_failed', message: fu.errors.join('; '), details: fu.errors });
    }

    const sets = [];
    const vals = [];
    if (fu) {
      for (const f of FOLLOW_UP_FIELDS) { vals.push(fu.value[f]); sets.push(`${f} = $${vals.length}`); }
    }
    if (stageTouched) { vals.push(body.meeting_stage || null); sets.push(`meeting_stage = $${vals.length}`); }
    sets.push('updated_at = NOW()');
    vals.push(leadId);
    await client.query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await projectReminders(client, leadId);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    console.error('[leads] follow-up update error:', e.message);
    return res.status(500).json({ error: 'follow_up_update_failed', message: e.message });
  } finally {
    client.release();
  }

  const out = await respondWithLead(res, leadId, opts.legacy ? { deprecated: 'follow-up fields sent to /appointment are saved as a follow-up only; use PUT /:id/follow-up' } : null);
  const changes = computeLeadDiff(before, out.full);
  if (changes.length) sendLeadNotification('lead_updated', out.full, changes, req.user && req.user.email);
  return res.json(out.body);
}

// ── Appointment create / reschedule / cancel ─────────────────────────────────
async function executeAppointmentRequest(req, res, leadId) {
  const body = req.body || {};
  const apptKeys = ['appointment_date', 'appointment_time', 'appointment_type', 'cancel'];
  if (!apptKeys.some(k => body[k] !== undefined)) {
    if (FOLLOW_UP_FIELDS.some(f => body[f] !== undefined) || body.meeting_stage !== undefined) {
      return executeFollowUpUpdate(req, res, leadId, { legacy: true });
    }
    return res.status(400).json({ error: 'no_appointment_fields', message: 'Provide appointment_date + appointment_time (or cancel: true).' });
  }

  // Admin conflict override: role 'admin' AND server-side allowlist. The
  // frontend toggle is never trusted (same contract as capture).
  const adminOverrideRequested = body.admin_override === true;
  if (adminOverrideRequested) {
    const overrideRole = String((req.user && req.user.role) || '').toLowerCase();
    const overrideEmail = canonicalEmail(req.user && req.user.email);
    if (overrideRole !== 'admin' || !isOverrideAdminEmail(overrideEmail)) {
      return res.status(403).json({ error: 'override_forbidden', message: 'Only authorized admins may override appointment conflicts.' });
    }
  }
  const actor = (req.user && req.user.email) || null;
  const parsed = parseAppointmentBody(body);
  if (!parsed.ok) return res.status(400).json({ error: 'validation_failed', message: parsed.errors.join('; '), details: parsed.errors });

  const active = await fetchActiveAppointment(leadId);
  if (body.expected_appointment_id !== undefined && String(body.expected_appointment_id || '') !== String(active ? active.id : '')) {
    return res.status(409).json({ error: 'stale_appointment', message: 'This appointment was changed elsewhere. Reload the lead and try again.' });
  }
  const onWrite = async (client) => projectReminders(client, leadId);
  let action = null;
  let result = null;
  try {
    if (parsed.cancel) {
      if (!active) return res.status(404).json({ error: 'no_active_appointment', message: 'This lead has no active appointment to cancel.' });
      await bookingService.cancelAppointment(active.id, actor, { onWrite });
      action = 'appointment_cancelled';
    } else {
      const startAt = toUtcIso(parsed.date, parsed.time, 'America/Los_Angeles');
      const skipTravel = parsed.kind === 'Phone Call';
      if (!active) {
        result = await bookingService.createAppointmentForLead({
          lead_id: leadId, start_at: startAt, skip_travel: skipTravel,
          duration_override_minutes: parsed.duration, actor,
          override_conflict: adminOverrideRequested, override_actor: adminOverrideRequested ? actor : null,
          onWrite,
        });
        action = 'appointment_created';
      } else {
        const cur = serializeAppointment(active);
        const sameStart = new Date(active.start_at).getTime() === new Date(startAt).getTime();
        const sameDuration = parsed.duration === undefined || parsed.duration === cur.duration_minutes;
        if (sameStart && cur.kind === parsed.kind && sameDuration) {
          const out = await respondWithLead(res, leadId, { action: 'unchanged' });
          return res.json(out.body);
        }
        result = await bookingService.rescheduleAppointment(active.id, {
          new_start_at: startAt, skip_travel: skipTravel,
          duration_override_minutes: parsed.duration, actor,
          override_conflict: adminOverrideRequested, override_actor: adminOverrideRequested ? actor : null,
          onWrite,
        });
        action = 'appointment_rescheduled';
      }
    }
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error('[leads] appointment change error:', e && e.message);
    const code = e && e.code === 'slot_conflict' ? 'slot_conflict' : ((e && e.code) || 'appointment_update_failed');
    const message = code === 'slot_conflict'
      ? 'This time conflicts with another appointment (including the 1-hour travel buffer). Please choose a different time.'
      : ((e && e.message) || 'Appointment update failed.');
    return res.status(status).json({ error: code, message, details: e && e.details });
  }

  const out = await respondWithLead(res, leadId, { action });
  const prev = fmtApptChange(active);
  const next = action === 'appointment_cancelled' ? { date: 'Cancelled', time: 'Cancelled', kind: 'Cancelled' } : fmtApptChange(result && result.appointment);
  sendLeadNotification(action, out.full, [
    { label: 'Date', prev: prev.date, next: next.date },
    { label: 'Time', prev: prev.time, next: next.time },
    { label: 'Type', prev: prev.kind, next: next.kind },
  ], actor);
  return res.json(out.body);
}

// ── PUT /:id/appointment — CANONICAL appointment update by Railway UUID ──────
// This is the primary appointment update route for Railway-native leads.
// Accepts ONLY valid Railway UUIDs — no external_ref, no leadIdWhere, no
// unsafe identifier comparisons. The Lead Detail appointment editor calls this
// (see executeAppointmentRequest for the body contract).
router.put('/:id/appointment', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(String(id))) {
      return res.status(400).json({ error: 'invalid_id', message: 'PUT /:id/appointment requires a valid Railway UUID.' });
    }

    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    // Verify lead exists + caller has access
    const leadR = await query('SELECT id, owner_id FROM leads WHERE id = $1', [id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    return executeAppointmentRequest(req, res, leadR.rows[0].id);
  } catch (e) {
    console.error('[leads] appointment update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /by-external/:externalRef/appointment — legacy appointment update ─────
// Resolves the lead by external_ref OR Railway UUID via the shared safe
// resolver, then delegates to executeAppointmentRequest with the canonical
// Railway UUID. Kept for backward compatibility with legacy Base44 leads.
router.put('/by-external/:externalRef/appointment', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    if (!externalRef) return res.status(400).json({ error: 'external_ref required' });

    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    const leadRow = await resolveLeadByIdentifier(externalRef);
    if (!leadRow) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadRow.owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    return executeAppointmentRequest(req, res, leadRow.id);
  } catch (e) {
    console.error('[leads] appointment update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id/follow-up — Follow-Up / Next Update (independent of appointment) ──
router.put('/:id/follow-up', requireAuth, async (req, res) => {
  try {
    const leadRow = await authorizeLeadWrite(req, res);
    if (!leadRow) return;
    return executeFollowUpUpdate(req, res, leadRow.id);
  } catch (e) {
    console.error('[leads] follow-up update error:', e.message);
    res.status(500).json({ error: 'follow_up_update_failed', message: e.message });
  }
});

// ── POST / — create a new lead (R1B) ─────────────────────────────────────────
// Auth: requireAuth. admin/manager/sales_rep can create.
// Resolves owner_id from assigned_rep (display name) or owner_email, falling
// back to the current user's owner record. Duplicate-checks email/phone.
// Projects the new lead into reminder_leads atomically.
router.post('/', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const first_name = (body.first_name || '').toString().trim();
    const last_name = (body.last_name || '').toString().trim();
    if (!first_name || !last_name) {
      return res.status(400).json({ error: 'validation_failed', message: 'first_name and last_name are required' });
    }

    // ── Resolve owner_id ───────────────────────────────────────────────
    let ownerId = null;
    // 1. Explicit owner_id (UUID)
    if (body.owner_id && UUID_RE.test(String(body.owner_id))) {
      ownerId = body.owner_id;
    }
    // 2. assigned_rep (display name) → look up owner
    if (!ownerId && body.assigned_rep) {
      const r = await query('SELECT id FROM owners WHERE display_name = $1 AND is_active = true LIMIT 1', [body.assigned_rep]);
      if (r.rows[0]) ownerId = r.rows[0].id;
    }
    // 3. owner_email → look up owner
    if (!ownerId && body.owner_email) {
      const r = await query('SELECT id FROM owners WHERE lower(email) = lower($1) AND is_active = true LIMIT 1', [body.owner_email]);
      if (r.rows[0]) ownerId = r.rows[0].id;
    }
    // 4. Fall back to current user's owner record
    if (!ownerId) {
      const r = await query('SELECT id FROM owners WHERE lower(email) = lower($1) AND is_active = true LIMIT 1', [req.user.email]);
      if (r.rows[0]) ownerId = r.rows[0].id;
    }
    if (!ownerId) {
      return res.status(400).json({ error: 'owner_not_found', message: 'Could not resolve an active owner for this lead. Specify assigned_rep or owner_email.' });
    }

    // ── Validate + normalize contact fields ────────────────────────────
    const email = body.email ? String(body.email).trim() : null;
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ error: 'invalid_email', message: 'Invalid email format' });
    }
    const phone = body.phone ? normalizePhone(body.phone) : null;
    if (body.phone && !phone) {
      return res.status(400).json({ error: 'invalid_phone', message: 'Phone must be a valid US number (10 digits)' });
    }

    // ── Duplicate check (email/phone against existing leads) ──────────
    // Fast pre-check here; re-checked authoritatively inside the INSERT
    // transaction under the per-identity intake lock (below), so two
    // simultaneous creates of the same email/phone cannot both pass.
    const dupPre = await findCreateDuplicate({ query }, email, phone);
    if (dupPre) return res.status(409).json(dupPre);

    // ── Canonical address pipeline (BEFORE the INSERT) ────────────────
    // Run the address through the canonical pipeline so the lead is created
    // with verified Street/City/State/ZIP + lat/lng from the start — not raw
    // customer-entered fields. This is the PERMANENT ingestion rule: every
    // new lead enters the CRM with a canonical address.
    let addrFields = null;
    if (body.property_address) {
      await ensureAddressColumns();
      try {
        const addressResult = await processAddress({
          street: body.property_address,
          city: body.city || '',
          state: body.state || '',
          zip: body.zip || '',
        });
        addrFields = buildAddressFieldMap(addressResult, null);
      } catch (e) { console.warn('[leads] address pipeline (POST /) failed (non-blocking):', e.message); }
    }

    // ── INSERT lead ────────────────────────────────────────────────────
    const client = await pool.connect();
    let fullRow;
    try {
      await client.query('BEGIN');
      await lockLeadIdentity(client, { email, phone });
      const dupTx = await findCreateDuplicate(client, email, phone);
      if (dupTx) {
        await client.query('ROLLBACK');
        return res.status(409).json(dupTx);
      }
      const insertRes = await client.query(
        `INSERT INTO leads (
          owner_id, first_name, last_name, email, phone,
          property_address, city, state, zip, project_type,
          budget_range, start_timeframe, source, referral_name,
          status, notes, message, lead_score, is_new_intake_lead,
          customer_reminders_disabled, photo_urls, crm_created_date,
          record_type, follow_up_date, follow_up_time, follow_up_type, meeting_stage,
          verified_property_address, property_lat, property_lng, google_place_id,
          property_geocode_status, original_property_address, original_city
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18, $19,
          $20, $21, NOW(),
          $22, $23, $24, $25, $26,
          $27, $28, $29, $30, $31, $32, $33
        ) RETURNING *`,
        [
          ownerId, first_name, last_name, email, phone,
          addrFields?.property_address || body.property_address || null,
          addrFields?.city || body.city || null,
          addrFields?.state || body.state || null,
          addrFields?.zip || body.zip || null,
          body.project_type || null,
          body.budget_range || null, body.start_timeframe || null, body.source || 'Website', body.referral_name || null,
          body.status || 'New', body.notes || null, body.message || null, body.lead_score || 0, body.is_new_intake_lead !== false,
          body.customer_reminders_disabled === true, body.photo_urls || [], body.record_type || 'Lead',
          body.follow_up_date || null, body.follow_up_time || null, body.follow_up_type || null, body.meeting_stage || null,
          addrFields?.verified_property_address || null,
          addrFields?.property_lat || null,
          addrFields?.property_lng || null,
          addrFields?.google_place_id || null,
          addrFields?.property_geocode_status || 'pending',
          addrFields?.original_property_address || null,
          addrFields?.original_city || null,
        ]
      );
      const newLead = insertRes.rows[0];

      fullRow = (await client.query(
        `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
         FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`,
        [newLead.id]
      )).rows[0];

      // Project into reminder_leads (same transaction)
      await syncLeadToReminders(client, fullRow);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('[leads] create error:', e.message);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }

    // ── Post-commit: activity note + notification (best-effort) ─────────
    if (body.message) {
      try {
        await query(
          `INSERT INTO activities (lead_id, type, content, author, source) VALUES ($1, 'note', $2, $3, 'manual')`,
          [fullRow.id, String(body.message).slice(0, 4000), req.user?.email || 'CRM']
        );
      } catch (e) { console.warn('[leads] activity insert failed:', e.message); }
    }

    sendLeadNotification('lead_created', fullRow, [], req.user?.email, 'note', `Lead created: ${first_name} ${last_name}`);

    // Post-commit: enqueue Google Contacts sync (fire-and-forget, non-blocking)
    try {
      const contactsOutbox = require('../lib/googleContactsOutbox');
      await contactsOutbox.enqueueContactSync(pool, fullRow.id);
    } catch (e) { console.warn('[leads] contacts outbox enqueue failed (non-fatal):', e.message); }

    const appt = await fetchActiveAppointment(fullRow.id);
    res.status(201).json({ lead: serializeLead(fullRow, appt) });
  } catch (e) {
    console.error('[leads] create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin create path duplicate rule (unchanged): exact email (case-insensitive)
// or exact normalized phone already on a lead → 409 with the conflicting lead.
async function findCreateDuplicate(db, email, phone) {
  if (email) {
    const dup = await db.query('SELECT id, first_name, last_name FROM leads WHERE lower(email) = lower($1) LIMIT 1', [email]);
    if (dup.rows[0]) {
      const d = dup.rows[0];
      return { error: 'duplicate_email', message: `Email already belongs to another lead: ${d.first_name} ${d.last_name}`, conflict: { id: d.id, name: `${d.first_name} ${d.last_name}` } };
    }
  }
  if (phone) {
    const dup = await db.query('SELECT id, first_name, last_name FROM leads WHERE phone = $1 LIMIT 1', [phone]);
    if (dup.rows[0]) {
      const d = dup.rows[0];
      return { error: 'duplicate_phone', message: `Phone already belongs to another lead: ${d.first_name} ${d.last_name}`, conflict: { id: d.id, name: `${d.first_name} ${d.last_name}` } };
    }
  }
  return null;
}

// ── GET / — list leads (owner-scoped, filtered) ──────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });

    const { status, source, owner_email, search, sort = '-created_date', limit: limitStr } = req.query;
    const limit = Math.min(parseInt(limitStr || '2000', 10), 5000);

    const where = [];
    const params = [];
    let p = 1;

    if (scope.ownerFilter) {
      where.push(`l.owner_id = $${p}`); params.push(scope.ownerFilter); p++;
    }
    if (status && status !== 'all') {
      where.push(`l.status = $${p}`); params.push(status); p++;
    }
    if (source && source !== 'all') {
      where.push(`l.source = $${p}`); params.push(source); p++;
    }
    if (owner_email && owner_email !== 'all' && (req.user.role === 'admin' || req.user.role === 'manager')) {
      where.push(`lower(o.email) = lower($${p})`); params.push(owner_email); p++;
    }
    if (search) {
      where.push(`(l.first_name ILIKE $${p} OR l.last_name ILIKE $${p} OR l.email ILIKE $${p} OR l.property_address ILIKE $${p} OR l.phone ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Sort: map Base44-style sort keys to DB columns.
    let orderCol = 'l.created_at';
    let orderDir = 'DESC';
    if (sort === '-created_date') { orderCol = 'l.created_at'; orderDir = 'DESC'; }
    else if (sort === 'created_date') { orderCol = 'l.created_at'; orderDir = 'ASC'; }
    else if (sort === '-updated_date') { orderCol = 'l.updated_at'; orderDir = 'DESC'; }
    else if (sort === 'follow_up') { orderCol = 'l.follow_up_date'; orderDir = 'ASC NULLS LAST'; }
    else if (sort === '-follow_up') { orderCol = 'l.follow_up_date'; orderDir = 'DESC NULLS LAST'; }

    const sql = `
      SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
      FROM leads l
      LEFT JOIN owners o ON o.id = l.owner_id
      ${whereClause}
      ORDER BY ${orderCol} ${orderDir}
      LIMIT $${p}
    `;
    params.push(limit);

    const { rows } = await query(sql, params);
    const appts = await fetchActiveAppointmentsForLeads({ query }, rows.map(r => r.id));
    res.json({ items: rows.map(r => serializeLead(r, appts.get(String(r.id)) || null)), total: rows.length });
  } catch (e) {
    console.error('[leads] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /:id — update lead fields (owner-scoped) ────────────────────────────
// Supports ALL fields: CRM fields + contact fields (first_name, last_name, phone,
// email, property_address, city, state, zip). Contact fields are validated and
// duplicate-checked the same way as PUT /by-external/:externalRef.
//
// This endpoint is the CANONICAL update path for the frontend because it updates
// by Railway UUID — it NEVER creates duplicate leads (unlike PUT /by-external,
// which INSERTs with external_ref and can duplicate Railway-native leads).
const UPDATABLE_FIELDS = [
  'status', 'notes', 'follow_up_date', 'follow_up_time', 'follow_up_type',
  'meeting_stage', 'project_type', 'budget_range', 'start_timeframe', 'source',
  'referral_name', 'lead_score', 'is_new_intake_lead', 'customer_reminders_disabled',
  'record_type', 'reviewed_at', 'message', 'photo_urls',
];
// NOTE: owner_id is NOT in UPDATABLE_FIELDS — it is NOT NULL in the DB and must
// be handled explicitly (see the assigned_rep → owner_id mapping block below).
// Including it here would push `owner_id = NULL` on partial updates where the
// frontend sends owner_id: null, violating the NOT NULL constraint.

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    // Guard: :id must be a valid UUID — this route only accepts canonical
    // Railway UUIDs. Non-UUID identifiers (legacy external_refs) must use
    // the /by-external/:externalRef routes instead.
    if (!UUID_RE.test(String(id))) {
      return res.status(400).json({ error: 'invalid_id', message: 'PUT /:id requires a valid Railway UUID. Use /by-external/:externalRef for legacy identifiers.' });
    }
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    // Verify lead exists + caller has access — fetch FULL row for diff notification
    const leadR = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`,
      [id]
    );
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const oldLead = leadR.rows[0];

    const body = req.body || {};
    const updates = [];
    const params = [];
    let p = 1;

    // ── Canonical address pipeline (when address fields change) ──────
    const ADDRESS_COLS = ['property_address', 'city', 'state', 'zip'];
    const addressInBody = ADDRESS_COLS.some(f => body[f] !== undefined);
    let addrFields = null;
    if (addressInBody) {
      await ensureAddressColumns();
      const newStreet = body.property_address !== undefined ? String(body.property_address || '').trim() : (oldLead.property_address || '');
      const newCity = body.city !== undefined ? String(body.city || '').trim() : (oldLead.city || '');
      const newState = body.state !== undefined ? String(body.state || '').trim() : (oldLead.state || '');
      const newZip = body.zip !== undefined ? String(body.zip || '').trim() : (oldLead.zip || '');
      if (newStreet) {
        try {
          const addressResult = await processAddress({ street: newStreet, city: newCity, state: newState, zip: newZip });
          addrFields = buildAddressFieldMap(addressResult, oldLead);
        } catch (e) { console.warn('[leads] address pipeline (PUT /:id) failed (non-blocking):', e.message); }
      }
    }

    // ── Contact fields (with validation + duplicate checking) ──────────
    for (const col of CONTACT_FIELDS) {
      if (body[col] !== undefined) {
        let val;
        if (addrFields && addrFields[col] !== undefined) {
          val = addrFields[col];
        } else {
          val = typeof body[col] === 'string' ? body[col].trim() : body[col];
          if (val === '') val = null;
        }

        // Validate email format
        if (col === 'email' && val !== null && !isValidEmail(val)) {
          return res.status(400).json({ error: 'invalid_email', message: 'Invalid email format' });
        }
        // Normalize + validate phone
        if (col === 'phone' && val !== null && val !== '') {
          const normalized = normalizePhone(val);
          if (!normalized) {
            return res.status(400).json({ error: 'invalid_phone', message: 'Phone must be a valid US number (10 digits)' });
          }
          val = normalized;
        }

        // Duplicate check for email/phone against OTHER leads
        if ((col === 'email' || col === 'phone') && val) {
          const dup = await query(
            `SELECT id, first_name, last_name FROM leads WHERE ${col === 'email' ? 'lower(email)' : 'phone'} = $1 AND id != $2 LIMIT 1`,
            [val, id]
          );
          if (dup.rows[0]) {
            return res.status(409).json({
              error: col === 'email' ? 'duplicate_email' : 'duplicate_phone',
              message: `${col === 'email' ? 'Email' : 'Phone'} already belongs to another lead: ${dup.rows[0].first_name} ${dup.rows[0].last_name}`,
              conflict: { id: dup.rows[0].id, name: `${dup.rows[0].first_name} ${dup.rows[0].last_name}` },
            });
          }
        }

        params.push(val);
        updates.push(`${col} = $${p}`);
        p++;
      }
    }

    // ── Extra canonical address fields (verified, lat/lng, placeId, etc.) ──
    if (addrFields) {
      for (const col of ['verified_property_address', 'property_lat', 'property_lng',
                         'google_place_id', 'property_geocode_status',
                         'original_property_address', 'original_city']) {
        if (addrFields[col] !== undefined) {
          params.push(addrFields[col]);
          updates.push(`${col} = $${p}`);
          p++;
        }
      }
    }

    // ── CRM fields ──────────────────────────────────────────────────────
    for (const col of UPDATABLE_FIELDS) {
      if (body[col] !== undefined) {
        let val = body[col];
        // Handle boolean fields
        if (['is_new_intake_lead', 'customer_reminders_disabled'].includes(col)) {
          val = val === true || val === 'true';
        }
        // Handle photo_urls (array → JSONB)
        if (col === 'photo_urls' && Array.isArray(val)) {
          params.push(JSON.stringify(val));
        } else {
          params.push(val);
        }
        updates.push(`${col} = $${p}`);
        p++;
      }
    }

    // ── owner_id handling (NOT NULL column — must never be set to null/empty) ──
    // owner_id is NOT in UPDATABLE_FIELDS, so the loop above never touches it.
    // We handle it explicitly here:
    //   1. If body.owner_id is a non-null, non-empty value → use it directly.
    //   2. If body.assigned_rep is provided → look up owner by display name.
    //   3. Otherwise → don't include owner_id in the update (preserve existing).
    if (body.owner_id !== undefined && body.owner_id !== null && body.owner_id !== '') {
      params.push(body.owner_id);
      updates.push(`owner_id = $${p}`);
      p++;
    } else if (body.assigned_rep !== undefined) {
      // Frontend sends assigned_rep as display name — look up the owner.
      // If no match found, owner_id is simply not updated (preserves existing).
      const ownerR = await query('SELECT id FROM owners WHERE display_name = $1 AND is_active = true', [body.assigned_rep]);
      if (ownerR.rows[0]) {
        params.push(ownerR.rows[0].id);
        updates.push(`owner_id = $${p}`);
        p++;
      }
    }
    // If neither owner_id nor assigned_rep was provided, owner_id is preserved.

    if (updates.length === 0) {
      return res.status(400).json({ error: 'no fields to update' });
    }

    updates.push('updated_at = NOW()');

    const sql = `UPDATE leads SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`;
    params.push(id);

    // ── Atomic: lead update + reminder projection in ONE transaction ──────
    const client = await pool.connect();
    let fullRow;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(sql, params);
      const updated = rows[0];
      if (!updated) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not_found' }); }

      fullRow = (await client.query(
        `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
         FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`,
        [updated.id]
      )).rows[0];

      // Project the updated lead into reminder_leads (same transaction).
      await syncLeadToReminders(client, fullRow);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('[leads] put error:', e.message);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }

    // ── Post-commit: notify admins of the field changes (best-effort) ──────
    const changes = computeLeadDiff(oldLead, fullRow);
    if (changes.length > 0) {
      const isStatusChange = changes.some(c => c.label === 'Status');
      const isContactChange = changes.some(c =>
        ['First Name', 'Last Name', 'Phone', 'Email', 'Property Address', 'City'].includes(c.label));
      let action = 'lead_updated';
      if (isStatusChange && changes.length === 1) action = 'lead_status_changed';
      else if (isContactChange && changes.every(c =>
        ['First Name', 'Last Name', 'Phone', 'Email', 'Property Address', 'City'].includes(c.label))) {
        action = 'contact_info_changed';
      }
      sendLeadNotification(action, fullRow, changes, req.user?.email);
    }

    // Post-commit: re-enqueue Google Contacts sync when contact-relevant
    // fields changed (first/last name, phone, email, address) — a Lead
    // was previously only ever synced ONCE at creation; editing it after
    // that never re-triggered sync, so the Google Contact silently drifted
    // stale. Fire-and-forget, non-blocking, matching the creation call site.
    const contactChanged = changes.some(c =>
      ['First Name', 'Last Name', 'Phone', 'Email', 'Property Address', 'City'].includes(c.label));
    if (contactChanged) {
      try {
        const contactsOutbox = require('../lib/googleContactsOutbox');
        await contactsOutbox.enqueueContactSync(pool, fullRow.id);
      } catch (e) { console.warn('[leads] contacts outbox re-enqueue failed (non-fatal):', e.message); }
    }

    const appt = await fetchActiveAppointment(fullRow.id);
    res.json({ lead: serializeLead(fullRow, appt) });
  } catch (e) {
    console.error('[leads] put error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id — delete a lead (admin/manager or owner only) ───────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(String(id))) {
      return res.status(400).json({ error: 'invalid_id', message: 'DELETE /:id requires a valid Railway UUID. Use /by-external/:externalRef for legacy identifiers.' });
    }
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    // Verify lead exists + caller has access
    const leadR = await query('SELECT id, external_ref, owner_id FROM leads WHERE id = $1', [id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    // ── Atomic: lead delete + dependency cleanup in ONE transaction ────
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await removeFromReminders(client, leadR.rows[0]);
      await cancelAppointmentsForLeadDelete(client, id);
      await cleanupLeadTextRefs(client, id);
      await client.query('DELETE FROM leads WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('[leads] delete error:', e.message);
      return res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
    res.json({ success: true, id });
  } catch (e) {
    console.error('[leads] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — single lead (owner-scoped) ───────────────────────────────────
// Resolves by Railway UUID (id) OR external_ref (legacy Base44 ID).
// Uses safe identifier resolution (leadIdWhere) to avoid PostgreSQL uuid cast
// errors when the route param is a non-UUID legacy external_ref.
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });

    const { whereSql, params: idParams } = leadIdWhere(id, 'l.');
    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE ${whereSql}
       LIMIT 1`,
      idParams
    );
    const lead = rows[0];
    if (!lead) return res.status(404).json({ error: 'not_found' });

    // Owner-scope check for sales_rep
    if (scope.ownerFilter && String(lead.owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const appt = await fetchActiveAppointment(lead.id);
    res.json({ lead: serializeLead(lead, appt) });
  } catch (e) {
    console.error('[leads] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/activities — list activities for a lead ────────────────────────
// Resolves the lead by Railway UUID OR external_ref (safe identifier resolution),
// then queries activities by the canonical Railway UUID.
router.get('/:id/activities', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });

    // Resolve lead by external_ref OR Railway UUID (safe — no uuid cast error)
    const leadRow = await resolveLeadByIdentifier(id);
    if (!leadRow) return res.status(404).json({ error: 'lead_not_found' });
    if (scope.ownerFilter && String(leadRow.owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { rows } = await query(
      `SELECT * FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [leadRow.id]
    );
    res.json({ items: rows.map(serializeActivity) });
  } catch (e) {
    console.error('[leads] activities list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/activities — create an activity ──────────────────────────────
// Resolves the lead by Railway UUID OR external_ref (safe identifier resolution),
// then inserts the activity with the canonical Railway UUID as lead_id.
router.post('/:id/activities', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    // Resolve lead by external_ref OR Railway UUID (safe — no uuid cast error)
    const leadRow = await resolveLeadByIdentifier(id);
    if (!leadRow) return res.status(404).json({ error: 'lead_not_found' });
    if (scope.ownerFilter && String(leadRow.owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { type, content, author, source = 'manual', metadata } = req.body || {};
    if (!type || !content) return res.status(400).json({ error: 'type and content required' });

    const validTypes = ['note', 'call', 'email', 'meeting', 'task'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid activity type' });

    const ins = await query(
      `INSERT INTO activities (lead_id, type, content, author, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [leadRow.id, type, content, author || req.user.email || null, source, JSON.stringify(metadata || null)]
    );

    // ── Notify admins of the new activity (best-effort) ─────────────────
    sendLeadNotification('activity_added', leadRow, [], req.user?.email, type, content);

    res.status(201).json({ activity: serializeActivity(ins.rows[0]) });
  } catch (e) {
    console.error('[leads] activity create error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /by-external/:externalRef/sync-calendar ─────────────────────────────
// Enqueues a Google Calendar sync via the existing native calendarOutbox system.
// This preserves the required behavior: 1hr BEFORE + appointment duration + 1hr AFTER
// (travel/buffer event). Uses deterministic event IDs to prevent duplicates.
// The calendar outbox worker processes the enqueued actions asynchronously.
//
// No Base44. No direct googleCalendarClient calls. Uses the durable outbox pattern.
// Re-sync the lead's CANONICAL appointment to Google Calendar. This never
// moves or creates an appointment (the old version rescheduled the appointment
// to the follow-up date). It bumps the appointment version and re-enqueues
// create_main (+ create_travel for Meetings). Event ids are deterministic per
// appointment+slot, so a re-sync adopts/updates the existing Google event —
// never a duplicate.
router.post('/by-external/:externalRef/sync-calendar', requireAuth, async (req, res) => {
  try {
    const leadRow = await authorizeLeadWrite(req, res);
    if (!leadRow) return;
    const client = await pool.connect();
    let appointment;
    try {
      await client.query('BEGIN');
      const apptRes = await client.query(
        `SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed')
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [leadRow.id]
      );
      if (!apptRes.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'no_active_appointment', message: 'This lead has no appointment to sync. Set the appointment first.' });
      }
      const upd = await client.query(
        `UPDATE appointments SET version = version + 1, calendar_sync_status = 'pending',
                calendar_last_error = NULL, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [apptRes.rows[0].id]
      );
      appointment = upd.rows[0];
      const lead = (await client.query(LEAD_WITH_OWNER_SQL, [leadRow.id])).rows[0];
      const { isPhoneCallAppointment } = require('../lib/booking/appointmentKind');
      await calendarOutbox.enqueueCreate(client, appointment, lead, lead && lead.owner_email, isPhoneCallAppointment(appointment));
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
    res.json({
      success: true,
      appointment_id: appointment.id,
      appointment: serializeAppointment(appointment),
      message: 'Calendar sync re-queued for the current appointment.',
    });
  } catch (e) {
    console.error('[leads] sync-calendar error:', e.message);
    res.status(500).json({ error: 'sync_failed', message: e.message });
  }
});

// ── POST /by-external/:externalRef/sync-contact ─────────────────────────────
// Google Contacts sync via the service account with domain-wide delegation.
//
// Reuses the SAME service account as googleCalendarClient, but requests the
// contacts scope and impersonates the rep's Google Workspace account (sub).
// This does NOT create a new auth architecture — it extends the existing one.
//
// Required: Google Workspace Admin must add the contacts scope to the
// service account's domain-wide delegation. If not configured, returns 501.
router.post('/by-external/:externalRef/sync-contact', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    if (!lead.email && !lead.phone) {
      return res.status(400).json({ error: 'Lead has no email or phone to sync.' });
    }

    // Determine which Google account to impersonate (the rep's account).
    // Falls back to the admin account if no owner email.
    const subEmail = lead.owner_email || process.env.ADMIN_EMAIL || 'yaron@ecconstructiongroup.com';

    try {
      const result = await googleContactsClient.createOrUpdateContact(
        {
          first_name: lead.first_name,
          last_name: lead.last_name,
          email: lead.email,
          phone: lead.phone,
          property_address: lead.property_address,
          city: lead.city,
        },
        subEmail,
        lead.google_contact_resource_name // Pass stored resource_name to avoid redundant searchContacts reads (429 fix)
      );

      // Record sync status. Backward-compatible: if migration 2026-25 has not
      // yet been applied (columns don't exist), the UPDATE fails but the
      // Google contact was still created/updated — only the sync status
      // tracking is unavailable until the migration runs.
      try {
        await query(
          'UPDATE leads SET google_contact_sync_status = $1, google_contact_resource_name = $2, google_contact_sync_error = NULL, google_contact_synced_at = NOW(), updated_at = NOW() WHERE id = $3',
          ['synced', result.resourceName, lead.id]
        );
      } catch (updateErr) {
        console.warn('[leads] sync-contact: google_contact_* columns not yet migrated — sync status not recorded. Run migration 2026-25/2026-38. Contact was still synced:', updateErr.message);
      }

      return res.json({
        success: true,
        resource_name: result.resourceName,
        created: result.created,
        impersonated_account: subEmail,
      });
    } catch (e) {
      if (e.code === 'CONTACTS_SCOPE_NOT_CONFIGURED') {
        // Backward-compatible: same try/catch as the success path.
        try {
          await query(
            'UPDATE leads SET google_contact_sync_status = $1, google_contact_sync_error = $2, updated_at = NOW() WHERE id = $3',
            ['error', 'Contacts scope not configured on service account', lead.id]
          );
        } catch (updateErr) {
          console.warn('[leads] sync-contact: google_contact_* columns not yet migrated — error status not recorded:', updateErr.message);
        }
        return res.status(501).json({
          error: 'contacts_scope_not_configured',
          message: 'Google Contacts sync requires the contacts scope on the service account. Add the contacts scope to domain-wide delegation in Google Workspace Admin Console.',
          impersonated_account: subEmail,
        });
      }
      throw e;
    }
  } catch (e) {
    console.error('[leads] sync-contact error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── REMOVED: Base44 proxy endpoints ──────────────────────────────────────────
// The following Base44 proxy endpoints were REMOVED because they violated the
// architecture requirement (Frontend → Railway → Base44 is NOT acceptable).
//
// REMOVED endpoints:
//   POST /by-external/:externalRef/proxy-qb-status   (called base44Lib.invokeFunction)
//   POST /by-external/:externalRef/proxy-qb-sync      (called base44Lib.invokeFunction)
//   POST /by-external/:externalRef/proxy-signnow      (called base44Lib.invokeFunction)
//   GET  /by-external/:externalRef/submissions        (called base44Lib.filter)
//   GET  /by-external/:externalRef/signnow-documents  (called base44Lib.filter)
//   DELETE /by-external/:externalRef/signnow-documents/:docId (called base44Lib.remove)
//
// These must be replaced with NATIVE implementations:
//   - QB: native Railway endpoints reading from Postgres invoices/qb_invoices_cache
//     + calling Intuit QuickBooks API directly (qbTokenStore credentials)
//   - SignNow: native Railway endpoints calling SignNow API directly
//     (SIGNNOW_CLIENT_ID/SECRET) + signnow_documents table in Postgres
//   - Submissions: native lead_submissions table in Postgres
//
// Until native implementations are built, the frontend components
// (QBStatusPanel, SignNowPanel, SubmissionHistory) will show a
// "pending native migration" state.

module.exports = router;
// Shared with routes/websiteLeads.js (test-lead cleanup uses the same atomic
// delete sequence as DELETE /:id).
module.exports.cleanupLeadTextRefs = cleanupLeadTextRefs;
module.exports.cancelAppointmentsForLeadDelete = cancelAppointmentsForLeadDelete;
