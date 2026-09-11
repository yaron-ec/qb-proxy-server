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

    // Query appointments for this date (JOIN owners for assigned_rep)
    const excluded = ['Lost', 'DNQ', 'Cancelled', 'Closed Lost'];
    let whereClause = `l.follow_up_date = $1 AND l.follow_up_type = 'Meeting' AND (l.status IS NULL OR l.status = '' OR l.status NOT IN (${excluded.map((s, i) => `$${i + 2}`).join(',')}))`;
    const params = [date, ...excluded];
    if (owner && owner !== 'all') {
      whereClause += ` AND (o.display_name = $${params.length + 1} OR o.email = $${params.length + 1})`;
      params.push(owner);
    }

    const { rows: leads } = await query(
      `SELECT l.id, l.first_name, l.last_name, l.property_address, l.city, l.zip, l.phone, l.email,
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