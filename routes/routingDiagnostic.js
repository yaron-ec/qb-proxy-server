/* eslint-disable no-undef */
/**
 * routingDiagnostic — X-Proxy-Secret protected diagnostic endpoints for the
 * Daily Appointment Routing subsystem. No JWT required — used to verify the
 * production geocoding/routing pipeline without a browser session.
 */
'use strict';

const express = require('express');
const gmaps = require('../lib/googleMapsClient');
const { query } = require('../db/client');

const router = express.Router();

// GET /daily-diagnostic?date=YYYY-MM-DD&owner=...
// Returns the full daily schedule with geocoding details for debugging.
router.get('/daily-diagnostic', async (req, res) => {
  try {
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const owner = req.query.owner;

    // Ensure geocode columns exist on leads table
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_property_address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lat DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lng DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_geocode_status TEXT DEFAULT \'pending\'');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS state TEXT');

    // Query appointments for this date (JOIN owners for assigned_rep)
    const excluded = ['Lost', 'DNQ', 'Cancelled', 'Closed Lost'];
    let whereClause = `l.follow_up_date = $1 AND l.follow_up_type = 'Meeting' AND (l.status IS NULL OR l.status = '' OR l.status NOT IN (${excluded.map((s, i) => `$${i + 2}`).join(',')}))`;
    const params = [date, ...excluded];
    if (owner && owner !== 'all') {
      whereClause += ` AND (o.display_name = $${params.length + 1} OR o.email = $${params.length + 1})`;
      params.push(owner);
    }

    const { rows: leads } = await query(
      `SELECT l.id, l.first_name, l.last_name, l.property_address, l.city, l.state, l.zip, l.phone, l.email,
              l.project_type, COALESCE(o.display_name, o.email) AS assigned_rep,
              l.follow_up_date, l.follow_up_time, l.status,
              l.verified_property_address, l.property_lat, l.property_lng, l.property_geocode_status
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE ${whereClause}
       ORDER BY l.follow_up_time ASC`,
      params
    );

    // For each lead, show the normalization and geocoding details
    const details = [];
    for (const lead of leads) {
      const normalizedAddr = gmaps.normalizeAddress(lead.property_address, lead.city);
      let geocodeResult = null;
      let geocodeError = null;
      try {
        const coords = await gmaps.geocodeAddress(normalizedAddr);
        if (coords) {
          geocodeResult = {
            lat: coords.lat,
            lng: coords.lng,
            formattedAddress: coords.formattedAddress,
            placeId: coords.placeId,
          };
        } else {
          geocodeError = 'Google returned no results';
        }
      } catch (e) {
        geocodeError = e.message;
      }

      details.push({
        id: lead.id,
        name: `${lead.first_name} ${lead.last_name}`,
        follow_up_time: lead.follow_up_time,
        assigned_rep: lead.assigned_rep,
        raw_address: lead.property_address,
        raw_city: lead.city,
        raw_state: lead.state,
        raw_zip: lead.zip,
        normalized_address: normalizedAddr,
        google_verified_address: geocodeResult?.formattedAddress || null,
        google_coords: geocodeResult ? { lat: geocodeResult.lat, lng: geocodeResult.lng } : null,
        google_place_id: geocodeResult?.placeId || null,
        geocode_error: geocodeError,
        persisted_verified_address: lead.verified_property_address || null,
        persisted_lat: lead.property_lat || null,
        persisted_lng: lead.property_lng || null,
        persisted_geocode_status: lead.property_geocode_status || null,
      });
    }

    res.json({
      date,
      google_maps_configured: gmaps.isConfigured(),
      google_maps_api_key_set: !!process.env.GOOGLE_MAPS_API_KEY,
      google_service_account_set: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      total_appointments: leads.length,
      appointments: details,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /reconcile-addresses — system-wide address field reconciliation.
// For each lead: reconstruct full address → geocode with Google → if
// high-confidence match, split into Street/City/State/ZIP and overwrite the
// leads table fields. Preserves original raw values in original_* columns.
// Ambiguous records are marked 'needs_review' and left untouched.
router.post('/reconcile-addresses', async (req, res) => {
  try {
    if (!gmaps.isConfigured()) {
      return res.status(503).json({
        error: 'google_maps_not_configured',
        message: 'Set GOOGLE_MAPS_API_KEY on Railway.',
      });
    }

    // Ensure all columns exist (including state + original_* audit columns)
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_property_address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lat DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lng DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_geocode_status TEXT DEFAULT \'pending\'');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS state TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_property_address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_city TEXT');

    // Fetch leads that haven't been reconciled yet
    const { rows: leads } = await query(`
      SELECT id, property_address, city, state, zip,
             verified_property_address, property_geocode_status,
             original_property_address, original_city
      FROM leads
      WHERE property_address IS NOT NULL AND property_address != ''
        AND (property_geocode_status IS NULL OR property_geocode_status NOT IN ('reconciled', 'needs_review'))
        AND (status IS NULL OR status NOT IN ('Lost', 'DNQ', 'Cancelled', 'Closed Lost') OR status = '')
      ORDER BY created_at DESC
      LIMIT 500
    `);

    let reconciled = 0;
    let needsReview = 0;
    let failed = 0;
    const errors = [];
    const reconciledDetails = [];

    for (const lead of leads) {
      try {
        const normalizedAddr = gmaps.normalizeAddress(lead.property_address, lead.city);
        const coords = await gmaps.geocodeAddress(normalizedAddr);

        if (!coords) {
          await query('UPDATE leads SET property_geocode_status = $1 WHERE id = $2', ['needs_review', lead.id]);
          needsReview++;
          continue;
        }

        if (!coords.isHighConfidence || coords.partialMatch) {
          await query(
            `UPDATE leads SET verified_property_address = $1, property_lat = $2, property_lng = $3, property_geocode_status = 'needs_review' WHERE id = $4`,
            [coords.formattedAddress, coords.lat, coords.lng, lead.id]
          );
          needsReview++;
          continue;
        }

        const { street, city, state, zip } = coords.addressComponents;

        // Preserve original raw values (only if not already preserved)
        const updates = [];
        const params = [];
        let idx = 1;

        if (!lead.original_property_address && lead.property_address) {
          updates.push(`original_property_address = $${idx++}`);
          params.push(lead.property_address);
        }
        if (!lead.original_city && lead.city) {
          updates.push(`original_city = $${idx++}`);
          params.push(lead.city);
        }

        updates.push(`property_address = $${idx++}`); params.push(street);
        updates.push(`city = $${idx++}`); params.push(city);
        updates.push(`state = $${idx++}`); params.push(state);
        updates.push(`zip = $${idx++}`); params.push(zip);
        updates.push(`verified_property_address = $${idx++}`); params.push(coords.formattedAddress);
        updates.push(`property_lat = $${idx++}`); params.push(coords.lat);
        updates.push(`property_lng = $${idx++}`); params.push(coords.lng);
        updates.push(`property_geocode_status = $${idx++}`); params.push('reconciled');

        params.push(lead.id);
        await query(`UPDATE leads SET ${updates.join(', ')} WHERE id = $${idx}`, params);

        reconciledDetails.push({
          id: lead.id,
          before: { property_address: lead.property_address, city: lead.city, state: lead.state, zip: lead.zip },
          after: { property_address: street, city, state, zip },
          verified: coords.formattedAddress,
        });
        reconciled++;
      } catch (e) {
        console.warn(`[routing-diag] reconcile failed for lead ${lead.id}:`, e.message);
        errors.push(`${lead.id}: ${e.message}`);
        failed++;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    res.json({
      total: leads.length,
      reconciled,
      needs_review: needsReview,
      failed,
      message: `Reconciled ${reconciled}, ${needsReview} need review, ${failed} failed`,
      reconciled_details: reconciledDetails.slice(0, 20),
      errors: errors.slice(0, 10),
    });
  } catch (e) {
    console.error('[routing-diag] reconcile error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /reconcile-status — check which leads have been reconciled and which need review
router.get('/reconcile-status', async (req, res) => {
  try {
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS state TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_geocode_status TEXT DEFAULT \'pending\'');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_property_address TEXT');

    const { rows } = await query(`
      SELECT property_geocode_status, COUNT(*) as count
      FROM leads
      WHERE property_address IS NOT NULL AND property_address != ''
      GROUP BY property_geocode_status
      ORDER BY count DESC
    `);

    const { rows: needsReview } = await query(`
      SELECT id, first_name, last_name, property_address, city, state, zip, verified_property_address
      FROM leads
      WHERE property_geocode_status = 'needs_review'
      LIMIT 20
    `);

    res.json({ status_counts: rows, needs_review_samples: needsReview });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /lead-search?name=... — query a lead by name to verify address fields
router.get('/lead-search', async (req, res) => {
  try {
    const name = req.query.name || '';
    const { rows } = await query(
      `SELECT id, first_name, last_name, property_address, city, state, zip,
              verified_property_address, property_lat, property_lng, property_geocode_status,
              follow_up_date, follow_up_time, follow_up_type, status,
              original_property_address, original_city
       FROM leads
       WHERE first_name ILIKE $1 OR last_name ILIKE $1
       LIMIT 10`,
      [`%${name}%`]
    );
    res.json({ leads: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /backfill-geocodes — system-wide reconciliation (X-Proxy-Secret auth).
// Clears ALL stale geocode errors, re-geocodes every active lead through the
// corrected normalization pipeline, and persists the Google-verified address,
// coordinates, and verification status to the leads table.
router.post('/backfill-geocodes', async (req, res) => {
  try {
    if (!gmaps.isConfigured()) {
      return res.status(503).json({
        error: 'google_maps_not_configured',
        message: 'Set GOOGLE_MAPS_API_KEY or GOOGLE_SERVICE_ACCOUNT_KEY on Railway.',
      });
    }

    // Ensure columns exist
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_property_address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lat DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lng DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_geocode_status TEXT DEFAULT \'pending\'');
    await query('CREATE TABLE IF NOT EXISTS lead_geocodes (lead_id TEXT PRIMARY KEY, address_hash TEXT NOT NULL, normalized_address TEXT, verified_address TEXT, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, google_place_id TEXT, geocode_status TEXT DEFAULT \'pending\', geocoded_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW())');
    await query('ALTER TABLE lead_geocodes ADD COLUMN IF NOT EXISTS verified_address TEXT');

    // Clear ALL stale geocode errors so they get re-geocoded with the fixed normalization
    await query(`DELETE FROM lead_geocodes WHERE geocode_status != 'ok'`);
    await query(`UPDATE leads SET property_geocode_status = 'pending' WHERE property_geocode_status IN ('not_found', 'error', 'pending') OR property_geocode_status IS NULL`);

    // Fetch all leads with addresses
    const { rows: leads } = await query(`
      SELECT id, property_address, city
      FROM leads
      WHERE property_address IS NOT NULL AND property_address != ''
        AND (status IS NULL OR status NOT IN ('Lost', 'DNQ', 'Cancelled', 'Closed Lost') OR status = '')
      ORDER BY created_at DESC
      LIMIT 500
    `);

    const crypto = require('crypto');
    function addrHash(addr) { return crypto.createHash('md5').update(addr.toLowerCase().trim()).digest('hex'); }

    let success = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];

    for (const lead of leads) {
      const normalizedAddr = gmaps.normalizeAddress(lead.property_address, lead.city);
      const hash = addrHash(normalizedAddr);

      // Check cache
      const cached = await query(
        'SELECT * FROM lead_geocodes WHERE lead_id = $1 AND address_hash = $2 AND geocode_status = $3',
        [lead.id, hash, 'ok']
      );
      if (cached.rows[0]) {
        const c = cached.rows[0];
        const verifiedAddr = c.verified_address || c.normalized_address;
        await query(
          `UPDATE leads SET verified_property_address = $1, property_lat = $2, property_lng = $3, property_geocode_status = 'verified' WHERE id = $4`,
          [verifiedAddr, c.latitude, c.longitude, lead.id]
        );
        skipped++;
        continue;
      }

      try {
        const coords = await gmaps.geocodeAddress(normalizedAddr);
        if (coords) {
          const verifiedAddr = coords.formattedAddress || normalizedAddr;
          await query(
            `INSERT INTO lead_geocodes (lead_id, address_hash, normalized_address, verified_address, latitude, longitude, google_place_id, geocode_status, geocoded_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ok', NOW(), NOW())
             ON CONFLICT (lead_id) DO UPDATE SET
               address_hash = $2, normalized_address = $3, verified_address = $4, latitude = $5, longitude = $6,
               google_place_id = $7, geocode_status = 'ok', geocoded_at = NOW(), updated_at = NOW()`,
            [lead.id, hash, normalizedAddr, verifiedAddr, coords.lat, coords.lng, coords.placeId || null]
          );
          await query(
            `UPDATE leads SET verified_property_address = $1, property_lat = $2, property_lng = $3, property_geocode_status = 'verified' WHERE id = $4`,
            [verifiedAddr, coords.lat, coords.lng, lead.id]
          );
          success++;
        } else {
          await query(
            `INSERT INTO lead_geocodes (lead_id, address_hash, normalized_address, geocode_status, geocoded_at, updated_at)
             VALUES ($1, $2, $3, 'not_found', NOW(), NOW())
             ON CONFLICT (lead_id) DO UPDATE SET address_hash = $2, geocode_status = 'not_found', updated_at = NOW()`,
            [lead.id, hash, normalizedAddr]
          );
          await query(`UPDATE leads SET property_geocode_status = 'not_found' WHERE id = $1`, [lead.id]);
          failed++;
          errors.push({ lead_id: lead.id, address: normalizedAddr, error: 'Google returned no results' });
        }
      } catch (e) {
        await query(
          `INSERT INTO lead_geocodes (lead_id, address_hash, normalized_address, geocode_status, geocoded_at, updated_at)
           VALUES ($1, $2, $3, 'error', NOW(), NOW())
           ON CONFLICT (lead_id) DO UPDATE SET address_hash = $2, geocode_status = 'error', updated_at = NOW()`,
          [lead.id, hash, normalizedAddr]
        );
        await query(`UPDATE leads SET property_geocode_status = 'error' WHERE id = $1`, [lead.id]);
        failed++;
        errors.push({ lead_id: lead.id, address: normalizedAddr, error: e.message });
      }

      await new Promise(r => setTimeout(r, 100));
    }

    res.json({
      total: leads.length,
      success,
      failed,
      skipped,
      errors: errors.slice(0, 20),
      message: `Geocoded ${success} new, skipped ${skipped} cached, ${failed} failed`,
    });
  } catch (e) {
    console.error('[routing-diag] backfill error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;