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

    // Query appointments for this date
    const excluded = ['Lost', 'DNQ', 'Cancelled', 'Closed Lost'];
    let whereClause = `follow_up_date = $1 AND follow_up_type = 'Meeting' AND (status IS NULL OR status = '' OR status NOT IN (${excluded.map((s, i) => `$${i + 2}`).join(',')}))`;
    const params = [date, ...excluded];
    if (owner && owner !== 'all') {
      whereClause += ` AND assigned_rep = $${params.length + 1}`;
      params.push(owner);
    }

    const { rows: leads } = await query(
      `SELECT id, first_name, last_name, property_address, city, state, phone, email,
              project_type, assigned_rep, follow_up_date, follow_up_time, status,
              verified_property_address, property_lat, property_lng, property_geocode_status
       FROM leads WHERE ${whereClause}
       ORDER BY follow_up_time ASC`,
      params
    );

    // For each lead, show the normalization and geocoding details
    const details = [];
    for (const lead of leads) {
      const normalizedAddr = gmaps.normalizeAddress(lead.property_address, lead.city, lead.state);
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

module.exports = router;