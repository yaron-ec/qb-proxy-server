/* eslint-disable no-undef */
/**
 * /api/v1/website-leads — receiver for leads from the public website
 * (ecconstructiongroup.com on Netlify). The website persists every lead first,
 * then POSTs it here and retries failed deliveries on a schedule.
 *
 *   GET    /api/v1/website-leads                    — status (no secrets, no data)
 *   POST   /api/v1/website-leads                    — receive one website lead
 *   DELETE /api/v1/website-leads/test/:externalRef  — delete a controlled TEST
 *                                                     lead (returns what was stored)
 *
 * Auth: shared secret in `x-webhook-secret` (the website's existing contract),
 * compared in constant time against WEBSITE_LEAD_WEBHOOK_SECRET. Fails CLOSED:
 * with the variable unset every POST/DELETE is refused (503), never accepted.
 *
 * Idempotency: every delivery is keyed by the website's Idempotency-Key
 * (`ec-website-lead-<id>`, identical on every retry). website_lead_receipts
 * claims the key before any write, so a retry — or a concurrent duplicate —
 * never creates a second lead or a second note; it gets the original result.
 *
 * Deduplication (lib/booking/leadResolution via bookingService.createBooking):
 *   - same person already in the CRM (name + phone/email match) → no new lead;
 *     the inquiry is added to that lead as an activity note;
 *   - phone/email match but a different name → a new lead is created (a real
 *     inquiry is never dropped) with a "possible duplicate of …" note so staff
 *     can review/merge it with the existing Merge tool;
 *   - otherwise a new lead (status New, source Website, no appointment).
 *
 * Side effects for a NEW lead mirror the other intake paths (public capture,
 * Meta webhook): intake fields, activity note, internal new-lead alert email,
 * Google Contacts enqueue. No appointment/follow-up is created, so no customer
 * reminder is ever scheduled. Controlled test leads (lib/websiteLeadIntake
 * isTestLead) get no alert and no Google Contacts sync.
 *
 * Logs contain lead ids and actions only — no customer PII.
 */
'use strict';

const express = require('express');
const { secretMatches, isTestLead, externalRefFor, mapWebsiteLead, EXTERNAL_REF_RE } = require('../lib/websiteLeadIntake');
const { rateLimit } = require('../lib/rateLimit');

const STALE_CLAIM_SECONDS = 120;

