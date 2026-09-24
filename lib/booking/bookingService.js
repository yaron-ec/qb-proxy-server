/* eslint-disable no-undef */
/**
 * bookingService — Phase 1 core booking engine.
 *
 * createBooking: one PostgreSQL transaction that
 *   1. checks idempotency (same key+request → return original; same key+diff → 409)
 *   2. resolves the canonical owner (UUID; email is a convenience key)
 *   3. resolves the canonical Lead via the Lead Resolution Policy
 *   4. resolves duration (override ?? type default)
 *   5. takes the owner-schedule advisory lock + checks busy_range overlap
 *      (lib/booking/appointmentWriter — replaces the EXCLUDE constraint that
 *      migration 2026-33 dropped), then inserts the appointment
 *   6. writes the immutable audit 'created' event
 *   7. records the idempotency key
 *   Any DB step fails → full ROLLBACK.
 *   start_at is OPTIONAL: without it only the Lead is created (New Lead with a
 *   follow-up only, or with neither). The appointment never writes the lead's
 *   follow_up_* fields — those are the independent Follow-Up (input.follow_up).
 *
 * createAppointmentForLead / cancelAppointment / rescheduleAppointment /
 * updateAppointment: the canonical mutations of an existing lead's appointment.
 * Each accepts an optional onWrite(client, appointmentRow|null) hook that runs
 * INSIDE the transaction before COMMIT (used for the reminder projection).
 *
 * cancelAppointment / rescheduleAppointment: status changes only (no hard delete).
 * Cancelled/rescheduled rows are excluded from the active EXCLUDE constraint
 * via its partial predicate, so they immediately free the slot.
 *
 * Google + Base44 projection outboxes are NOT touched in Phase 1.
 */
'use strict';

const crypto = require('crypto');
const { pool, ensureSchema } = require('../../db/client');
const { resolveLead } = require('./leadResolution');
const { getType, resolveDuration, validateDurationOverride } = require('./appointmentTypes');
const calendarOutbox = require('./calendarOutbox');
const { processAddress, ensureAddressColumns, buildAddressFieldMap } = require('../addressPipeline');
const { acquireOwnerLockAndCheckConflict } = require('./appointmentWriter');
const { isPhoneCallAppointment } = require('./appointmentKind');
const { normalizeFollowUp } = require('../followUp');

class BookingError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let _ready;
function ready() {
  if (!_ready) _ready = ensureSchema();
  return _ready;
}

