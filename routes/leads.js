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
const router = express.Router();

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
function serializeLead(row) {
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

// ── GET /by-external/:externalRef — get lead by external_ref (Base44 ID) ──────
router.get('/by-external/:externalRef', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.external_ref = $1`,
      [externalRef]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ lead: serializeLead(rows[0]) });
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
    let insertFirstName = cleaned.first_name;
    let insertLastName = cleaned.last_name;

    if (!insertFirstName || !insertLastName) {
      const existing = await query('SELECT first_name, last_name FROM leads WHERE external_ref = $1', [externalRef]);
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

    // Build INSERT columns + params
    const insertCols = ['external_ref', 'first_name', 'last_name'];
    const params = [externalRef, insertFirstName, insertLastName];

    for (const col of Object.keys(allFields)) {
      insertCols.push(col);
      params.push(allFields[col]);
    }

    // SET clause: re-use the same values via EXCLUDED
    const setParts = Object.keys(allFields).map(col => `${col} = EXCLUDED.${col}`);
    setParts.push('updated_at = NOW()');

    const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `
      INSERT INTO leads (${insertCols.join(', ')})
      VALUES (${insertPlaceholders})
      ON CONFLICT (external_ref) DO UPDATE SET ${setParts.join(', ')}
      RETURNING *
    `;

    const { rows } = await query(sql, params);
    const updated = rows[0];
    if (!updated) return res.status(500).json({ error: 'upsert failed' });

    // Return with owner join for consistent serialization
    const fullRow = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`,
      [updated.id]
    );

    res.json({ lead: serializeLead(fullRow.rows[0]) });
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

    const leadR = await query('SELECT id, owner_id FROM leads WHERE external_ref = $1', [externalRef]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    await query('DELETE FROM leads WHERE id = $1', [leadR.rows[0].id]);
    res.json({ success: true, external_ref: externalRef });
  } catch (e) {
    console.error('[leads] delete-by-external error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /by-external/:externalRef/detail — composite lead detail ──────────────
// Returns lead + activities + deals + contactOwners + projectTypes + leadSources
// in a single call, replacing the Base44 getLeadDetail function.
router.get('/by-external/:externalRef/detail', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.external_ref = $1`,
      [externalRef]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    const lead = serializeLead(rows[0]);
    const railwayLeadId = rows[0].id;

    // Parallel fetch: activities, deals, owners, settings
    const [actRes, dealRes, ownerRes, settingsRes] = await Promise.all([
      query('SELECT * FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 500', [railwayLeadId]),
      query('SELECT * FROM deals WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 100', [railwayLeadId]),
      query('SELECT id, display_name, email FROM owners WHERE is_active = true ORDER BY display_name ASC'),
      query(`SELECT key, value FROM settings WHERE key IN ('project_types', 'lead_sources')`),
    ]);

    const settings = {};
    for (const r of settingsRes.rows) {
      settings[r.key] = r.value;
    }

    res.json({
      lead,
      activities: actRes.rows.map(serializeActivity),
      deals: dealRes.rows,
      contactOwners: ownerRes.rows.map(o => ({ id: o.id, display_name: o.display_name, email: o.email })),
      projectTypes: settings.project_types || [],
      leadSources: settings.lead_sources || [],
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

router.put('/by-external/:externalRef/appointment', requireAuth, async (req, res) => {
  try {
    const { externalRef } = req.params;
    if (!externalRef) return res.status(400).json({ error: 'external_ref required' });

    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

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

    params.push(externalRef);
    const { rows } = await query(
      `UPDATE leads SET ${updates.join(', ')} WHERE external_ref = $${p} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    const updatedLead = rows[0];

    // ── Calendar side effects (native Railway, no Base44) ──────────────────
    // When follow_up fields change, sync the appointment + Google Calendar.
    // Contact-only edits (PUT /by-external/:ref) NEVER touch this path.
    const shouldHaveMeeting = updatedLead.follow_up_date && updatedLead.follow_up_type === 'Meeting';

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Find existing active appointment for this lead
        const apptRes = await client.query(
          `SELECT * FROM appointments WHERE lead_id = $1 AND status IN ('scheduled', 'confirmed') ORDER BY created_at DESC LIMIT 1`,
          [updatedLead.id]
        );
        const existingAppt = apptRes.rows[0];

        if (shouldHaveMeeting) {
          // Need a meeting — create or update the appointment
          const apptDate = updatedLead.follow_up_date;
          const apptTime = updatedLead.follow_up_time || '09:00';
          const [sh, sm] = apptTime.split(':').map(Number);
          const startAt = new Date(`${apptDate}T${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}:00`);
          const durationMin = 60;
          const endAt = new Date(startAt.getTime() + durationMin * 60 * 1000);
          const busyStart = new Date(startAt.getTime() - 60 * 60 * 1000);
          const busyEnd = new Date(endAt.getTime() + 60 * 60 * 1000);

          if (existingAppt) {
            // Update existing appointment
            const newVersion = (existingAppt.version || 1) + 1;
            await client.query(
              `UPDATE appointments SET start_at = $1, end_at = $2, busy_range = tstzrange($3, $4, '[)'),
               version = $5, calendar_sync_status = 'pending', updated_at = NOW() WHERE id = $6`,
              [startAt.toISOString(), endAt.toISOString(), busyStart.toISOString(), busyEnd.toISOString(), newVersion, existingAppt.id]
            );
            const updatedAppt = (await client.query('SELECT * FROM appointments WHERE id = $1', [existingAppt.id])).rows[0];
            await calendarOutbox.enqueueUpdate(client, updatedAppt, updatedLead, updatedLead.owner_email, updatedAppt.version, true);
          } else {
            // Create new appointment
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
            }
          }
        } else {
          // No meeting needed — cancel any existing active appointment
          if (existingAppt) {
            const newVersion = (existingAppt.version || 1) + 1;
            await client.query(
              'UPDATE appointments SET status = $1, version = $2, updated_at = NOW() WHERE id = $3',
              ['cancelled', newVersion, existingAppt.id]
            );
            const cancelledAppt = (await client.query('SELECT * FROM appointments WHERE id = $1', [existingAppt.id])).rows[0];
            await calendarOutbox.enqueueCancel(client, cancelledAppt, cancelledAppt.version);
          }
        }

        await client.query('COMMIT');
      } catch (calErr) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[leads] calendar sync error (non-blocking):', calErr.message);
        // Calendar sync failure is non-blocking — the leads table update already succeeded.
      } finally {
        client.release();
      }
    } catch (poolErr) {
      console.error('[leads] pool error (non-blocking):', poolErr.message);
    }

    // Return with owner join
    const fullRow = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`,
      [updatedLead.id]
    );
    res.json({ lead: serializeLead(fullRow.rows[0]) });
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
// Supports all CRM fields: status, notes, owner_id, follow_up_*, meeting_stage,
// project_type, budget_range, start_timeframe, source, referral_name, lead_score,
// is_new_intake_lead, customer_reminders_disabled, record_type, reviewed_at, message, photo_urls.
// Contact fields (first_name, last_name, phone, email, property_address, city, state, zip)
// are handled by PUT /by-external/:externalRef with duplicate checking.
const UPDATABLE_FIELDS = [
  'status', 'notes', 'owner_id', 'follow_up_date', 'follow_up_time', 'follow_up_type',
  'meeting_stage', 'project_type', 'budget_range', 'start_timeframe', 'source',
  'referral_name', 'lead_score', 'is_new_intake_lead', 'customer_reminders_disabled',
  'record_type', 'reviewed_at', 'message', 'photo_urls',
];

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    // Verify lead exists + caller has access
    const leadR = await query('SELECT owner_id FROM leads WHERE id = $1', [id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const body = req.body || {};
    const updates = [];
    const params = [];
    let p = 1;

    for (const col of UPDATABLE_FIELDS) {
      if (body[col] !== undefined) {
        // Convert camelCase from frontend to snake_case if needed
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

    const { rows } = await query(sql, params);
    const updated = rows[0];
    if (!updated) return res.status(404).json({ error: 'not_found' });

    // Return with owner join
    const fullRow = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`,
      [updated.id]
    );
    res.json({ lead: serializeLead(fullRow.rows[0]) });
  } catch (e) {
    console.error('[leads] put error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /:id — delete a lead (admin/manager or owner only) ───────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    // Verify lead exists + caller has access
    const leadR = await query('SELECT owner_id FROM leads WHERE id = $1', [id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    await query('DELETE FROM leads WHERE id = $1', [id]);
    res.json({ success: true, id });
  } catch (e) {
    console.error('[leads] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id — single lead (owner-scoped) ───────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });

    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`,
      [id]
    );
    const lead = rows[0];
    if (!lead) return res.status(404).json({ error: 'not_found' });

    // Owner-scope check for sales_rep
    if (scope.ownerFilter && String(lead.owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    res.json({ lead: serializeLead(lead) });
  } catch (e) {
    console.error('[leads] get error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/activities — list activities for a lead ────────────────────────
router.get('/:id/activities', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });

    // Verify lead exists + caller has access
    const leadR = await query('SELECT owner_id FROM leads WHERE id = $1', [id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'lead_not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { rows } = await query(
      `SELECT * FROM activities WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 500`,
      [id]
    );
    res.json({ items: rows.map(serializeActivity) });
  } catch (e) {
    console.error('[leads] activities list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:id/activities — create an activity ──────────────────────────────
router.post('/:id/activities', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const scope = await resolveOwnerScope(req.user);
    if (scope.denied) return res.status(403).json({ error: 'forbidden' });
    if (scope.readOnly) return res.status(403).json({ error: 'forbidden', message: 'office role is read-only' });

    // Verify lead exists + caller has access
    const leadR = await query('SELECT owner_id FROM leads WHERE id = $1', [id]);
    if (!leadR.rows[0]) return res.status(404).json({ error: 'lead_not_found' });
    if (scope.ownerFilter && String(leadR.rows[0].owner_id) !== String(scope.ownerFilter)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { type, content, author, source = 'manual', metadata } = req.body || {};
    if (!type || !content) return res.status(400).json({ error: 'type and content required' });

    const validTypes = ['note', 'call', 'email', 'meeting', 'task'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid activity type' });

    const ins = await query(
      `INSERT INTO activities (lead_id, type, content, author, source, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, type, content, author || req.user.email || null, source, JSON.stringify(metadata || null)]
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
    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.external_ref = $1`, [externalRef]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    const lead = rows[0];
    const apptDate = lead.follow_up_date || lead.appointment_date;
    const apptTime = lead.follow_up_time || lead.appointment_time || '09:00';
    if (!apptDate) return res.status(400).json({ error: 'No appointment date set for this lead.' });

    // Use the existing native calendar outbox system — enqueues main + travel events
    // with 1hr buffer before/after. The worker processes them with retry + dead-letter.
    const { pool } = require('../db/client');
    const calendarOutbox = require('../lib/booking/calendarOutbox');

    // Build start/end times (LA timezone)
    const [sh, sm] = apptTime.split(':').map(Number);
    const startAt = new Date(`${apptDate}T${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}:00`);
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

      // Update lead sync status (pending = outbox worker will process)
      await query(
        'UPDATE leads SET google_calendar_sync_status = $1, last_google_sync = NOW(), updated_at = NOW() WHERE id = $2',
        ['pending', lead.id]
      );

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
    const { rows } = await query(
      `SELECT l.id, l.first_name, l.last_name, l.email, l.phone, l.property_address, l.city,
              o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.external_ref = $1`,
      [externalRef]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });

    const lead = rows[0];
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
        subEmail
      );

      await query(
        'UPDATE leads SET google_contact_sync_status = $1, google_contact_resource_name = $2, google_contact_sync_error = NULL, updated_at = NOW() WHERE id = $3',
        ['synced', result.resourceName, lead.id]
      );

      return res.json({
        success: true,
        resource_name: result.resourceName,
        created: result.created,
        impersonated_account: subEmail,
      });
    } catch (e) {
      if (e.code === 'CONTACTS_SCOPE_NOT_CONFIGURED') {
        await query(
          'UPDATE leads SET google_contact_sync_status = $1, google_contact_sync_error = $2, updated_at = NOW() WHERE id = $3',
          ['error', 'Contacts scope not configured on service account', lead.id]
        );
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