function createWebsiteLeadsRouter(deps) {
  const {
    query, pool, createBooking, BookingError, ownerEmail, ownerDisplayName,
    sendNewLeadAlert, enqueueContactSync, removeFromReminders,
    cleanupLeadTextRefs, cancelAppointmentsForLeadDelete,
    getSecret = () => process.env.WEBSITE_LEAD_WEBHOOK_SECRET,
    crmPublicUrl = () => process.env.CRM_PUBLIC_URL || '',
    log = console,
  } = deps;

  const router = express.Router();

  function requireSecret(req, res, next) {
    const secret = getSecret();
    if (!secret) return res.status(503).json({ error: 'not_configured', message: 'Website lead intake is not configured.' });
    if (!secretMatches(req.headers['x-webhook-secret'], secret)) return res.status(401).json({ error: 'unauthorized' });
    next();
  }

  router.get('/', (req, res) => {
    res.json({ service: 'website-leads', configured: !!getSecret(), capabilities: ['test-evidence'] });
  });

  // Claim the idempotency reference. Returns { claimed: true } or the stored
  // receipt of an earlier delivery.
  async function claim(ref, isTest) {
    const ins = await query(
      `INSERT INTO website_lead_receipts (external_ref, is_test) VALUES ($1, $2)
       ON CONFLICT (external_ref) DO NOTHING RETURNING external_ref`, [ref, isTest]);
    if (ins.rows[0]) return { claimed: true };
    const r = (await query('SELECT * FROM website_lead_receipts WHERE external_ref = $1', [ref])).rows[0];
    if (r && r.completed_at) return { claimed: false, receipt: r };
    // An unfinished claim older than the stale window belongs to a crashed
    // attempt: take it over. A fresh one is a concurrent duplicate → 409.
    const take = await query(
      `UPDATE website_lead_receipts SET received_at = NOW()
        WHERE external_ref = $1 AND completed_at IS NULL
          AND received_at < NOW() - ($2 || ' seconds')::interval
        RETURNING external_ref`, [ref, String(STALE_CLAIM_SECONDS)]);
    if (take.rows[0]) return { claimed: true };
    return { claimed: false, inProgress: true };
  }

  async function note(leadId, content) {
    try {
      await query(`INSERT INTO activities (lead_id, type, content, author, source) VALUES ($1, 'note', $2, 'Website', 'manual')`,
        [leadId, content.slice(0, 4000)]);
    } catch (e) { log.warn('[website-leads] activity insert failed:', e.message); }
  }

  router.post('/', rateLimit({ windowMs: 60 * 1000, max: 60 }), requireSecret, async (req, res) => {
    const m = mapWebsiteLead(req.body);
    if (!m.ok) return res.status(400).json({ error: 'validation_failed', details: m.errors });
    const lead = m.lead;
    const ref = externalRefFor(req.headers['idempotency-key'], req.body);
    const test = isTestLead(lead);

    let c;
    try {
      c = await claim(ref, test);
    } catch (e) {
      log.error('[website-leads] receipt claim failed:', e.message);
      return res.status(503).json({ error: 'unavailable' });
    }
    if (c.inProgress) return res.status(409).json({ error: 'in_progress', message: 'This lead is already being processed.' });
    if (!c.claimed) {
      return res.status(200).json({ success: true, id: c.receipt.lead_id, action: c.receipt.action, duplicate_delivery: true });
    }

    try {
      const base = {
        idempotency_key: ref,
        external_ref: ref,
        owner_email: ownerEmail(),
        owner_display_name: ownerDisplayName(),
        first_name: lead.first_name,
        last_name: lead.last_name,
        email: lead.email,
        phone: lead.phone,
        city: lead.city,
        zip: lead.zip,
        project_type: lead.project_type,
        budget_range: lead.budget_range,
        start_timeframe: lead.start_timeframe,
        source: lead.source,
        notes: lead.notes,
        actor: 'website',
      };

      let booking;
      let action = 'created';
      let candidates = null;
      try {
        booking = await createBooking(base);
      } catch (e) {
        if (!(e instanceof BookingError) || e.code !== 'potential_duplicate') throw e;
        candidates = (e.details && e.details.candidates) || [];
        booking = await createBooking({ ...base, force_new_lead: true });
        action = 'created_possible_duplicate';
      }
      const leadId = booking.lead && booking.lead.id;
      if (!leadId) throw new Error('booking returned no lead');
      // Reuse of the lead THIS delivery created on an earlier, interrupted
      // attempt (same external_ref) continues as a creation; any other reuse
      // is an existing customer.
      if (booking.idempotent && booking.lead.external_ref !== ref) action = 'matched_existing';

      const inquiry = [
        action === 'matched_existing' ? 'Repeat inquiry from the website form.' : 'Website inquiry.',
        lead.website_lead_id ? `Website lead ID: ${lead.website_lead_id}` : null,
        lead.project_type ? `Project: ${lead.project_type}` : null,
        lead.message ? `Message: ${lead.message}` : null,
      ].filter(Boolean).join('\n');

      if (action === 'matched_existing') {
        await note(leadId, inquiry);
        if (lead.sms_consent) {
          // A new explicit opt-in is recorded; an unchecked box never revokes.
          await query(
            `UPDATE leads SET sms_consent = true, sms_consent_at = $1, sms_consent_disclosure_version = $2,
                    sms_consent_source = $3, updated_at = NOW()
              WHERE id = $4 AND sms_consent IS DISTINCT FROM true`,
            [lead.sms_consent_at, lead.sms_consent_disclosure_version, lead.sms_consent_source, leadId]);
        }
      } else {
        await query(
          `UPDATE leads SET message = $1, photo_urls = $2, is_new_intake_lead = true,
                  crm_created_date = COALESCE($3::timestamptz, NOW()), record_type = 'Lead',
                  sms_consent = $4, sms_consent_at = $5, sms_consent_disclosure_version = $6,
                  sms_consent_source = $7, updated_at = NOW()
            WHERE id = $8`,
          [lead.message, lead.photo_urls, lead.submitted_at, lead.sms_consent, lead.sms_consent_at,
            lead.sms_consent_disclosure_version, lead.sms_consent_source, leadId]);
        await note(leadId, inquiry);
        if (candidates && candidates.length) {
          await note(leadId, `Possible duplicate: the phone or email matches existing lead(s) ${candidates.map((x) => x.id).join(', ')} with a different name. Review and merge if this is the same customer.`);
        }
        if (!test) {
          try {
            const row = (await query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
            if (row) await sendNewLeadAlert(row, crmPublicUrl());
          } catch (e) { log.warn('[website-leads] new-lead alert failed (non-fatal):', e.message); }
          try { await enqueueContactSync(pool, leadId); } catch (e) { log.warn('[website-leads] contacts enqueue failed (non-fatal):', e.message); }
        }
      }

      await query('UPDATE website_lead_receipts SET lead_id = $1, action = $2, completed_at = NOW() WHERE external_ref = $3',
        [leadId, action, ref]);
      log.log(`[website-leads] ${action} lead ${leadId}${test ? ' (test)' : ''}`);
      return res.status(action === 'matched_existing' ? 200 : 201).json({ success: true, id: leadId, action });
    } catch (e) {
      // Release the claim so the website's retry can deliver it again.
      try { await query('DELETE FROM website_lead_receipts WHERE external_ref = $1 AND completed_at IS NULL', [ref]); } catch (_) { /* ignore */ }
      if (e instanceof BookingError) {
        return res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.code || 'error', message: e.message });
      }
      log.error('[website-leads] receive failed:', e.message);
      return res.status(500).json({ error: 'receive_failed' });
    }
  });

  // Deletes ONLY a controlled test lead: the receipt must be marked test AND
  // the stored lead must still carry the test markers. Returns the stored lead
  // (as the CRM saved it) so the end-to-end check can verify the mapping.
  router.delete('/test/:externalRef', requireSecret, async (req, res) => {
    const ref = String(req.params.externalRef || '');
    if (!EXTERNAL_REF_RE.test(ref)) return res.status(400).json({ error: 'invalid_ref' });
    try {
      const receipt = (await query('SELECT * FROM website_lead_receipts WHERE external_ref = $1', [ref])).rows[0];
      if (!receipt) return res.status(404).json({ error: 'not_found' });
      if (!receipt.is_test) return res.status(403).json({ error: 'not_a_test_lead' });
      const lead = receipt.lead_id ? (await query('SELECT * FROM leads WHERE id = $1', [receipt.lead_id])).rows[0] : null;
      if (lead && !isTestLead(lead)) return res.status(403).json({ error: 'not_a_test_lead' });
      const notes = lead ? (await query('SELECT type, content, author FROM activities WHERE lead_id = $1 ORDER BY created_at', [lead.id])).rows : [];
      // Read-only evidence for the end-to-end check, gathered before deletion:
      // no duplicate record, no appointment/follow-up/reminder, nothing queued
      // for Google Contacts, no email of any kind. null = could not be read.
      const count = async (sql, params) => {
        try { return Number((await query(sql, params)).rows[0].n); } catch (_) { return null; }
      };
      const evidence = lead ? {
        leads_with_this_external_ref: await count('SELECT count(*) AS n FROM leads WHERE external_ref = $1', [ref]),
        leads_with_this_email: await count('SELECT count(*) AS n FROM leads WHERE lower(email) = lower($1)', [lead.email || '']),
        receipts_for_this_delivery: await count('SELECT count(*) AS n FROM website_lead_receipts WHERE external_ref = $1', [ref]),
        appointments: await count('SELECT count(*) AS n FROM appointments WHERE lead_id = $1', [lead.id]),
        follow_up: { type: lead.follow_up_type || null, date: lead.follow_up_date || null, status: lead.follow_up_status || null },
        reminder_rows: await count('SELECT count(*) AS n FROM reminder_leads WHERE id = $1 OR id = $2', [lead.external_ref || '', String(lead.id)]),
        reminder_claims: await count('SELECT count(*) AS n FROM reminder_claims WHERE lead_id = $1 OR lead_id = $2', [lead.external_ref || '', String(lead.id)]),
        google_contacts_queued: await count('SELECT count(*) AS n FROM google_contacts_outbox WHERE lead_id = $1', [lead.id]),
        google_contact_synced: !!lead.google_contact_resource_name,
        emails_claimed: await count(`SELECT count(*) AS n FROM email_send_claims WHERE idempotency_key LIKE '%' || $1 || '%' OR lower(recipient) = lower($2)`, [String(lead.id), lead.email || '']),
        emails_logged: await count(`SELECT count(*) AS n FROM email_send_logs WHERE idempotency_key LIKE '%' || $1 || '%' OR lower(recipient) = lower($2)`, [String(lead.id), lead.email || '']),
        total_leads_before_cleanup: await count('SELECT count(*) AS n FROM leads', []),
      } : null;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (lead) {
          await removeFromReminders(client, lead);
          await cancelAppointmentsForLeadDelete(client, lead.id);
          await cleanupLeadTextRefs(client, lead.id);
          const del = await client.query('DELETE FROM leads WHERE id = $1', [lead.id]);
          if (evidence) evidence.leads_deleted = del.rowCount;
        }
        await client.query('DELETE FROM website_lead_receipts WHERE external_ref = $1', [ref]);
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw e;
      } finally {
        client.release();
      }
      log.log(`[website-leads] deleted test lead ${lead ? lead.id : '(none)'}`);
      const pick = (r) => r && ({
        id: r.id, external_ref: r.external_ref, first_name: r.first_name, last_name: r.last_name, email: r.email,
        phone: r.phone, city: r.city, zip: r.zip, project_type: r.project_type, budget_range: r.budget_range,
        start_timeframe: r.start_timeframe, source: r.source, status: r.status, message: r.message,
        is_new_intake_lead: r.is_new_intake_lead, sms_consent: r.sms_consent, sms_consent_at: r.sms_consent_at,
        sms_consent_disclosure_version: r.sms_consent_disclosure_version, sms_consent_source: r.sms_consent_source,
        owner_id: r.owner_id, notes: r.notes, crm_created_date: r.crm_created_date,
      });
      if (evidence) evidence.total_leads_after_cleanup = await count('SELECT count(*) AS n FROM leads', []);
      return res.json({ deleted: true, action: receipt.action, lead: pick(lead), activities: notes, evidence });
    } catch (e) {
      log.error('[website-leads] test cleanup failed:', e.message);
      return res.status(500).json({ error: 'cleanup_failed' });
    }
  });

  return router;
}

function defaultRouter() {
  const db = require('../db/client');
  const { createBooking, BookingError } = require('../lib/booking/bookingService');
  const { resolveOwnerEmail, DEFAULT_INTAKE_REP } = require('../lib/captureValidation');
  const { sendNewLeadAlert } = require('../lib/captureAlerts');
  const { enqueueContactSync } = require('../lib/googleContactsOutbox');
  const { removeFromReminders } = require('../lib/reminderProjection');
  const leadsRoutes = require('./leads');
  return createWebsiteLeadsRouter({
    query: db.query, pool: db.pool, createBooking, BookingError,
    ownerEmail: () => resolveOwnerEmail(DEFAULT_INTAKE_REP),
    ownerDisplayName: () => DEFAULT_INTAKE_REP,
    sendNewLeadAlert, enqueueContactSync, removeFromReminders,
    cleanupLeadTextRefs: leadsRoutes.cleanupLeadTextRefs,
    cancelAppointmentsForLeadDelete: leadsRoutes.cancelAppointmentsForLeadDelete,
  });
}

module.exports = { createWebsiteLeadsRouter, defaultRouter };
