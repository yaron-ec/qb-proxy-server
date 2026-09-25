/* eslint-disable no-undef */
/**
 * routes/publicCapture.js — PUBLIC Railway endpoints for the Lead Capture form.
 *
 *   GET  /api/public/capture/availability   — blocked slots for an owner/date
 *   POST /api/public/capture                — atomic lead (+ optional appointment,
 *                                             + optional independent follow-up)
 *
 * NO CRM JWT. NO PROXY_SECRET. These are intentionally narrow, public, rate-
 * limited endpoints for the unauthenticated Philippines-team intake form.
 * They do NOT expose general CRM read/write APIs.
 *
 * Availability uses the corrected single-buffer logic (lib/booking/slotBlocking).
 * Submission uses bookingService.createBooking — one PostgreSQL transaction
 * with the appointments.busy_range EXCLUDE constraint for atomic slot
 * reservation (409 on conflict, zero leads/appointments/side-effects on 409).
 *
 * Side effects ported from base44/functions/submitLeadCapture:
 *   - lead create (Railway leads)  [bookingService]
 *   - appointment create + calendar_outbox → Google Calendar   [bookingService]
 *   - activity note (Railway activities)                       [post-commit]
 *   - reminder ingestion (Railway reminder_leads)             [post-commit]
 *   - new-lead alert email (Railway emailService)             [post-commit]
 * GAPS (not invented here — reported):
 *   - Google Contacts sync (no Railway service-account module exists yet)
 */
'use strict';

const express = require('express');
const { getAvailability, CalendarUnavailableError } = require('../lib/booking/availabilityService');
const { createBooking, BookingError } = require('../lib/booking/bookingService');
const { query, ensureSchema } = require('../db/client');
const db = require('../db/client');
const {
  validateCapturePayload, computeIdempotencyKey, laToUtcStart,
  resolveOwnerEmail, isValidOwnerEmail, DEFAULT_INTAKE_REP,
} = require('../lib/captureValidation');
const { syncLeadToReminders } = require('../lib/reminderProjection');
const { rateLimit } = require('../lib/rateLimit');
const { sendNewLeadAlert } = require('../lib/captureAlerts');
const { authorizeOverride } = require('../lib/captureOverrideAuth');

const router = express.Router();

// ── CORS — restricted to configured EC frontend origins ────────────────────
const ALLOWED_ORIGINS = (process.env.CAPTURE_ALLOWED_ORIGINS || process.env.CRM_PUBLIC_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];

function corsCapture(req, res, next) {
  const origin = req.headers.origin || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || DEV_ORIGINS.includes(origin);
  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
router.use(corsCapture);

const availLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const submitLimiter = rateLimit({ windowMs: 60 * 1000, max: 8 });
const appListsLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });

// ── GET /app-lists — public canonical Lead Sources + Project Types ──────────
// Returns { projectTypes, leadSources } from app_settings (key='app_lists').
// No JWT required — read-only public endpoint for the Capture form.
// The canonical source of truth for Lead Sources is app_settings.value.sources
// (camelCase). No hardcoded arrays, no legacy settings.app_lists.lead_sources.
router.get('/app-lists', appListsLimiter, async (req, res) => {
  try {
    const r = await query("SELECT value FROM app_settings WHERE key = 'app_lists'");
    const appLists = (r.rows[0] && r.rows[0].value) || {};
    res.json({
      projectTypes: appLists.projectTypes || [],
      leadSources: appLists.sources || [],
    });
  } catch (e) {
    console.error('[publicCapture:app-lists] error:', e.message);
    res.status(500).json({ error: 'app_lists_unavailable' });
  }
});

