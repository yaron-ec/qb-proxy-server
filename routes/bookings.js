/* eslint-disable no-undef */
/**
 * /api/v1 — Railway Booking API (Phase 1).
 *
 *   GET   /api/v1/appointment-types              list active types + durations
 *   GET   /api/v1/availability/:owner/:date       daily blocked slots + busy windows
 *   POST  /api/v1/bookings                        atomic Lead+Appointment (idempotent)
 *   POST  /api/v1/appointments/:id/cancel        cancel (status change, no delete)
 *   POST  /api/v1/appointments/:id/reschedule     reschedule (cancel old + new in one tx)
 *   PATCH /api/v1/appointments/:id                scoped update (owner/type/duration/status)
 *   GET   /api/v1/appointments/:id                read one appointment
 *
 * Auth: Railway JWT (lib/rbac.requireAuth) + owner-scope authorization (D6).
 *   admin/manager: all owners. office: read-only, all owners. sales_rep: own
 *   owner only (canonical owner email === user email). Owner reassign (PATCH
 *   owner) requires admin/manager. No PROXY_SECRET, no Base44 tokens.
 *
 * Phase 1: availability is sourced from the canonical appointments table only.
 * Google manual-event classification and the calendar/projection outboxes
 * arrive in Phase 2/3.
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../lib/rbac');
const { canonicalEmail } = require('../lib/authorization');
const { getAvailability, CalendarUnavailableError } = require('../lib/booking/availabilityService');
const { createBooking, cancelAppointment, rescheduleAppointment, updateAppointment, BookingError } = require('../lib/booking/bookingService');
const { listTypes } = require('../lib/booking/appointmentTypes');
const { query } = require('../db/client');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function handleBookingErr(res, e) {
  const status = e.status || 500;
  const body = { error: e.code || 'error', message: e.message };
  if (e.details) body.details = e.details;
  res.status(status).json(body);
}

// ── Owner-scope authorization (D6) ───────────────────────────────────────────
// Validates against the CANONICAL owner UUID/email, never a browser-supplied
// display name. admin/manager = all; office = read-only all; sales_rep = own.
function canAccessOwner(user, ownerEmail, write) {
  const role = String((user && user.role) || '').toLowerCase();
  if (!role) return false;
  if (role === 'admin' || role === 'manager') return true;
  if (role === 'office') return !write; // read-only, all owners
  if (role === 'sales_rep') {
    const u = canonicalEmail(user.email);
    const o = canonicalEmail(ownerEmail);
    return !!(u && o && u === o);
  }
  return false;
}

function deny(res, write) {
  return res.status(403).json({ error: 'forbidden', message: `not authorized to ${write ? 'write' : 'access'} this owner's appointments` });
}

// Resolve owner (id or email) WITHOUT creating — for auth checks only.
async function peekOwner(owner_id, owner_email) {
  if (owner_id) {
    const r = await query('SELECT id, email FROM owners WHERE id = $1', [owner_id]);
    if (r.rows[0]) return { id: r.rows[0].id, email: r.rows[0].email };
  }
  if (owner_email) {
    const em = String(owner_email).trim().toLowerCase();
    const r = await query('SELECT id, email FROM owners WHERE lower(email) = lower($1)', [em]);
    if (r.rows[0]) return { id: r.rows[0].id, email: r.rows[0].email };
    return { id: null, email: em }; // not yet created
  }
  return null;
}

async function ownerEmailById(owner_id) {
  const r = await query('SELECT email FROM owners WHERE id = $1', [owner_id]);
  return r.rows[0] ? r.rows[0].email : null;
}

async function getAppointmentForAuth(appointment_id) {
  const r = await query('SELECT id, owner_id, status FROM appointments WHERE id = $1', [appointment_id]);
  return r.rows[0] || null;
}

// Returns the appointment row on success, or null after sending 403/404.
async function authAppointmentWrite(req, res, appointment_id) {
  const appt = await getAppointmentForAuth(appointment_id);
  if (!appt) { res.status(404).json({ error: 'not_found' }); return null; }
  const ownerEmail = await ownerEmailById(appt.owner_id);
  if (!canAccessOwner(req.user, ownerEmail, true)) { deny(res, true); return null; }
  return appt;
}

router.get('/appointment-types', requireAuth, async (req, res) => {
  try {
    res.json({ types: await listTypes() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/availability/:owner/:date', requireAuth, async (req, res) => {
  try {
    const { owner, date } = req.params;
    const { timezone, appointment_type_id, duration_minutes } = req.query;
    const peek = UUID_RE.test(owner)
      ? await peekOwner(owner, null)
      : await peekOwner(null, owner);
    if (!peek || !peek.id) {
      // Owner row not yet created → no appointments exist → empty availability
      // (still enforce scope: a sales_rep may only query their own owner email).
      const emailForCheck = peek ? peek.email : owner;
      if (!canAccessOwner(req.user, emailForCheck, false)) return deny(res, false);
      return res.json({
        date, timezone: timezone || 'America/Los_Angeles',
        blocked_slots: [], busy_windows: [],
        duration_minutes: duration_minutes != null ? Number(duration_minutes) : 60,
      });
    }
    if (!canAccessOwner(req.user, peek.email, false)) return deny(res, false);
    const result = await getAvailability({
      owner_id: peek.id, date, timezone,
      appointment_type_id,
      duration_minutes: duration_minutes != null ? Number(duration_minutes) : null,
    });
    res.json(result);
  } catch (e) {
    if (e && (e.code === 'calendar_unavailable' || e instanceof CalendarUnavailableError)) {
      return res.status(503).json({
        error: 'calendar_unavailable',
        message: 'Calendar availability cannot be confirmed right now.',
      });
    }
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

router.post('/bookings', requireAuth, async (req, res) => {
  try {
    const actor = req.user ? req.user.email : null;
    const body = req.body || {};
    const peek = await peekOwner(body.owner_id || null, body.owner_email || null);
    const ownerEmail = peek ? peek.email : (body.owner_email ? String(body.owner_email).trim().toLowerCase() : null);
    if (!canAccessOwner(req.user, ownerEmail, true)) return deny(res, true);
    const result = await createBooking({ ...body, actor });
    res.status(result.idempotent ? 200 : 201).json(result);
  } catch (e) {
    handleBookingErr(res, e);
  }
});

router.post('/appointments/:id/cancel', requireAuth, async (req, res) => {
  try {
    const actor = req.user ? req.user.email : null;
    const appt = await authAppointmentWrite(req, res, req.params.id);
    if (!appt) return;
    const result = await cancelAppointment(req.params.id, actor);
    res.json(result);
  } catch (e) {
    handleBookingErr(res, e);
  }
});

router.post('/appointments/:id/reschedule', requireAuth, async (req, res) => {
  try {
    const actor = req.user ? req.user.email : null;
    const appt = await authAppointmentWrite(req, res, req.params.id);
    if (!appt) return;
    const result = await rescheduleAppointment(req.params.id, { ...req.body, actor });
    res.json(result);
  } catch (e) {
    handleBookingErr(res, e);
  }
});

router.patch('/appointments/:id', requireAuth, async (req, res) => {
  try {
    const actor = req.user ? req.user.email : null;
    const body = req.body || {};
    const appt = await authAppointmentWrite(req, res, req.params.id);
    if (!appt) return;
    // Owner reassignment requires admin/manager (sales_rep/office cannot reassign).
    if (body.owner_id != null || body.owner_email != null) {
      const role = String((req.user && req.user.role) || '').toLowerCase();
      if (role !== 'admin' && role !== 'manager') {
        return res.status(403).json({ error: 'forbidden', message: 'only admin/manager can reassign an appointment owner' });
      }
      const newPeek = await peekOwner(body.owner_id || null, body.owner_email || null);
      const newEmail = newPeek ? newPeek.email : (body.owner_email ? String(body.owner_email).trim().toLowerCase() : null);
      if (!canAccessOwner(req.user, newEmail, true)) return deny(res, true);
    }
    const result = await updateAppointment(req.params.id, body, actor);
    res.json(result);
  } catch (e) {
    handleBookingErr(res, e);
  }
});

router.get('/appointments/:id', requireAuth, async (req, res) => {
  try {
    const appt = await getAppointmentForAuth(req.params.id);
    if (!appt) return res.status(404).json({ error: 'not_found' });
    const ownerEmail = await ownerEmailById(appt.owner_id);
    if (!canAccessOwner(req.user, ownerEmail, false)) return deny(res, false);
    const r = await query('SELECT * FROM appointments WHERE id = $1', [req.params.id]);
    res.json({ appointment: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;