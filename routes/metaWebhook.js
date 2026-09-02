/* eslint-disable no-undef */
/**
 * /api/v1/meta-webhook — Meta/Facebook leadgen webhook receiver (Railway-native).
 *
 * Replaces any Base44 function that received Meta leadgen webhooks.
 * Meta sends leadgen events here when a user submits a lead form on Facebook/Instagram.
 *
 *   GET  /api/v1/meta-webhook   — Webhook verification (returns hub.challenge)
 *   POST /api/v1/meta-webhook   — Process leadgen events
 *
 * Verification: hub.mode=subscribe, hub.verify_token must match META_VERIFY_TOKEN.
 * Signature: X-Hub-Signature-256 = HMAC-SHA256 of raw body using META_APP_SECRET.
 *
 * For each leadgen event:
 *   1. Fetch lead data from Graph API (metaLeadMapper.fetchLeadgenData)
 *   2. Map to CRM capture format (metaLeadMapper.mapMetaLead)
 *   3. Call bookingService.createBooking (atomic lead + appointment create)
 *   4. Post-commit side effects (activity, reminder ingestion, alert email)
 *
 * Idempotent: leadgen_id is used as the idempotency key component.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || process.env.FACEBOOK_VERIFY_TOKEN || '';
const META_APP_SECRET = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true; // not configured → skip verification
  const signature = req.headers['x-hub-signature-256'] || '';
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody || '').digest('hex');
  const received = signature.replace('sha256=', '');
  try {
    return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// GET — Meta webhook verification
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = req.query['hub.verify_token'];

  if (mode === 'subscribe' && challenge) {
    if (!META_VERIFY_TOKEN || verifyToken !== META_VERIFY_TOKEN) {
      console.warn('[meta-webhook] Verification token mismatch');
      return res.status(403).json({ error: 'verification_failed' });
    }
    return res.type('text/plain').send(String(challenge));
  }
  res.json({ status: 'active', service: 'meta-webhook' });
});

// POST — Process leadgen events
router.post('/', express.raw({ type: '*/*', verify: (req, res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) {
      console.warn('[meta-webhook] Signature verification failed');
      return res.status(401).json({ error: 'signature_verification_failed' });
    }

    let body;
    try { body = JSON.parse(req.rawBody.toString('utf8')); } catch { body = {}; }

    const entries = body.entry || [];
    if (entries.length === 0) {
      return res.json({ received: true, processed: 0 });
    }

    const { fetchLeadgenData, mapMetaLead } = require('../lib/metaLeadMapper');
    const { createBooking, BookingError } = require('../lib/booking/bookingService');
    const { query } = require('../db/client');
    const { validateAndNormalizeLead, upsertLead } = require('../lib/leadIngest');
    const db = require('../db/client');
    const { sendNewLeadAlert } = require('../lib/captureAlerts');

    let processed = 0;
    let errors = [];

    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'leadgen') continue;

        const leadgenId = change.value?.leadgen_id;
        const formId = change.value?.form_id;
        const pageId = change.value?.page_id || entry.id;

        if (!leadgenId) continue;

        try {
          // Fetch lead data from Graph API
          const leadgenData = await fetchLeadgenData(leadgenId);
          if (!leadgenData) {
            errors.push({ leadgen_id: leadgenId, error: 'fetch_failed' });
            continue;
          }

          // Map to CRM capture format
          const mapped = mapMetaLead(leadgenData, {
            source: 'Instagram / Facebook',
            owner_email: 'yaron@ecconstructiongroup.com',
            assigned_rep: 'Yaron Drilevich',
          });

          if (!mapped.first_name && !mapped.last_name) {
            console.warn(`[meta-webhook] Lead ${leadgenId} has no name — skipping`);
            errors.push({ leadgen_id: leadgenId, error: 'no_name' });
            continue;
          }

          // Resolve appointment type
          const atRes = await query("SELECT id FROM appointment_types WHERE name='Consultation' AND is_active=true LIMIT 1");
          if (!atRes.rows[0]) {
            errors.push({ leadgen_id: leadgenId, error: 'appointment_type_missing' });
            continue;
          }
          const appointment_type_id = atRes.rows[0].id;

          // Build start_at from appointment date/time (default to next business day 9am if not provided)
          let startAt;
          if (mapped.appointment_date) {
            const { laToUtcStart } = require('../lib/captureValidation');
            startAt = laToUtcStart(mapped.appointment_date, mapped.appointment_time || '09:00');
          } else {
            // No appointment — create lead without booking an appointment
            // Use a placeholder far-future date that won't conflict
            startAt = null;
          }

          // Idempotency key: deterministic per leadgen_id
          const idempotency_key = `meta-${leadgenId}`;

          // Check if this lead was already imported (idempotency)
          const existing = await query(
            'SELECT id FROM leads WHERE external_ref = $1',
            [idempotency_key]
          ).catch(() => ({ rows: [] }));

          if (existing.rows[0]) {
            console.log(`[meta-webhook] Lead ${leadgenId} already imported — skipping`);
            processed++;
            continue;
          }

          // Create the booking (atomic lead + appointment)
          if (startAt) {
            const booking = await createBooking({
              idempotency_key,
              owner_email: mapped.owner_email,
              owner_display_name: mapped.assigned_rep,
              first_name: mapped.first_name,
              last_name: mapped.last_name,
              email: mapped.email,
              phone: mapped.phone,
              property_address: mapped.property_address,
              city: mapped.city,
              project_type: mapped.project_type,
              source: mapped.source,
              notes: mapped.message || null,
              appointment_type_id,
              start_at: startAt,
              timezone: 'America/Los_Angeles',
              actor: 'meta-webhook',
              external_ref: idempotency_key,
            });

            const leadId = booking.lead?.id;

            if (leadId && !booking.idempotent) {
              // Post-commit side effects
              try {
                await query(
                  `UPDATE leads SET message = $1, is_new_intake_lead = true,
                   follow_up_type = 'Meeting', meeting_stage = 'First Meeting',
                   crm_created_date = NOW(), record_type = 'Lead', updated_at = NOW()
                   WHERE id = $2`,
                  [mapped.message, leadId]
                );
              } catch (e) { console.warn('[meta-webhook] lead update failed:', e.message); }

              // Reminder ingestion
              try {
                const rl = validateAndNormalizeLead({
                  id: leadId,
                  first_name: mapped.first_name,
                  last_name: mapped.last_name,
                  email: mapped.email,
                  phone: mapped.phone,
                  property_address: mapped.property_address,
                  city: mapped.city,
                  project_type: mapped.project_type,
                  appointment_date: mapped.appointment_date,
                  appointment_time: mapped.appointment_time,
                  assigned_rep: mapped.assigned_rep,
                  notes: mapped.message || null,
                });
                if (rl.ok) await upsertLead(db, rl.lead);
              } catch (e) { console.warn('[meta-webhook] reminder_leads upsert failed:', e.message); }

              // New-lead alert
              try {
                const leadRow = (await query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
                if (leadRow) await sendNewLeadAlert(leadRow, process.env.CRM_PUBLIC_URL || '');
              } catch (e) { console.warn('[meta-webhook] alert failed:', e.message); }
            }
          } else {
            // No appointment date — create lead only (no booking)
            try {
              const { query: q } = require('../db/client');
              const insRes = await q(
                `INSERT INTO leads (first_name, last_name, email, phone, property_address, city,
                   project_type, source, notes, is_new_intake_lead, external_ref, status,
                   crm_created_date, record_type, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, 'New', NOW(), 'Lead', NOW(), NOW())
                 RETURNING id`,
                [mapped.first_name, mapped.last_name, mapped.email, mapped.phone,
                 mapped.property_address, mapped.city, mapped.project_type, mapped.source,
                 mapped.message, idempotency_key]
              );
              const leadId = insRes.rows[0]?.id;
              if (leadId) {
                // Reminder ingestion
                try {
                  const rl = validateAndNormalizeLead({
                    id: leadId,
                    first_name: mapped.first_name,
                    last_name: mapped.last_name,
                    email: mapped.email,
                    phone: mapped.phone,
                    property_address: mapped.property_address,
                    city: mapped.city,
                    project_type: mapped.project_type,
                    assigned_rep: mapped.assigned_rep,
                    notes: mapped.message || null,
                  });
                  if (rl.ok) await upsertLead(db, rl.lead);
                } catch (e) { console.warn('[meta-webhook] reminder_leads upsert failed:', e.message); }

                // New-lead alert
                try {
                  const leadRow = (await q('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
                  if (leadRow) await sendNewLeadAlert(leadRow, process.env.CRM_PUBLIC_URL || '');
                } catch (e) { console.warn('[meta-webhook] alert failed:', e.message); }
              }
            } catch (e) {
              console.error('[meta-webhook] lead-only create failed:', e.message);
              errors.push({ leadgen_id: leadgenId, error: e.message });
            }
          }

          processed++;
          console.log(`[meta-webhook] Processed lead ${leadgenId} → ${mapped.first_name} ${mapped.last_name}`);
        } catch (e) {
          if (e instanceof BookingError) {
            if (e.code === 'idempotency_conflict' || e.code === 'potential_duplicate') {
              console.log(`[meta-webhook] Lead ${leadgenId} duplicate — skipping`);
              processed++;
              continue;
            }
          }
          console.error(`[meta-webhook] Error processing lead ${leadgenId}:`, e.message);
          errors.push({ leadgen_id: leadgenId, error: e.message });
        }
      }
    }

    // Always return 200 to prevent Meta retries
    res.json({ received: true, processed, errors: errors.length });
  } catch (e) {
    console.error('[meta-webhook] error:', e.message);
    res.status(200).json({ received: true, processed: 0, error: e.message });
  }
});

module.exports = router;