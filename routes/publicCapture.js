/* eslint-disable no-undef */
/**
 * routes/publicCapture.js ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â PUBLIC Railway endpoints for the Lead Capture form.
 *
 *   GET  /api/public/capture/availability   ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â blocked slots for an owner/date
 *   POST /api/public/capture                ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â atomic lead + appointment create
 *
 * NO CRM JWT. NO PROXY_SECRET. These are intentionally narrow, public, rate-
 * limited endpoints for the unauthenticated Philippines-team intake form.
 * They do NOT expose general CRM read/write APIs.
 *
 * Availability uses the corrected single-buffer logic (lib/booking/slotBlocking).
 * Submission uses bookingService.createBooking ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â one PostgreSQL transaction
 * with the appointments.busy_range EXCLUDE constraint for atomic slot
 * reservation (409 on conflict, zero leads/appointments/side-effects on 409).
 *
 * Side effects ported from base44/functions/submitLeadCapture:
 *   - lead create (Railway leads) + projection_outbox ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Base44  [bookingService]
 *   - appointment create + calendar_outbox ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Google Calendar   [bookingService]
 *   - activity note (Railway activities)                       [post-commit]
 *   - reminder ingestion (Railway reminder_leads)             [post-commit]
 *   - new-lead alert email (Railway emailService)             [post-commit]
 * GAPS (not invented here ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â reported):
 *   - Google Contacts sync (no Railway service-account module exists yet)
 */
'use strict';

const express = require('express');
const { getAvailability, CalendarUnavailableError } = require('../lib/booking/availabilityService');
const { createBooking, BookingError } = require('../lib/booking/bookingService');
const { query } = require('../db/client');
const db = require('../db/client');
const {
  validateCapturePayload, computeIdempotencyKey, laToUtcStart,
  resolveOwnerEmail, isValidOwnerEmail,
} = require('../lib/captureValidation');
const { validateAndNormalizeLead, upsertLead } = require('../lib/leadIngest');
const { rateLimit } = require('../lib/rateLimit');
const { sendNewLeadAlert } = require('../lib/captureAlerts');

const router = express.Router();

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ CORS ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â restricted to configured EC frontend origins ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
const ALLOWED_ORIGINS = (process.env.CAPTURE_ALLOWED_ORIGINS || process.env.CRM_PUBLIC_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];

function corsCapture(req, res, next) {
  const origin = req.headers.origin || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || DEV_ORIGINS.includes(origin)
    || /\.base44\.(app|dev|com)$/.test(origin) || /-base44\./.test(origin);
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

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ GET /availability?owner=...&date=YYYY-MM-DD&duration=60 ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
router.get('/availability', availLimiter, async (req, res) => {
  try {
    const owner = (req.query.owner || 'Yaron Drilevich').trim();
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

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ POST / ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â atomic lead + appointment create ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
router.post('/', submitLimiter, async (req, res) => {
  try {
    const v = validateCapturePayload(req.body || {});
    if (!v.ok) return res.status(400).json({ error: 'validation_failed', details: v.errors });
    const c = v.cleaned;

    // Resolve the appointment type (Consultation = 60 min default for capture).
    const atRes = await query("SELECT id FROM appointment_types WHERE name='Consultation' AND is_active=true LIMIT 1");
    if (!atRes.rows[0]) return res.status(500).json({ error: 'appointment_type_missing', message: 'Server misconfiguration.' });
    const appointment_type_id = atRes.rows[0].id;

    const start_at = laToUtcStart(c.appointment_date, c.appointment_time);
    const idempotency_key = computeIdempotencyKey({
      owner_email: c.owner_email, first_name: c.first_name, last_name: c.last_name,
      email: c.email, phone: c.phone, property_address: c.property_address,
      appointment_type_id, start_at,
    });

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
      actor: 'capture-form',
    });

    const leadId = booking.lead && booking.lead.id;

    // Idempotent retry ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ return the original result, do NOT re-run side effects.
    if (booking.idempotent) {
      return res.status(200).json({
        success: true, idempotent: true,
        lead: { id: leadId, first_name: c.first_name, last_name: c.last_name },
        appointment: booking.appointment && { id: booking.appointment.id, start_at: booking.appointment.start_at },
      });
    }

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Post-commit side effects (NEW bookings only; best-effort, non-fatal) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    // These run AFTER the booking tx committed. A 409 above never reaches here.
    if (leadId) {
      // 1. Capture-specific lead fields not inserted by bookingService.
      try {
        await query(
          `UPDATE leads SET
             message = $1, photo_urls = $2, is_new_intake_lead = true,
             follow_up_date = $3, follow_up_time = $4, follow_up_type = 'Meeting',
             meeting_stage = 'First Meeting', crm_created_date = NOW(),
             record_type = 'Lead', updated_at = NOW()
           WHERE id = $5`,
          [c.message, c.photo_urls, c.appointment_date, c.appointment_time, leadId]
        );
      } catch (e) { console.warn('[public-capture] lead extra-field update failed:', e.message); }

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

      // 3. Reminder ingestion ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â upsert into reminder_leads so the reminder engine
      //    can schedule appointment reminders from the REAL appointment time.
      try {
        const rl = validateAndNormalizeLead({
          id: leadId,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          phone: c.phone,
          property_address: c.property_address,
          city: c.city,
          project_type: c.project_type,
          appointment_date: c.appointment_date,
          appointment_time: c.appointment_time,
          assigned_rep: c.assigned_rep,
          notes: [c.message, c.notes].filter(Boolean).join('\n\n') || null,
        });
        if (rl.ok) await upsertLead(db, rl.lead);
      } catch (e) { console.warn('[public-capture] reminder_leads upsert failed:', e.message); }

      // 4. New-lead alert email (Railway emailService ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â best-effort, non-fatal).
      //    Mirrors notifyYaronNewWebsiteLead: Yaron + Michelle. Never rolls back.
      try {
        const leadRow = (await query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
        if (leadRow) await sendNewLeadAlert(leadRow, process.env.CRM_PUBLIC_URL || '');
      } catch (e) { console.warn('[public-capture] new-lead alert failed (non-fatal):', e.message); }
    }

    return res.status(201).json({
      success: true,
      lead: { id: leadId, first_name: c.first_name, last_name: c.last_name },
      appointment: booking.appointment && { id: booking.appointment.id, start_at: booking.appointment.start_at },
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