function hashRequest(input) {
  const canon = {
    owner_id: input.owner_id || null,
    owner_email: input.owner_email ? String(input.owner_email).toLowerCase() : null,
    lead_id: input.lead_id || null,
    external_ref: input.external_ref || null,
    first_name: input.first_name || null,
    last_name: input.last_name || null,
    email: input.email || null,
    phone: input.phone || null,
    property_address: input.property_address || null,
    appointment_type_id: input.appointment_type_id || null,
    start_at: input.start_at || null,
    duration_override_minutes: input.duration_override_minutes != null ? Number(input.duration_override_minutes) : null,
    force_new_lead: !!input.force_new_lead,
    override_conflict: !!input.override_conflict,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// Owner resolution scoped to the transaction client (creation rolls back on failure).
async function resolveOwnerClient(client, input) {
  if (input.owner_id) {
    const r = await client.query('SELECT * FROM owners WHERE id = $1', [input.owner_id]);
    if (r.rows[0]) return r.rows[0];
  }
  if (input.owner_email) {
    const email = String(input.owner_email).trim().toLowerCase();
    const r = await client.query('SELECT * FROM owners WHERE lower(email) = lower($1)', [email]);
    if (r.rows[0]) return r.rows[0];
    const ins = await client.query(
      'INSERT INTO owners (email, display_name) VALUES ($1, $2) RETURNING *',
      [email, input.owner_display_name || null]
    );
    return ins.rows[0];
  }
  throw new BookingError(400, 'owner_required', 'owner_id or owner_email is required');
}

// Busy window for an appointment: Meetings reserve 1h travel before and after,
// Phone Calls reserve only the call itself.
function busyWindow(start, end, skipTravel) {
  return {
    busyStart: skipTravel ? start : new Date(start.getTime() - 60 * 60 * 1000),
    busyEnd: skipTravel ? end : new Date(end.getTime() + 60 * 60 * 1000),
  };
}

// Owner-schedule lock + overlap check (same tx as the write). An authorized
// admin override books anyway; the overlap is recorded on the new row.
async function assertSlotFree(client, ownerId, busyStart, busyEnd, excludeId, overrideConflict) {
  try {
    return await acquireOwnerLockAndCheckConflict(client, ownerId, busyStart, busyEnd, excludeId, !!overrideConflict);
  } catch (e) {
    if (e && e.code === 'SLOT_CONFLICT') {
      await client.query('ROLLBACK');
      throw new BookingError(409, 'slot_conflict', 'the requested slot conflicts with an existing active appointment',
        { conflicts: (e.conflicts || []).map(c => c.id) });
    }
    throw e;
  }
}

async function recordOverride(client, apptId, overrideConflict, overrideActor, conflicts) {
  if (!overrideConflict || !conflicts || !conflicts.length) return;
  await client.query(
    `UPDATE appointments SET override_authorized = true, override_authorized_by = $1,
            override_authorized_at = NOW() WHERE id = $2`,
    [overrideActor || null, apptId]
  );
}

async function createBooking(input) {
  await ready();
  const {
    idempotency_key, start_at, appointment_type_id,
    duration_override_minutes, timezone, actor,
    override_conflict, override_actor,
    skip_travel,
  } = input;

  if (!idempotency_key) throw new BookingError(400, 'idempotency_key_required', 'idempotency_key is required');
  const withAppointment = !!start_at;
  if (withAppointment && !appointment_type_id) throw new BookingError(400, 'appointment_type_id_required', 'appointment_type_id is required');
  validateDurationOverride(duration_override_minutes);
  let followUp = null;
  if (input.follow_up) {
    const fu = normalizeFollowUp(input.follow_up);
    if (!fu.ok) throw new BookingError(400, 'invalid_follow_up', fu.errors.join('; '), { errors: fu.errors });
    followUp = fu.value;
  }

  const reqHash = hashRequest(input);

  // ── Canonical address pipeline (BEFORE the DB transaction) ──────────────
  // Run the address through the canonical pipeline BEFORE opening a DB
  // transaction so the pool connection is not held across slow Google Maps
  // geocoding I/O. The result (addrFields) is used inside the transaction
  // for the INSERT. This is non-blocking (try/catch) — failures fall back
  // to the raw input values, same as before.
  await ensureAddressColumns();
  let addrFields = null;
  if (input.property_address) {
    try {
      const addressResult = await processAddress({
        street: input.property_address,
        city: input.city,
        state: input.state || '',
        zip: input.zip || '',
      });
      addrFields = buildAddressFieldMap(addressResult, null);
    } catch (e) { console.warn('[booking] address pipeline failed (non-blocking):', e.message); }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. idempotency check (lead-only creates have no appointment row, so they
    //    are de-duplicated by the Lead Resolution Policy instead)
    const idem = !withAppointment ? { rows: [] } : await client.query('SELECT * FROM booking_idempotency WHERE idempotency_key = $1', [idempotency_key]);
    if (idem.rows[0]) {
      if (idem.rows[0].request_hash !== reqHash) {
        await client.query('ROLLBACK');
        throw new BookingError(409, 'idempotency_conflict', 'same idempotency_key with a materially different request');
      }
      const appt = await client.query('SELECT * FROM appointments WHERE id = $1', [idem.rows[0].appointment_id]);
      const lead = await client.query('SELECT * FROM leads WHERE id = $1', [idem.rows[0].lead_id]);
      await client.query('COMMIT');
      return { idempotent: true, lead: lead.rows[0], appointment: appt.rows[0] };
    }

    // 2. resolve owner
    const owner = await resolveOwnerClient(client, input);

    // 3. resolve lead
    const res = await resolveLead(client, { ...input, owner_id: owner.id });
    let leadId;
    if (res.action === 'duplicate') {
      await client.query('ROLLBACK');
      throw new BookingError(409, 'potential_duplicate', 'potential duplicate leads found; review before creating', { candidates: res.candidates });
    }
    if (res.action === 'reuse') {
      leadId = res.leadId;
      if (!withAppointment) {
        // Lead-only submit that matched an existing lead (e.g. a retried
        // submit): return it unchanged — never duplicate, never overwrite.
        await client.query('COMMIT');
        const lead = await client.query('SELECT * FROM leads WHERE id = $1', [leadId]);
        return { idempotent: true, lead: lead.rows[0], appointment: null };
      }
    } else {
      // ── Canonical address pipeline (BEFORE the INSERT) ───────────────
      // Run the address through the canonical pipeline so the lead is
      // created with verified Street/City/State/ZIP + lat/lng from the start.
      // addrFields pre-computed before the transaction (above pool.connect)
      // Initial status: a lead born WITH its first appointment starts as
      // "Appointment Scheduled" / "First Meeting"; a lead born without one
      // starts as "New". The appointment is NEVER mirrored into follow_up_*:
      // follow_up_* is the independent Follow-Up (input.follow_up) only.
      // A reused lead (branch above) never has its status/stage touched.
      const ins = await client.query(
        `INSERT INTO leads
           (external_ref, first_name, last_name, email, phone, property_address, city, state, zip,
            project_type, budget_range, start_timeframe, source, referral_name, owner_id, status, notes,
            origin_system,
            verified_property_address, property_lat, property_lng, google_place_id,
            property_geocode_status, original_property_address, original_city,
            meeting_stage, follow_up_type, follow_up_date, follow_up_time,
            follow_up_notes, follow_up_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$24,$16,'railway',
                 $17,$18,$19,$20,$21,$22,$23,$25,$26,$27,$28,$29,$30)
         RETURNING *`,
        [
          input.external_ref || null, input.first_name, input.last_name,
          input.email || null, input.phone || null,
          addrFields?.property_address || input.property_address || null,
          addrFields?.city || input.city || null,
          addrFields?.state || input.state || null,
          addrFields?.zip || input.zip || null,
          input.project_type || null,
          input.budget_range || null, input.start_timeframe || null, input.source || null,
          input.referral_name || null, owner.id, input.notes || null,
          addrFields?.verified_property_address || null,
          addrFields?.property_lat || null,
          addrFields?.property_lng || null,
          addrFields?.google_place_id || null,
          addrFields?.property_geocode_status || 'pending',
          addrFields?.original_property_address || null,
          addrFields?.original_city || null,
          withAppointment ? 'Appointment Scheduled' : 'New',
          withAppointment ? 'First Meeting' : null,
          followUp ? followUp.follow_up_type : null,
          followUp ? followUp.follow_up_date : null,
          followUp ? followUp.follow_up_time : null,
          followUp ? followUp.follow_up_notes : null,
          followUp ? followUp.follow_up_status : null,
        ]
      );
      leadId = ins.rows[0].id;
    }

    if (!withAppointment) {
      if (typeof input.onWrite === 'function') await input.onWrite(client, null, leadId);
      await client.query('COMMIT');
      const lead = await client.query('SELECT * FROM leads WHERE id = $1', [leadId]);
      return { idempotent: false, lead: lead.rows[0], appointment: null };
    }

    // 4. duration
    const type = await getType(appointment_type_id);
    if (!type) {
      await client.query('ROLLBACK');
      throw new BookingError(400, 'invalid_appointment_type', 'appointment_type_id not found');
    }
    const duration = resolveDuration(type, duration_override_minutes);

    // 5. insert appointment (EXCLUDE enforces active overlap)
    const start = new Date(start_at);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    // Phone Calls (skip_travel=true): no travel buffer. Meetings: 1hr before/after.
    const { busyStart, busyEnd } = busyWindow(start, end, skip_travel);
    const slot = await assertSlotFree(client, owner.id, busyStart, busyEnd, null, override_conflict);
    let appt;
    try {
      const ins = await client.query(
        `INSERT INTO appointments
           (lead_id, owner_id, appointment_type_id, start_at, end_at,
            duration_override_minutes, timezone, busy_range, status, idempotency_key, calendar_sync_status,
            override_conflict)
          VALUES ($1,$2,$3,$4,$5,$6,$7,tstzrange($8,$9,'[)'), 'scheduled', $10, 'pending', $11)
          RETURNING *`,
        [
          leadId, owner.id, appointment_type_id,
          start.toISOString(), end.toISOString(),
          duration_override_minutes != null ? Number(duration_override_minutes) : null,
          timezone || 'America/Los_Angeles',
          busyStart.toISOString(), busyEnd.toISOString(),
          idempotency_key,
          !!override_conflict,
        ]
      );
      appt = ins.rows[0];
      await recordOverride(client, appt.id, override_conflict, override_actor, slot.conflicts);
    } catch (e) {
      if (e.code === '23P01') { // exclusion_violation
        await client.query('ROLLBACK');
        throw new BookingError(409, 'slot_conflict', 'the requested slot conflicts with an existing active appointment');
      }
      throw e;
    }

    // 6. immutable audit event
    await client.query(
      `INSERT INTO appointment_events (appointment_id, actor, action, new_values)
       VALUES ($1, $2, 'created', $3)`,
      [
        appt.id, actor || null,
        JSON.stringify({
          start_at: appt.start_at, end_at: appt.end_at,
          appointment_type_id, duration_minutes: duration,
          timezone: appt.timezone, owner_id: owner.id, lead_id: leadId,
          override_conflict: !!override_conflict,
          override_actor: override_actor || null,
        }),
      ]
    );

    // 7. idempotency record
    await client.query(
      `INSERT INTO booking_idempotency (idempotency_key, lead_id, appointment_id, request_hash)
       VALUES ($1, $2, $3, $4)`,
      [idempotency_key, leadId, appt.id, reqHash]
    );

    // 8. calendar outbox — enqueued in the SAME tx; no Google API here.
    const leadRow = (await client.query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
    await calendarOutbox.enqueueCreate(client, appt, leadRow, owner.email, !!skip_travel);
    if (typeof input.onWrite === 'function') await input.onWrite(client, appt, leadId);

    await client.query('COMMIT');
    const lead = await client.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    return { idempotent: false, lead: lead.rows[0], appointment: appt };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e instanceof BookingError) throw e;
    throw new BookingError(500, 'booking_failed', e.message);
  } finally {
    client.release();
  }
}

async function cancelAppointment(appointment_id, actor, opts) {
  opts = opts || {};
  await ready();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [appointment_id]);
    const appt = r.rows[0];
    if (!appt) {
      await client.query('ROLLBACK');
      throw new BookingError(404, 'not_found', 'appointment not found');
    }
    if (!['scheduled', 'confirmed'].includes(appt.status)) {
      await client.query('ROLLBACK');
      throw new BookingError(409, 'not_cancellable', 'only active appointments can be cancelled');
    }
    const prev = { status: appt.status, start_at: appt.start_at, end_at: appt.end_at };
    await client.query('UPDATE appointments SET status = $1, version = version + 1, updated_at = NOW() WHERE id = $2', ['cancelled', appointment_id]);
    await client.query(
      `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values)
       VALUES ($1, $2, 'cancelled', $3, $4)`,
      [appointment_id, actor || null, JSON.stringify(prev), JSON.stringify({ status: 'cancelled' })]
    );
    // Calendar outbox: cancel main + travel for this slot, same tx.
    // Phone Calls (skip_travel=true): no travel event to cancel.
    const cancelledAppt = (await client.query('SELECT * FROM appointments WHERE id = $1', [appointment_id])).rows[0];
    await calendarOutbox.enqueueCancel(client, cancelledAppt, cancelledAppt.version, isPhoneCallAppointment(cancelledAppt));
    if (typeof opts.onWrite === 'function') await opts.onWrite(client, null, cancelledAppt.lead_id);

    await client.query('COMMIT');
    return { ok: true, appointment_id };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e instanceof BookingError) throw e;
    throw new BookingError(500, 'cancel_failed', e.message);
  } finally {
    client.release();
  }
}