// ── GET /availability?owner=...&date=YYYY-MM-DD&duration=60 ────────────────
router.get('/availability', availLimiter, async (req, res) => {
  try {
    // Ensure the booking-core schema (owners, appointments, appointment_types)
    // exists before querying. ensureSchema() is idempotent (CREATE IF NOT EXISTS)
    // and runs once per process. Without this, a fresh database where no booking
    // has been created yet (bookingService.ensureSchema is lazy) returns 500.
    await ensureSchema();
    const owner = (req.query.owner || DEFAULT_INTAKE_REP).trim();
    const date = req.query.date ? String(req.query.date) : '';
    const duration = req.query.duration ? parseInt(req.query.duration, 10) : 60;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'invalid_date', message: 'date must be YYYY-MM-DD' });
    }
    const ownerEmail = resolveOwnerEmail(owner);
    if (!ownerEmail || !isValidOwnerEmail(ownerEmail)) {
      return res.status(400).json({ error: 'invalid_owner', message: 'owner not recognized' });
    }
    const r = await query('SELECT id FROM owners WHERE lower(email) = lower($1) AND is_active = true', [ownerEmail]);
    const owner_id = r.rows[0] ? r.rows[0].id : null;
    // Always run availability (Postgres + Google). A missing owner row means no
    // Postgres appointments, but Google Calendar is still read for the date.
    const result = await getAvailability({
      owner_id, date, timezone: 'America/Los_Angeles', duration_minutes: duration,
    });
    res.json({
      date, timezone: result.timezone, duration_minutes: result.duration_minutes,
      blocked_slots: result.blocked_slots, busy_windows: result.busy_windows,
    });
  } catch (e) {
    if (e && (e.code === 'calendar_unavailable' || e instanceof CalendarUnavailableError)) {
      // Google Calendar could not be read — do NOT silently report the day as
      // free. Return a service-unavailable so reps cannot book into an unknown
      // calendar state.
      console.error('[public-capture] google calendar unavailable:', e.message);
      return res.status(503).json({
        error: 'calendar_unavailable',
        message: 'Calendar availability cannot be confirmed right now. Please try again shortly.',
      });
    }
    console.error('[public-capture] availability error:', e.message);
    res.status(500).json({ error: 'availability_failed', message: 'Availability check failed.' });
  }
});

