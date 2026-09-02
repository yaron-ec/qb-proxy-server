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
const { query, pool } = require('../db/client');
const calendarOutbox = require('../lib/booking/calendarOutbox');
const googleContactsClient = require('../lib/googleContactsClient');
const { toUtcIso } = require('../lib/booking/slotBlocking');
const { syncLeadToReminders, removeFromReminders } = require('../lib/reminderProjection');
const router = express.Router();

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
  await client.query(`UPDATE qb_invoice_sale_map SET crm_lead_id = $1 WHERE crm_lead_id = $2`, ['', leadId]);
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
    meeting_stage: row.meeting_stage || null,
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
    google_calendar_sync_status: appointment?.calendar_sync_status || null,
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
    if (body.assigned_rep !== undefined && body.owner_id === undefined) {
      const ownerR = await query('SELECT id FROM owners WHERE display_name = $1 AND is_active = true', [body.assigned_rep]);
      if (ownerR.rows[0]) {
        allFields.owner_id = ownerR.rows[0].id;
      }
    }
    if (body.owner_id !== undefined) {
      allFields.owner_id = body.owner_id;
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
      client.release();
      console.error('[leads] put-by-external error:', e.message);
      return res.status(500).json({ error: e.message });
    }
    client.release();

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
      await cleanupLeadTextRefs(client, leadR.rows[0].id);
      await client.query('DELETE FROM leads WHERE id = $1', [leadR.rows[0].id]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
      console.error('[leads] delete-by-external error:', e.message);
      return res.status(500).json({ error: e.message });
    }
    client.release();
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
    // The settings table is a SINGLETON (id=1) with an app_lists JSONB column
    // that holds project_types, lead_sources, etc. It does NOT have key/value
    // columns — the old Base44-era key/value query caused "column key does not
    // exist" PostgreSQL errors on every Lead Detail load.
    const [apptRes, actRes, dealRes, ownerRes, settingsRes] = await Promise.all([
      query(`SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed')
             ORDER BY created_at DESC LIMIT 1`, [railwayLeadId]),
      query('SELECT * FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 500', [railwayLeadId]),
      query('SELECT * FROM deals WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100', [railwayLeadId]),
      query('SELECT id, display_name, email FROM owners WHERE is_active = true ORDER BY display_name ASC'),
      query(`SELECT app_lists FROM settings WHERE id = 1`),
    ]);

    const lead = serializeLead(leadRow, apptRes.rows[0]);

    // Extract project_types and lead_sources from the singleton app_lists JSONB
    const appLists = (settingsRes.rows[0] && settingsRes.rows[0].app_lists) || {};

    res.json({
      lead,
      activities: actRes.rows.map(serializeActivity),
      deals: dealRes.rows,
      contactOwners: ownerRes.rows.map(o => ({ id: o.id, display_name: o.display_name, email: o.email })),
      projectTypes: appLists.project_types || [],
      leadSources: appLists.lead_sources || [],
    });
  } catch (e) {
    console.error('[leads] get-detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /by-external/:externalRef/appointment — appointment edit/reschedule ──
// Updates ONLY appointment fields. Separate from contact update endpoint.
// No side effects (no calendar sync here — that's handled by the booking outbox).
const APPOINTMENT_FIELDS = ['appointment_date', 'appointment_time', 'meeting_stage', 'follow_up_date', 'follow_up_time', 'follow_up_type'];

// ── Shared appointment update logic ──────────────────────────────────────────
// Used by both PUT /:id/appointment (canonical Railway UUID) and
// PUT /by-external/:externalRef/appointment (legacy external_ref).
// Both routes resolve the canonical Railway UUID BEFORE calling this helper,
// so it always updates by WHERE id = $1 — no unsafe identifier comparisons,
// no external_ref required. The caller has already verified owner scope.
async function executeAppointmentUpdate(req, res, resolvedLeadId) {
  try {
    const body = req.body || {};
    const updates = [];
    const params = [];
    let p = 1;

    for (const col of APPOINTMENT_FIELDS) {
      if (body[col] !== undefined) {
        params.push(body[col]);
        updates.push(`${col} = $${p}`);
        p++;
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'no appointment fields to update' });
    updates.push('updated_at = NOW()');

    // ── Atomic: lead update + appointment mutation in ONE transaction ────────
    const client = await pool.connect();
    let updatedLead;
    try {
      await client.query('BEGIN');

      // 1. Update lead appointment fields by the canonical Railway UUID.
      const { rows } = await client.query(
        `UPDATE leads SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`,
        [...params, resolvedLeadId]
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not_found' });
      }
      updatedLead = rows[0];

      // 2. Create / update / cancel appointment (same transaction — atomic)
      const shouldHaveMeeting = updatedLead.follow_up_date && updatedLead.follow_up_type === 'Meeting';

      const apptRes = await client.query(
        `SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed') ORDER BY created_at DESC LIMIT 1`,
        [updatedLead.id]
      );
      const existingAppt = apptRes.rows[0];

      if (shouldHaveMeeting) {
        const apptDate = updatedLead.follow_up_date;
        const apptTime = updatedLead.follow_up_time || '09:00';
        const startAt = new Date(toUtcIso(apptDate, apptTime, 'America/Los_Angeles'));
        const durationMin = 60;
        const endAt = new Date(startAt.getTime() + durationMin * 60 * 1000);
        const busyStart = new Date(startAt.getTime() - 60 * 60 * 1000);
        const busyEnd = new Date(endAt.getTime() + 60 * 60 * 1000);

        if (existingAppt) {
          const newVersion = (existingAppt.version || 1) + 1;
          await client.query(
            `UPDATE appointments SET start_at = $1, end_at = $2, busy_range = tstzrange($3, $4, '[)'),
             version = $5, calendar_sync_status = 'pending', updated_at = NOW() WHERE id = $6`,
            [startAt.toISOString(), endAt.toISOString(), busyStart.toISOString(), busyEnd.toISOString(), newVersion, existingAppt.id]
          );
          const updatedAppt = (await client.query('SELECT * FROM appointments WHERE id = $1', [existingAppt.id])).rows[0];
          await calendarOutbox.enqueueUpdate(client, updatedAppt, updatedLead, updatedLead.owner_email, updatedAppt.version, true);
          await client.query(
            `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values)
             VALUES ($1, $2, 'rescheduled', $3, $4)`,
            [existingAppt.id, req.user?.email || null,
             JSON.stringify({ start_at: existingAppt.start_at, end_at: existingAppt.end_at }),
             JSON.stringify({ start_at: updatedAppt.start_at, end_at: updatedAppt.end_at })]
          );
        } else {
          const typeRes = await client.query('SELECT id FROM appointment_types ORDER BY id LIMIT 1');
          if (typeRes.rows[0]) {
            const typeId = typeRes.rows[0].id;
            const insRes = await client.query(
              `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status, calendar_sync_status)
               VALUES ($1, $2, $3, $4, $5, $6, tstzrange($7, $8, '[)'), 'scheduled', 'pending')
               RETURNING *`,
              [updatedLead.id, updatedLead.owner_id, typeId, startAt.toISOString(), endAt.toISOString(),
               'America/Los_Angeles', busyStart.toISOString(), busyEnd.toISOString()]
            );
            const newAppt = insRes.rows[0];
            await calendarOutbox.enqueueCreate(client, newAppt, updatedLead, updatedLead.owner_email);
            await client.query(
              `INSERT INTO appointment_events (appointment_id, actor, action, new_values)
               VALUES ($1, $2, 'created', $3)`,
              [newAppt.id, req.user?.email || null,
               JSON.stringify({ start_at: newAppt.start_at, end_at: newAppt.end_at, owner_id: newAppt.owner_id })]
            );
          }
        }
      } else {
        // Phone Call or no follow-up: cancel any existing Meeting appointment.
        // No new Google Calendar event, no calendar_outbox create/update.
        if (existingAppt) {
          const newVersion = (existingAppt.version || 1) + 1;
          await client.query(
            'UPDATE appointments SET status = $1, version = $2, updated_at = NOW() WHERE id = $3',
            ['cancelled', newVersion, existingAppt.id]
          );
          const cancelledAppt = (await client.query('SELECT * FROM appointments WHERE id = $1', [existingAppt.id])).rows[0];
          await calendarOutbox.enqueueCancel(client, cancelledAppt, cancelledAppt.version);
          await client.query(
            `INSERT INTO appointment_events (appointment_id, actor, action, previous_values)
             VALUES ($1, $2, 'cancelled', $3)`,
            [existingAppt.id, req.user?.email || null,
             JSON.stringify({ start_at: existingAppt.start_at, end_at: existingAppt.end_at, status: existingAppt.status })]
          );
        }
      }

      // ── Reminder projection (same transaction — atomic) ──────────────────
      const leadForProjection = (await client.query(
        `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
         FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
         WHERE l.id = $1`,
        [updatedLead.id]
      )).rows[0];
      await syncLeadToReminders(client, leadForProjection);

      await client.query('COMMIT');
    } catch (calErr) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();

      if (calErr.code === '23P01') {
        return res.status(409).json({
          error: 'slot_conflict',
          message: 'This time conflicts with another appointment. Please choose a different time.',
        });
      }

      console.error('[leads] appointment update error:', calErr.message);
      return res.status(500).json({ error: calErr.message });
    }
    client.release();

    // Return with owner join
    const fullRow = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`,
      [updatedLead.id]
    );
    const leadWithOwner = fullRow.rows[0];

    const updatedAppt = await fetchActiveAppointment(leadWithOwner.id);
    res.json({ lead: serializeLead(leadWithOwner, updatedAppt) });
  } catch (e) {
    console.error('[leads] appointment update error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── PUT /:id/appointment — CANONICAL appointment update by Railway UUID ──────
// This is the primary appointment update route for Railway-native leads.
// Accepts ONLY valid Railway UUIDs — no external_ref, no leadIdWhere, no
// unsafe identifier comparisons. The frontend FollowUpScheduler calls this
// with lead.railway_id (the canonical Railway UUID).
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

    return executeAppointmentUpdate(req, res, leadR.rows[0].id);
  } catch (e) {
    console.error('[leads] appointment update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /by-external/:externalRef/appointment — legacy appointment update ─────
// Resolves the lead by external_ref OR Railway UUID via the shared safe
// resolver, then delegates to executeAppointmentUpdate with the canonical
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

    return executeAppointmentUpdate(req, res, leadRow.id);
  } catch (e) {
    console.error('[leads] appointment update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
    res.json({ items: rows.map(serializeLead), total: rows.length });
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
  'status', 'notes', 'owner_id', 'follow_up_date', 'follow_up_time', 'follow_up_type',
  'meeting_stage', 'project_type', 'budget_range', 'start_timeframe', 'source',
  'referral_name', 'lead_score', 'is_new_intake_lead', 'customer_reminders_disabled',
  'record_type', 'reviewed_at', 'message', 'photo_urls',
];

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

    // Verify lead exists + caller has access
    const leadR = await query('SELECT id, owner_id FROM leads WHERE id = $1', [id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const body = req.body || {};
    const updates = [];
    const params = [];
    let p = 1;

    // ── Contact fields (with validation + duplicate checking) ──────────
    for (const col of CONTACT_FIELDS) {
      if (body[col] !== undefined) {
        let val = typeof body[col] === 'string' ? body[col].trim() : body[col];
        if (val === '') val = null;

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

    // Also handle assigned_rep → owner_id mapping (frontend sends assigned_rep as display name)
    if (body.assigned_rep !== undefined && !body.owner_id) {
      // Look up owner by display name
      const ownerR = await query('SELECT id FROM owners WHERE display_name = $1 AND is_active = true', [body.assigned_rep]);
      if (ownerR.rows[0]) {
        params.push(ownerR.rows[0].id);
        updates.push(`owner_id = $${p}`);
        p++;
      }
    }

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
      client.release();
      console.error('[leads] put error:', e.message);
      return res.status(500).json({ error: e.message });
    }
    client.release();

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
      await cleanupLeadTextRefs(client, id);
      await client.query('DELETE FROM leads WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
      console.error('[leads] delete error:', e.message);
      return res.status(500).json({ error: e.message });
    }
    client.release();
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
router.post('/by-external/:externalRef/sync-calendar', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const lead = await resolveLeadByIdentifier(externalRef);
    if (!lead) return res.status(404).json({ error: 'not_found' });
    const apptDate = lead.follow_up_date || lead.appointment_date;
    const apptTime = lead.follow_up_time || lead.appointment_time || '09:00';
    if (!apptDate) return res.status(400).json({ error: 'No appointment date set for this lead.' });

    // Use the existing native calendar outbox system — enqueues main + travel events
    // with 1hr buffer before/after. The worker processes them with retry + dead-letter.
    const { pool } = require('../db/client');
    const calendarOutbox = require('../lib/booking/calendarOutbox');

    // Build start/end times (LA timezone)
    const startAt = new Date(toUtcIso(apptDate, apptTime, 'America/Los_Angeles'));
    const durationMin = 60; // default 1 hour meeting
    const endAt = new Date(startAt.getTime() + durationMin * 60 * 1000);
    const busyStart = new Date(startAt.getTime() - 60 * 60 * 1000); // 1hr before
    const busyEnd = new Date(endAt.getTime() + 60 * 60 * 1000);    // 1hr after

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Find existing active appointment for this lead
      const apptRes = await client.query(
        `SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed') ORDER BY created_at DESC LIMIT 1`,
        [lead.id]
      );

      let appointment;

      if (apptRes.rows[0]) {
        // Reschedule: update existing appointment's time
        appointment = apptRes.rows[0];
        const newVersion = (appointment.version || 1) + 1;
        await client.query(
          `UPDATE appointments SET start_at = $1, end_at = $2, busy_range = tstzrange($3, $4, '[)'),
           version = $5, calendar_sync_status = 'pending', updated_at = NOW() WHERE id = $6`,
          [startAt.toISOString(), endAt.toISOString(), busyStart.toISOString(), busyEnd.toISOString(), newVersion, appointment.id]
        );
        appointment = (await client.query('SELECT * FROM appointments WHERE id = $1', [appointment.id])).rows[0];

        // Enqueue calendar outbox update (main + travel since duration may have changed)
        await calendarOutbox.enqueueUpdate(client, appointment, lead, lead.owner_email, appointment.version, true);
      } else {
        // Create new appointment
        const typeRes = await client.query('SELECT id FROM appointment_types ORDER BY id LIMIT 1');
        if (!typeRes.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'No appointment types configured. Please create an appointment type first.' });
        }
        const typeId = typeRes.rows[0].id;

        const insRes = await client.query(
          `INSERT INTO appointments (lead_id, owner_id, appointment_type_id, start_at, end_at, timezone, busy_range, status, calendar_sync_status)
           VALUES ($1, $2, $3, $4, $5, $6, tstzrange($7, $8, '[)'), 'scheduled', 'pending')
           RETURNING *`,
          [lead.id, lead.owner_id, typeId, startAt.toISOString(), endAt.toISOString(), 'America/Los_Angeles', busyStart.toISOString(), busyEnd.toISOString()]
        );
        appointment = insRes.rows[0];

        // Enqueue calendar outbox create (main + travel events)
        await calendarOutbox.enqueueCreate(client, appointment, lead, lead.owner_email);
      }

      await client.query('COMMIT');

      // ── Reminder projection (post-commit, best-effort) ────────────────
      // sync-calendar can change appointment times. Project the new times into
      // reminder_leads so the engine uses the correct schedule. Best-effort
      // (non-blocking) because the calendar outbox is already enqueued — a
      // reminder projection failure here is logged and retried by the backfill.
      try {
        const leadForProjection = (await query(
          `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
           FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
           WHERE l.id = $1`,
          [lead.id]
        )).rows[0];
        if (leadForProjection) {
          await syncLeadToReminders({ query }, leadForProjection);
        }
      } catch (projErr) {
        console.error('[leads] sync-calendar reminder projection error (non-blocking):', projErr.message);
      }

      // NOTE: The appointment's calendar_sync_status is already set to 'pending'
      // inside the transaction above (INSERT/UPDATE appointments). The outbox
      // worker updates it to 'synced'/'failed' after calling Google. We do NOT
      // update leads.google_calendar_sync_status — that column does NOT exist
      // in the Railway schema (it's a Base44-era field). The canonical state
      // lives in appointments.calendar_sync_status.

      res.json({
        success: true,
        appointment_id: appointment.id,
        message: 'Calendar sync enqueued via native outbox. Main + travel events (1hr buffer) will be created by the worker.'
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[leads] sync-calendar error:', e.message);
    res.status(500).json({ error: e.message });
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
          'UPDATE leads SET google_contact_sync_status = $1, google_contact_resource_name = $2, google_contact_sync_error = NULL, updated_at = NOW() WHERE id = $3',
          ['synced', result.resourceName, lead.id]
        );
      } catch (updateErr) {
        console.warn('[leads] sync-contact: google_contact_* columns not yet migrated — sync status not recorded. Run migration 2026-25. Contact was still synced:', updateErr.message);
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