async function rescheduleAppointment(appointment_id, { new_start_at, duration_override_minutes, appointment_type_id, actor, skip_travel, override_conflict, override_actor, onWrite }) {
  await ready();
  if (!new_start_at) throw new BookingError(400, 'new_start_at_required', 'new_start_at is required');
  validateDurationOverride(duration_override_minutes);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [appointment_id]);
    const old = r.rows[0];
    if (!old) {
      await client.query('ROLLBACK');
      throw new BookingError(404, 'not_found', 'appointment not found');
    }
    if (!['scheduled', 'confirmed'].includes(old.status)) {
      await client.query('ROLLBACK');
      throw new BookingError(409, 'not_reschedulable', 'only active appointments can be rescheduled');
    }

    // Flip old to 'rescheduled' (excluded from active constraint immediately).
    const prev = { status: old.status, start_at: old.start_at, end_at: old.end_at, appointment_type_id: old.appointment_type_id };
    await client.query('UPDATE appointments SET status = $1, version = version + 1, updated_at = NOW() WHERE id = $2', ['rescheduled', old.id]);
    await client.query(
      `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values)
       VALUES ($1, $2, 'rescheduled', $3, $4)`,
      [old.id, actor || null, JSON.stringify(prev), JSON.stringify({ status: 'rescheduled' })]
    );
    // Calendar outbox (Phase 2): cancel old slot's main + travel, same tx.
    const oldRow = (await client.query('SELECT * FROM appointments WHERE id = $1', [old.id])).rows[0];
    await calendarOutbox.enqueueCancel(client, oldRow, oldRow.version, isPhoneCallAppointment(oldRow));
    // Kind defaults to the old appointment's kind unless explicitly changed.
    if (skip_travel === undefined || skip_travel === null) skip_travel = isPhoneCallAppointment(old);

    // New appointment.
    const typeId = appointment_type_id || old.appointment_type_id;
    const type = await getType(typeId);
    if (!type) {
      await client.query('ROLLBACK');
      throw new BookingError(400, 'invalid_appointment_type', 'appointment_type_id not found');
    }
    const duration = resolveDuration(type, duration_override_minutes != null ? duration_override_minutes : old.duration_override_minutes);
    const start = new Date(new_start_at);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    // Phone Calls (skip_travel=true): no travel buffer. Meetings: 1hr before/after.
    const { busyStart, busyEnd } = busyWindow(start, end, skip_travel);
    const slot = await assertSlotFree(client, old.owner_id, busyStart, busyEnd, old.id, override_conflict);
    let appt;
    try {
      const ins = await client.query(
        `INSERT INTO appointments
           (lead_id, owner_id, appointment_type_id, start_at, end_at,
            duration_override_minutes, timezone, busy_range, status, idempotency_key, calendar_sync_status,
            override_conflict)
         VALUES ($1,$2,$3,$4,$5,$6,$7,tstzrange($8,$9,'[)'), 'scheduled', $10, 'pending', $11)
         RETURNING *`,
        [
          old.lead_id, old.owner_id, typeId,
          start.toISOString(), end.toISOString(),
          duration_override_minutes != null ? Number(duration_override_minutes) : null,
          old.timezone,
          busyStart.toISOString(), busyEnd.toISOString(),
          `${old.idempotency_key}:rs:${old.version || 1}`,
          !!override_conflict,
        ]
      );
      appt = ins.rows[0];
      await recordOverride(client, appt.id, override_conflict, override_actor, slot.conflicts);
    } catch (e) {
      if (e.code === '23P01') {
        await client.query('ROLLBACK');
        throw new BookingError(409, 'slot_conflict', 'the new slot conflicts with an existing active appointment');
      }
      throw e;
    }
    await client.query(
      `INSERT INTO appointment_events (appointment_id, actor, action, new_values)
       VALUES ($1, $2, 'created', $3)`,
      [appt.id, actor || null, JSON.stringify({ rescheduled_from: old.id, start_at: appt.start_at, end_at: appt.end_at, duration_minutes: duration })]
    );
    // Calendar outbox: create main + travel for the new slot, same tx.
    const newLead = (await client.query('SELECT * FROM leads WHERE id = $1', [old.lead_id])).rows[0];
    const newOwner = (await client.query('SELECT * FROM owners WHERE id = $1', [old.owner_id])).rows[0];
    await calendarOutbox.enqueueCreate(client, appt, newLead, newOwner.email, !!skip_travel);
    if (typeof onWrite === 'function') await onWrite(client, appt, old.lead_id);

    await client.query('COMMIT');
    return { ok: true, old_id: old.id, appointment: appt };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e instanceof BookingError) throw e;
    throw new BookingError(500, 'reschedule_failed', e.message);
  } finally {
    client.release();
  }
}