// ── POST / — atomic lead + appointment create ──────────────────────────────
router.post('/', submitLimiter, async (req, res) => {
  try {
    const v = validateCapturePayload(req.body || {});
    if (!v.ok) return res.status(400).json({ error: 'validation_failed', message: v.errors.join('; '), details: v.errors });
    const c = v.cleaned;

    // A. Appointment is optional. When present, resolve the appointment type
    // (Consultation = 60 min default for capture).
    const hasAppointment = !!(c.appointment_date && c.appointment_time);
    let appointment_type_id = null;
    if (hasAppointment) {
      const atRes = await query("SELECT id FROM appointment_types WHERE name='Consultation' AND is_active=true LIMIT 1");
      if (!atRes.rows[0]) return res.status(500).json({ error: 'appointment_type_missing', message: 'Server misconfiguration.' });
      appointment_type_id = atRes.rows[0].id;
    }

    const start_at = hasAppointment ? laToUtcStart(c.appointment_date, c.appointment_time) : null;
    const idempotency_key = computeIdempotencyKey({
      owner_email: c.owner_email, first_name: c.first_name, last_name: c.last_name,
      email: c.email, phone: c.phone, property_address: c.property_address,
      appointment_type_id, start_at,
      appointment_override: c.appointment_override,
    });

    // Admin conflict-override gate. The public capture route is unauthenticated
    // for normal submissions; an override is ONLY honored when a valid Railway
    // admin JWT + server-side email allowlist check passes (lib/captureOverrideAuth).
    // The frontend toggle is never trusted.
    let override_conflict = false;
    let override_actor = null;
    let actor = 'capture-form';
    if (c.appointment_override && hasAppointment) {
      const auth = authorizeOverride(req.headers.authorization);
      if (!auth.ok) {
        return res.status(403).json({ error: auth.code, message: auth.message });
      }
      override_conflict = true;
      override_actor = auth.user.email;
      actor = auth.user.email;
    }

    const booking = await createBooking({
      idempotency_key,
      owner_email: c.owner_email,
      owner_display_name: c.assigned_rep,
      first_name: c.first_name,
      last_name: c.last_name,
      email: c.email,
      phone: c.phone,
      property_address: c.property_address,
      city: c.city,
      project_type: c.project_type,
      budget_range: c.budget_range,
      start_timeframe: c.start_timeframe,
      source: c.source,
      referral_name: c.referral_name,
      notes: [c.message, c.notes].filter(Boolean).join('\n\n') || null,
      appointment_type_id,
      start_at,
      timezone: 'America/Los_Angeles',
      actor,
      override_conflict,
      override_actor,
      skip_travel: hasAppointment && c.appointment_type === 'Phone Call',
      // B. Independent follow-up (or null). Never derived from the appointment.
      follow_up: c.follow_up,
      // Reminder projection inside the booking transaction (customer
      // reminders are keyed to the canonical appointment row). Wrapped in a
      // SAVEPOINT: a projection failure is logged (POST
      // /api/v1/cron/backfill-reminder-leads re-projects) but can never lose
      // a public New Lead submission.
      onWrite: async (client, _appt, newLeadId) => {
        await client.query('SAVEPOINT capture_reminder_projection');
        try {
          const lr = await client.query(
            `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
               FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`, [newLeadId]);
          if (lr.rows[0]) await syncLeadToReminders(client, lr.rows[0]);
          await client.query('RELEASE SAVEPOINT capture_reminder_projection');
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT capture_reminder_projection');
          console.warn('[public-capture] reminder projection failed (non-fatal, lead kept):', e.message);
        }
      },
    });

    const leadId = booking.lead && booking.lead.id;

    // Idempotent retry → return the original result, do NOT re-run side effects.
    if (booking.idempotent) {
      return res.status(200).json({
        success: true, idempotent: true,
        lead: { id: leadId, first_name: c.first_name, last_name: c.last_name },
        appointment: booking.appointment && { id: booking.appointment.id, start_at: booking.appointment.start_at },
      });
    }

    // ── Post-commit side effects (NEW bookings only; best-effort, non-fatal) ──
    // These run AFTER the booking tx committed. A 409 above never reaches here.
    if (leadId) {
      // 1. Capture-specific lead fields not inserted by bookingService.
      //    (Appointment and follow-up are already written by bookingService —
      //    the appointment is NOT mirrored into follow_up_*.)
      try {
        await query(
          `UPDATE leads SET
             message = $1, photo_urls = $2, is_new_intake_lead = true,
             crm_created_date = NOW(), record_type = 'Lead', updated_at = NOW()
           WHERE id = $3`,
          [c.message, c.photo_urls, leadId]
        );
      } catch (e) { console.warn('[public-capture] lead extra-field update failed:', e.message); }

      // 1b. Canonical address pipeline — normalize + geocode the form-submitted
      // address through the same pipeline used by every other write path.
      if (c.property_address) {
        try {
          const { processAddress, persistAddressForLead } = require('../lib/addressPipeline');
          const addressResult = await processAddress({
            street: c.property_address,
            city: c.city,
            state: '',
            zip: '',
          });
          await persistAddressForLead(leadId, addressResult);
        } catch (e) { console.warn('[public-capture] address pipeline failed (non-blocking):', e.message); }
      }

      // 2. Activity note for the message (mirrors submitLeadCapture Activity.create).
      if (c.message) {
        try {
          await query(
            `INSERT INTO activities (lead_id, type, content, author, source)
             VALUES ($1, 'note', $2, $3, 'manual')`,
            [leadId, c.message.slice(0, 4000), c.assigned_rep]
          );
        } catch (e) { console.warn('[public-capture] activity insert failed:', e.message); }
      }

      // 3. Reminder projection already ran inside the booking transaction
      //    (onWrite above) from the canonical appointment + follow-up.

      // 4. New-lead alert email (Railway emailService — best-effort, non-fatal).
      //    Mirrors notifyYaronNewWebsiteLead: Yaron + Michelle. Never rolls back.
      try {
        const leadRow = (await query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
        if (leadRow) await sendNewLeadAlert(leadRow, process.env.CRM_PUBLIC_URL || '');
      } catch (e) { console.warn('[public-capture] new-lead alert failed (non-fatal):', e.message); }
    }

    // Post-commit: enqueue Google Contacts sync (fire-and-forget, non-blocking)
    // NOTE: this file imports the whole db/client module as `db` (see requires
    // above) — it does not destructure a local `pool`. Use db.pool, not a bare
    // `pool` reference (a bare reference here is a ReferenceError on every call,
    // since no such identifier exists in this file's scope).
    try {
      const contactsOutbox = require('../lib/googleContactsOutbox');
      await contactsOutbox.enqueueContactSync(db.pool, leadId);
    } catch (e) { console.warn('[public-capture] contacts outbox enqueue failed (non-fatal):', e.message); }

    return res.status(201).json({
      success: true,
      lead: { id: leadId, first_name: c.first_name, last_name: c.last_name },
      appointment: booking.appointment ? { id: booking.appointment.id, start_at: booking.appointment.start_at } : null,
      follow_up: c.follow_up,
    });
  } catch (e) {
    if (e instanceof BookingError) {
      if (e.code === 'slot_conflict') {
        return res.status(409).json({ error: 'conflict', message: 'This time slot is no longer available. Please select another time.' });
      }
      if (e.code === 'potential_duplicate') {
        return res.status(409).json({ error: 'potential_duplicate', message: 'A potential duplicate lead exists. Please review.', details: e.details });
      }
      if (e.code === 'idempotency_conflict') {
        return res.status(409).json({ error: 'idempotency_conflict', message: 'A submission with this data is already being processed.' });
      }
      return res.status(e.status || 400).json({ error: e.code || 'error', message: e.message });
    }
    console.error('[public-capture] submit error:', e.message);
    res.status(500).json({ error: 'submit_failed', message: 'Submission failed. Please try again.' });
  }
});

module.exports = router;