// updateAppointment — scoped PATCH (D4). Permits only: owner, appointment_type,
// duration_override_minutes, status (confirm/complete/no_show transitions).
// start_at is NOT mutable here (use reschedule). When the effective duration
// changes, busy_range + end_at are recomputed in the same transaction and the
// active EXCLUDE constraint re-validates. Emits immutable appointment_events:
// 'updated' (umbrella) + 'owner_changed'/'appointment_type_changed'/
// 'duration_changed'/'status_changed' as applicable. No second active appointment.
async function updateAppointment(appointment_id, patch, actor) {
  await ready();
  const { owner_id, owner_email, owner_display_name, appointment_type_id, duration_override_minutes, status } = patch || {};
  validateDurationOverride(duration_override_minutes);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM appointments WHERE id = $1 FOR UPDATE', [appointment_id]);
    const appt = r.rows[0];
    if (!appt) {
      await client.query('ROLLBACK');
      throw new BookingError(404, 'not_found', 'appointment not found');
    }
    if (!['scheduled', 'confirmed'].includes(appt.status)) {
      await client.query('ROLLBACK');
      throw new BookingError(409, 'not_updatable', 'only active appointments can be updated');
    }

    const changes = {};
    let newOwnerId = appt.owner_id;
    let newTypeId = appt.appointment_type_id;
    let newDurationOverride = appt.duration_override_minutes;

    if (owner_id != null || owner_email != null) {
      const newOwner = await resolveOwnerClient(client, { owner_id, owner_email, owner_display_name });
      if (String(newOwner.id) !== String(appt.owner_id)) {
        changes.owner = { prev: appt.owner_id, new: newOwner.id };
        newOwnerId = newOwner.id;
      }
    }
    if (appointment_type_id != null && String(appointment_type_id) !== String(appt.appointment_type_id)) {
      const t = await getType(appointment_type_id);
      if (!t) {
        await client.query('ROLLBACK');
        throw new BookingError(400, 'invalid_appointment_type', 'appointment_type_id not found');
      }
      changes.appointment_type = { prev: appt.appointment_type_id, new: appointment_type_id };
      newTypeId = appointment_type_id;
    }
    if (duration_override_minutes !== undefined) {
      const newVal = duration_override_minutes == null ? null : Number(duration_override_minutes);
      if (newVal !== appt.duration_override_minutes) {
        changes.duration_override = { prev: appt.duration_override_minutes, new: newVal };
        newDurationOverride = newVal;
      }
    }
    if (status != null && status !== appt.status) {
      const allowed = { scheduled: ['confirmed', 'completed', 'no_show'], confirmed: ['scheduled', 'completed', 'no_show'] };
      const allow = allowed[appt.status];
      if (!allow || !allow.includes(status)) {
        await client.query('ROLLBACK');
        throw new BookingError(400, 'invalid_status_transition', `cannot transition ${appt.status} -> ${status} via PATCH; use cancel/reschedule endpoints for those`);
      }
      changes.status = { prev: appt.status, new: status };
    }

    const oldType = await getType(appt.appointment_type_id);
    const newType = newTypeId !== appt.appointment_type_id ? await getType(newTypeId) : oldType;
    const oldEffDur = appt.duration_override_minutes != null ? appt.duration_override_minutes : (oldType ? oldType.default_duration_minutes : 60);
    const newEffDur = newDurationOverride != null ? newDurationOverride : (newType ? newType.default_duration_minutes : 60);
    const durationChanged = oldEffDur !== newEffDur;
    // Phone Call vs Meeting (travel buffer) comes from the appointment itself.
    const isPhoneCall = isPhoneCallAppointment(appt);

    if (!Object.keys(changes).length && !durationChanged) {
      await client.query('ROLLBACK');
      return { ok: true, unchanged: true, appointment: appt };
    }

    const sets = ['updated_at = NOW()', 'version = version + 1'];
    const vals = [];
    let p = 1;
    if (changes.owner) { sets.push(`owner_id = $${p}`); vals.push(newOwnerId); p++; }
    if (changes.appointment_type) { sets.push(`appointment_type_id = $${p}`); vals.push(newTypeId); p++; }
    if (changes.duration_override) { sets.push(`duration_override_minutes = $${p}`); vals.push(newDurationOverride); p++; }
    if (changes.status) { sets.push(`status = $${p}`); vals.push(changes.status.new); p++; }
    if (durationChanged) {
      const start = new Date(appt.start_at);
      const end = new Date(start.getTime() + newEffDur * 60 * 1000);
      const { busyStart, busyEnd } = busyWindow(start, end, isPhoneCall);
      await assertSlotFree(client, newOwnerId, busyStart, busyEnd, appt.id, false);
      sets.push(`end_at = $${p}`); vals.push(end.toISOString()); p++;
      sets.push(`busy_range = tstzrange($${p}, $${p + 1}, '[)')`); vals.push(busyStart.toISOString(), busyEnd.toISOString()); p += 2;
    }
    vals.push(appointment_id);
    let updated;
    try {
      await client.query(`UPDATE appointments SET ${sets.join(', ')} WHERE id = $${p}`, vals);
      const u = await client.query('SELECT * FROM appointments WHERE id = $1', [appointment_id]);
      updated = u.rows[0];
    } catch (e) {
      if (e.code === '23P01') {
        await client.query('ROLLBACK');
        throw new BookingError(409, 'slot_conflict', 'updated busy_range conflicts with an existing active appointment');
      }
      throw e;
    }

    const prevAll = {}, newAll = {};
    for (const k of Object.keys(changes)) { prevAll[k] = changes[k].prev; newAll[k] = changes[k].new; }
    if (durationChanged) { prevAll.duration_minutes = oldEffDur; newAll.duration_minutes = newEffDur; }

    await client.query(
      `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values) VALUES ($1, $2, 'updated', $3, $4)`,
      [appointment_id, actor || null, JSON.stringify(prevAll), JSON.stringify(newAll)]
    );
    if (changes.owner) {
      await client.query(
        `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values) VALUES ($1, $2, 'owner_changed', $3, $4)`,
        [appointment_id, actor || null, JSON.stringify({ owner_id: changes.owner.prev }), JSON.stringify({ owner_id: changes.owner.new })]
      );
    }
    if (changes.appointment_type) {
      await client.query(
        `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values) VALUES ($1, $2, 'appointment_type_changed', $3, $4)`,
        [appointment_id, actor || null, JSON.stringify({ appointment_type_id: changes.appointment_type.prev }), JSON.stringify({ appointment_type_id: changes.appointment_type.new })]
      );
    }
    if (durationChanged) {
      await client.query(
        `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values) VALUES ($1, $2, 'duration_changed', $3, $4)`,
        [appointment_id, actor || null, JSON.stringify({ minutes: oldEffDur }), JSON.stringify({ minutes: newEffDur })]
      );
    }
    if (changes.status) {
      await client.query(
        `INSERT INTO appointment_events (appointment_id, actor, action, previous_values, new_values) VALUES ($1, $2, 'status_changed', $3, $4)`,
        [appointment_id, actor || null, JSON.stringify({ status: changes.status.prev }), JSON.stringify({ status: changes.status.new })]
      );
    }

    // Calendar outbox: refresh the Google event when event-relevant
    // fields change (owner / appointment_type / duration). Status-only changes
    // do NOT touch Google (preserves existing behavior). Same tx as the mutation.
    const eventRelevant = !!(changes.owner || changes.appointment_type || durationChanged);
    if (eventRelevant) {
      const updAppt = (await client.query('SELECT * FROM appointments WHERE id = $1', [appointment_id])).rows[0];
      const updLead = (await client.query('SELECT * FROM leads WHERE id = $1', [updAppt.lead_id])).rows[0];
      const updOwner = (await client.query('SELECT * FROM owners WHERE id = $1', [updAppt.owner_id])).rows[0];
      await calendarOutbox.enqueueUpdate(client, updAppt, updLead, updOwner.email, updAppt.version, isPhoneCall);
    }

    await client.query('COMMIT');
    return { ok: true, unchanged: false, appointment: updated };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e instanceof BookingError) throw e;
    throw new BookingError(500, 'update_failed', e.message);
  } finally {
    client.release();
  }
}

// createAppointmentForLead — book the FIRST active appointment for an existing
// lead (Lead Detail → Schedule → Appointment). A lead has at most one active
// appointment; changing it goes through rescheduleAppointment.
async function createAppointmentForLead({ lead_id, start_at, skip_travel, appointment_type_id, duration_override_minutes,
  actor, override_conflict, override_actor, onWrite }) {
  await ready();
  if (!lead_id) throw new BookingError(400, 'lead_id_required', 'lead_id is required');
  if (!start_at) throw new BookingError(400, 'start_at_required', 'start_at is required');
  validateDurationOverride(duration_override_minutes);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lr = await client.query('SELECT * FROM leads WHERE id = $1 FOR UPDATE', [lead_id]);
    const lead = lr.rows[0];
    if (!lead) { await client.query('ROLLBACK'); throw new BookingError(404, 'not_found', 'lead not found'); }
    if (!lead.owner_id) { await client.query('ROLLBACK'); throw new BookingError(400, 'owner_required', 'assign the lead to an owner before booking an appointment'); }
    const active = await client.query(
      "SELECT id FROM appointments WHERE lead_id = $1 AND status IN ('scheduled','confirmed') LIMIT 1", [lead_id]);
    if (active.rows[0]) {
      await client.query('ROLLBACK');
      throw new BookingError(409, 'appointment_exists', 'this lead already has an active appointment — reschedule it instead',
        { appointment_id: active.rows[0].id });
    }
    let typeId = appointment_type_id;
    if (!typeId) {
      const t = await client.query(
        "SELECT id FROM appointment_types WHERE is_active = true ORDER BY (name = 'Consultation') DESC, name LIMIT 1");
      typeId = t.rows[0] && t.rows[0].id;
    }
    const type = typeId ? await getType(typeId) : null;
    if (!type) { await client.query('ROLLBACK'); throw new BookingError(400, 'invalid_appointment_type', 'no active appointment type'); }
    const duration = resolveDuration(type, duration_override_minutes);
    const start = new Date(start_at);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    const { busyStart, busyEnd } = busyWindow(start, end, skip_travel);
    const slot = await assertSlotFree(client, lead.owner_id, busyStart, busyEnd, null, override_conflict);
    const ins = await client.query(
      `INSERT INTO appointments
         (lead_id, owner_id, appointment_type_id, start_at, end_at,
          duration_override_minutes, timezone, busy_range, status, idempotency_key, calendar_sync_status,
          override_conflict)
       VALUES ($1,$2,$3,$4,$5,$6,'America/Los_Angeles',tstzrange($7,$8,'[)'), 'scheduled', $9, 'pending', $10)
       RETURNING *`,
      [lead_id, lead.owner_id, typeId, start.toISOString(), end.toISOString(),
       duration_override_minutes != null ? Number(duration_override_minutes) : null,
       busyStart.toISOString(), busyEnd.toISOString(),
       `lead-appt:${lead_id}:${start.toISOString()}:${crypto.randomUUID()}`,
       !!override_conflict]
    );
    const appt = ins.rows[0];
    await recordOverride(client, appt.id, override_conflict, override_actor, slot.conflicts);
    await client.query(
      `INSERT INTO appointment_events (appointment_id, actor, action, new_values)
       VALUES ($1, $2, 'created', $3)`,
      [appt.id, actor || null, JSON.stringify({
        start_at: appt.start_at, end_at: appt.end_at, appointment_type_id: typeId, duration_minutes: duration,
        owner_id: lead.owner_id, lead_id, kind: skip_travel ? 'Phone Call' : 'Meeting',
        override_conflict: !!override_conflict, override_actor: override_actor || null,
      })]
    );
    const owner = (await client.query('SELECT * FROM owners WHERE id = $1', [lead.owner_id])).rows[0];
    await calendarOutbox.enqueueCreate(client, appt, lead, owner && owner.email, !!skip_travel);
    if (typeof onWrite === 'function') await onWrite(client, appt, lead_id);
    await client.query('COMMIT');
    return { ok: true, appointment: appt };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    if (e instanceof BookingError) throw e;
    if (e && e.code === 'invalid_duration') throw new BookingError(400, 'invalid_duration', e.message);
    throw new BookingError(500, 'booking_failed', e.message);
  } finally {
    client.release();
  }
}

module.exports = { createBooking, createAppointmentForLead, busyWindow, cancelAppointment, rescheduleAppointment, updateAppointment, BookingError, hashRequest };