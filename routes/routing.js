/* eslint-disable no-undef */
/**
 * /api/v1/routing — Daily Appointment Routing subsystem.
 *
 *   GET  /api/v1/routing/daily-schedule?owner=...&date=...&city=...&project_type=...
 *        Returns the full daily schedule with traffic-aware travel times,
 *        required departure times, and schedule conflict detection.
 *
 *   POST /api/v1/routing/backfill-geocodes  (admin only)
 *        System-wide backfill: re-geocode all active leads with addresses
 *        through the corrected Google normalization/geocoding pipeline.
 *
 *   GET  /api/v1/routing/owner-config
 *        Returns owner starting locations configuration.
 *
 *   PUT  /api/v1/routing/owner-config  (admin only)
 *        Updates owner starting locations configuration.
 *
 * Auth: Railway JWT (requireAuth).
 *
 * Routing rules:
 *   - Appointments remain in scheduled time order (NOT rearranged for shorter route)
 *   - Target arrival = appointment start - 10 minutes
 *   - First appointment origin = owner's configured starting location
 *   - Subsequent origins = previous appointment address
 *   - Travel time from Google Routes API (traffic-aware, arrivalTime-based)
 *   - Required departure = target arrival - travel duration
 *   - Schedule conflict = required departure < previous appointment end time
 */
'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../lib/rbac');
const { query } = require('../db/client');
const gmaps = require('../lib/googleMapsClient');

const router = express.Router();
router.use(requireAuth);

const requireAdmin = requireRole('admin');

// ── Config: owner starting locations ────────────────────────────────────────

// Default starting locations. Yaron = Woodland Hills (EC Construction office).
// Other owners must be configured via PUT /owner-config.
const DEFAULT_OWNER_STARTS = {
  'Yaron Drilevich': {
    name: 'Woodland Hills Office',
    address: '23622 Calabasas Rd, Woodland Hills, CA 91367',
  },
};

async function getOwnerStarts() {
  try {
    const { rows } = await query("SELECT value FROM app_settings WHERE key = 'owner_starting_locations'");
    if (rows[0]?.value) return { ...DEFAULT_OWNER_STARTS, ...rows[0].value };
  } catch (e) { /* table may not exist yet */ }
  return DEFAULT_OWNER_STARTS;
}

// ── Database: lead_geocodes cache table ──────────────────────────────────────

async function ensureGeocodeTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS lead_geocodes (
        lead_id TEXT PRIMARY KEY,
        address_hash TEXT NOT NULL,
        normalized_address TEXT,
        verified_address TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        google_place_id TEXT,
        geocode_status TEXT DEFAULT 'pending',
        geocoded_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query('CREATE INDEX IF NOT EXISTS idx_lead_geocodes_hash ON lead_geocodes (address_hash)');
    // Add verified_address column to existing tables
    await query('ALTER TABLE lead_geocodes ADD COLUMN IF NOT EXISTS verified_address TEXT');
  } catch (e) {
    console.warn('[routing] lead_geocodes table creation deferred:', e.message);
  }
}

// Add geocode columns to the leads table so the verified address, coordinates,
// and verification status are persisted alongside the raw customer-entered
// property_address (which is preserved unchanged for audit).
async function ensureLeadsGeocodeColumns() {
  try {
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_property_address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lat DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lng DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_geocode_status TEXT DEFAULT \'pending\'');
    // Add state column — the leads table was created without it, but the CRM
    // ContactInfoEditor displays it. Address reconciliation populates it from
    // Google's verified address_components.
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS state TEXT');
    // Preserve the original raw address for audit/history before reconciliation overwrites it
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_property_address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_city TEXT');
  } catch (e) {
    console.warn('[routing] leads geocode columns creation deferred:', e.message);
  }
}

// Persist the Google-verified address, coordinates, and status to the leads
// table so every CRM page (Lead Detail, Daily Map, etc.) displays the
// canonical normalized address — not the raw customer-entered string.
async function persistVerifiedAddress(leadId, verifiedAddress, coords, status) {
  try {
    await query(
      `UPDATE leads SET
         verified_property_address = $1,
         property_lat = $2,
         property_lng = $3,
         property_geocode_status = $4
       WHERE id = $5`,
      [verifiedAddress || null, coords?.lat || null, coords?.lng || null, status, leadId]
    );
  } catch (e) {
    console.warn('[routing] persist verified address failed:', e.message);
  }
}

// Hash an address for cache key
function addrHash(addr) {
  return require('crypto').createHash('md5').update(addr.toLowerCase().trim()).digest('hex');
}

// Get cached geocode for a lead
async function getCachedGeocode(leadId, normalizedAddr) {
  try {
    const hash = addrHash(normalizedAddr);
    const r = await query(
      'SELECT * FROM lead_geocodes WHERE lead_id = $1 AND address_hash = $2 AND geocode_status = $3',
      [leadId, hash, 'ok']
    );
    if (r.rows[0]) {
      return {
        lat: r.rows[0].latitude,
        lng: r.rows[0].longitude,
        formattedAddress: r.rows[0].verified_address || r.rows[0].normalized_address,
        verifiedAddress: r.rows[0].verified_address,
        placeId: r.rows[0].google_place_id,
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Save geocode to cache (verifiedAddress = Google's formatted_address)
async function saveGeocode(leadId, normalizedAddr, coords, status, verifiedAddress) {
  try {
    const hash = addrHash(normalizedAddr);
    await query(
      `INSERT INTO lead_geocodes (lead_id, address_hash, normalized_address, verified_address, latitude, longitude, google_place_id, geocode_status, geocoded_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       ON CONFLICT (lead_id) DO UPDATE SET
         address_hash = $2, normalized_address = $3, verified_address = $4, latitude = $5, longitude = $6,
         google_place_id = $7, geocode_status = $8, geocoded_at = NOW(), updated_at = NOW()`,
      [leadId, hash, normalizedAddr, verifiedAddress || null, coords?.lat || null, coords?.lng || null, coords?.placeId || null, status]
    );
  } catch (e) {
    console.warn('[routing] geocode save failed:', e.message);
  }
}

// ── Time helpers ─────────────────────────────────────────────────────────────

// Convert "HH:MM" + "YYYY-MM-DD" to ISO UTC
// Input times are in America/Los_Angeles timezone
function timeToIso(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  // Parse as local time in Pacific timezone
  // dateStr = "2026-09-11", timeStr = "10:00"
  const dtStr = `${dateStr}T${timeStr}:00`;
  // Treat as America/Los_Angeles and convert to UTC
  // Use Intl to handle DST correctly
  const dt = new Date(dtStr + 'America/Los_Angeles'.replace('America/Los_Angeles', ''));
  // Actually, let's use a simpler approach: parse as local and adjust
  // The server might be in UTC, so we need to explicitly handle the timezone
  const tz = 'America/Los_Angeles';
  // Create a date in the LA timezone
  const date = new Date(dtStr);
  // Get the UTC offset for LA at this date (handles DST)
  // We'll use the fact that Date.parse with a timezone name doesn't work directly
  // Instead, use the format: "2026-09-11T10:00:00-07:00" (PDT) or "-08:00" (PST)
  // For simplicity, use the Intl API to get the offset
  const offsetMs = getLaOffsetMs(dateStr);
  const utcDate = new Date(date.getTime() - offsetMs);
  return utcDate.toISOString();
}

// Get the UTC offset for America/Los_Angeles on a given date (handles DST)
function getLaOffsetMs(dateStr) {
  // Use Intl.DateTimeFormat to get the timezone offset
  const dt = new Date(dateStr + 'T12:00:00Z');
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(dt);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  if (tzPart) {
    // Parse "GMT-7" or "GMT-08"
    const match = tzPart.value.match(/GMT([+-])(\d+)/);
    if (match) {
      const sign = match[1] === '+' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      return sign * hours * 3600 * 1000;
    }
  }
  // Fallback: PDT = -7 hours
  return -7 * 3600 * 1000;
}

// Convert ISO UTC to "HH:MM" in America/Los_Angeles
function isoToLaTime(iso) {
  if (!iso) return null;
  const dt = new Date(iso);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(dt);
  const h = parts.find(p => p.type === 'hour')?.value || '00';
  const m = parts.find(p => p.type === 'minute')?.value || '00';
  return `${h}:${m}`;
}

// Format seconds as "Xh Ym" or "X min"
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Format meters as miles
function formatDistance(meters) {
  if (!meters || meters <= 0) return '—';
  const miles = meters * 0.000621371;
  return `${miles.toFixed(1)} mi`;
}

// ── GET /daily-schedule ─────────────────────────────────────────────────────

router.get('/daily-schedule', async (req, res) => {
  try {
    await ensureGeocodeTable();
    await ensureLeadsGeocodeColumns();

    const { owner, date, city, project_type } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    // Check Google Maps configuration
    if (!gmaps.isConfigured()) {
      return res.status(503).json({
        error: 'google_maps_not_configured',
        message: 'Set GOOGLE_MAPS_API_KEY or GOOGLE_SERVICE_ACCOUNT_KEY on Railway to enable traffic-aware routing.',
      });
    }

    // Query the CANONICAL appointments table (source of truth for appointments).
    // Join to leads for address info. Filter by appointment status (not lead
    // status) — Lost/Sold leads with active appointments MUST appear.
    // follow_up_type = 'Meeting' filter excludes phone calls (no driving needed).
    // Also UNION legacy leads with follow_up_date but no appointments row.
    const offsetMs = getLaOffsetMs(date);
    const dayStartUtc = new Date(new Date(`${date}T00:00:00`).getTime() - offsetMs);
    const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);

    const params = [dayStartUtc.toISOString(), dayEndUtc.toISOString(), date];
    let apptWhere = `a.start_at >= $1::timestamptz AND a.start_at < $2::timestamptz AND a.status IN ('scheduled', 'confirmed') AND l.follow_up_type = 'Meeting'`;
    let legacyWhere = `l.follow_up_date = $3 AND l.follow_up_type = 'Meeting' AND NOT EXISTS (SELECT 1 FROM appointments a2 WHERE a2.lead_id = l.id AND a2.status IN ('scheduled', 'confirmed') AND a2.start_at >= $1::timestamptz AND a2.start_at < $2::timestamptz)`;

    if (owner && owner !== 'all') {
      if (owner === 'Unassigned') {
        apptWhere += ` AND a.owner_id IS NULL`;
        legacyWhere += ` AND l.owner_id IS NULL`;
      } else {
        apptWhere += ` AND (o.display_name = $${params.length + 1} OR o.email = $${params.length + 1})`;
        legacyWhere += ` AND (o.display_name = $${params.length + 1} OR o.email = $${params.length + 1})`;
        params.push(owner);
      }
    }
    if (city && city !== 'all') {
      apptWhere += ` AND LOWER(l.city) = LOWER($${params.length + 1})`;
      legacyWhere += ` AND LOWER(l.city) = LOWER($${params.length + 1})`;
      params.push(city);
    }
    if (project_type && project_type !== 'all') {
      apptWhere += ` AND LOWER(l.project_type) LIKE LOWER($${params.length + 1})`;
      legacyWhere += ` AND LOWER(l.project_type) LIKE LOWER($${params.length + 1})`;
      params.push(`%${project_type}%`);
    }

    const { rows: apptRows } = await query(
      `SELECT l.id, l.first_name, l.last_name, l.property_address, l.city, l.state, l.zip, l.phone, l.email,
              l.project_type, COALESCE(o.display_name, o.email) AS assigned_rep,
              l.follow_up_time, l.status,
              l.verified_property_address, l.property_lat, l.property_lng, l.property_geocode_status,
              a.start_at, a.id AS appointment_id
       FROM appointments a
       JOIN leads l ON l.id = a.lead_id
       LEFT JOIN owners o ON o.id = a.owner_id
       WHERE ${apptWhere}
       UNION
       SELECT l.id, l.first_name, l.last_name, l.property_address, l.city, l.state, l.zip, l.phone, l.email,
              l.project_type, COALESCE(o.display_name, o.email) AS assigned_rep,
              l.follow_up_time, l.status,
              l.verified_property_address, l.property_lat, l.property_lng, l.property_geocode_status,
              NULL AS start_at, NULL AS appointment_id
       FROM leads l
       LEFT JOIN owners o ON o.id = l.owner_id
       WHERE ${legacyWhere}
       ORDER BY start_at ASC NULLS LAST, follow_up_time ASC`,
      params
    );

    // Convert start_at to follow_up_time for display (appointments table uses TIMESTAMPTZ)
    const leads = apptRows.map(r => ({
      ...r,
      follow_up_time: r.start_at ? isoToLaTime(r.start_at) : r.follow_up_time,
      follow_up_date: date,
    }));

    if (leads.length === 0) {
      return res.json({ appointments: [], schedule: [], owner_config: await getOwnerStarts() });
    }

    // Get owner starting locations
    const ownerStarts = await getOwnerStarts();

    // Sort by time (ensure chronological order)
    leads.sort((a, b) => (a.follow_up_time || '23:59').localeCompare(b.follow_up_time || '23:59'));

    // Geocode all addresses — use cached coordinates from leads table when
    // available (skip re-geocoding already-verified addresses to prevent false
    // "needs review" flags on addresses that were already reconciled).
    const geocodePromises = leads.map(async (lead) => {
      const normalizedAddr = lead.verified_property_address || gmaps.normalizeAddress(lead.property_address, lead.city);

      // FAST PATH: leads table already has verified coordinates (from
      // reconciliation or prior geocoding). Use them directly — no Google
      // API call, no risk of a partial-match "needs_review" false positive.
      if (lead.property_lat && lead.property_lng) {
        return {
          ...lead,
          normalizedAddress: normalizedAddr,
          verifiedAddress: lead.verified_property_address || normalizedAddr,
          coords: { lat: lead.property_lat, lng: lead.property_lng },
          geocodeError: false,
          geocodeStatus: 'ok',
        };
      }

      // No cached coords on leads table — check geocode cache table
      let coords = await getCachedGeocode(lead.id, normalizedAddr);
      let geocodeStatus = 'ok';
      let geocodeError = false;
      let verifiedAddress = null;

      if (!coords) {
        // Geocode via Google
        try {
          coords = await gmaps.geocodeAddress(normalizedAddr);
          if (coords) {
            verifiedAddress = coords.formattedAddress || normalizedAddr;
            await saveGeocode(lead.id, normalizedAddr, coords, 'ok', verifiedAddress);
            await persistVerifiedAddress(lead.id, verifiedAddress, coords, 'verified');
          } else {
            geocodeError = true;
            geocodeStatus = 'not_found';
            await saveGeocode(lead.id, normalizedAddr, null, 'not_found', null);
            await persistVerifiedAddress(lead.id, null, null, 'not_found');
          }
        } catch (e) {
          geocodeError = true;
          geocodeStatus = 'error';
          console.warn(`[routing] Geocode failed for lead ${lead.id}:`, e.message);
        }
      } else {
        verifiedAddress = coords.verifiedAddress || coords.formattedAddress || normalizedAddr;
        await persistVerifiedAddress(lead.id, verifiedAddress, coords, 'verified');
      }

      return {
        ...lead,
        normalizedAddress: normalizedAddr,
        verifiedAddress: verifiedAddress || normalizedAddr,
        coords: coords || null,
        geocodeError,
        geocodeStatus,
      };
    });

    const geocoded = await Promise.all(geocodePromises);

    // Build the schedule with routing
    // ALWAYS calculate traffic-aware routing — for "all" owners, group by
    // owner and calculate a completely separate route for each owner.
    // NEVER chain one owner's appointments into another owner's route.
    const schedule = [];

    // Helper: build a chronological route for a single owner's appointments.
    // Appointments remain in scheduled time order (NOT rearranged).
    // Target arrival = appointment start - 10 minutes.
    // First appointment origin = owner's configured starting location.
    // Subsequent origins = previous appointment's verified address.
    // Travel time from Google Routes API (traffic-aware, arrivalTime-based).
    // Required departure = target arrival - travel duration.
    // Schedule conflict = required departure < previous appointment end time.
    async function buildOwnerRoute(ownerName, ownerAppts) {
      const ownerConfig = ownerStarts[ownerName];
      let prevEndTime = null;
      const ownerSchedule = [];

      for (let i = 0; i < ownerAppts.length; i++) {
        const appt = ownerAppts[i];
        const apptTimeIso = appt.start_at ? new Date(appt.start_at).toISOString() : timeToIso(date, appt.follow_up_time);
        const targetArrivalIso = apptTimeIso
          ? new Date(new Date(apptTimeIso).getTime() - 10 * 60 * 1000).toISOString()
          : null;

        let originAddr = null;
        let originName = null;
        if (i === 0) {
          if (ownerConfig?.address) {
            originAddr = gmaps.normalizeAddress(ownerConfig.address, '', 'CA');
            originName = ownerConfig.name || 'Starting Location';
          }
        } else {
          originAddr = ownerAppts[i - 1].verifiedAddress || ownerAppts[i - 1].normalizedAddress;
          originName = `${ownerAppts[i - 1].first_name} ${ownerAppts[i - 1].last_name}`;
        }

        let route = null;
        let departureIso = null;
        let conflict = null;

        if (originAddr && (appt.verifiedAddress || appt.normalizedAddress) && appt.coords && targetArrivalIso) {
          try {
            const routeDest = appt.verifiedAddress || appt.normalizedAddress;
            route = await gmaps.computeRoute(originAddr, routeDest, targetArrivalIso);
            if (route?.durationSeconds > 0) {
              const departureMs = new Date(targetArrivalIso).getTime() - route.durationSeconds * 1000;
              departureIso = new Date(departureMs).toISOString();
              if (prevEndTime && departureMs < new Date(prevEndTime).getTime()) {
                conflict = {
                  type: 'schedule_conflict',
                  message: `Must leave by ${isoToLaTime(departureIso)} but previous appointment ends at ${isoToLaTime(prevEndTime)}`,
                  requiredDeparture: isoToLaTime(departureIso),
                  prevEndsAt: isoToLaTime(prevEndTime),
                };
              }
            }
          } catch (e) {
            console.warn(`[routing] Route computation failed for ${ownerName} segment ${i}:`, e.message);
            route = { error: e.message };
          }
        }

        prevEndTime = apptTimeIso
          ? new Date(new Date(apptTimeIso).getTime() + 60 * 60 * 1000).toISOString()
          : null;

        ownerSchedule.push({
          ...appt,
          index: i + 1,
          owner: ownerName,
          originName,
          originAddress: originAddr,
          targetArrival: isoToLaTime(targetArrivalIso),
          targetArrivalIso: targetArrivalIso,
          requiredDeparture: isoToLaTime(departureIso),
          requiredDepartureIso: departureIso,
          driveDuration: route ? formatDuration(route.durationSeconds) : '—',
          driveDurationSeconds: route?.durationSeconds || 0,
          driveDistance: route ? formatDistance(route.distanceMeters) : '—',
          driveDistanceMeters: route?.distanceMeters || 0,
          conflict,
          routeError: route?.error || null,
          startingLocationRequired: (!ownerConfig?.address && i === 0) ? true : false,
        });
      }
      return ownerSchedule;
    }

    if (owner && owner !== 'all') {
      // Single owner: calculate route for that owner only
      const ownerSchedule = await buildOwnerRoute(owner, geocoded);
      schedule.push(...ownerSchedule);
    } else {
      // "all" owners: group by owner, calculate separate route for each.
      // NEVER chain one owner's appointments into another owner's route.
      const byOwner = {};
      for (const appt of geocoded) {
        const o = appt.assigned_rep || 'Unassigned';
        if (!byOwner[o]) byOwner[o] = [];
        byOwner[o].push(appt);
      }
      // Sort each owner's appointments chronologically and build separate routes
      for (const o of Object.keys(byOwner)) {
        byOwner[o].sort((a, b) => (a.follow_up_time || '23:59').localeCompare(b.follow_up_time || '23:59'));
        const ownerSchedule = await buildOwnerRoute(o, byOwner[o]);
        schedule.push(...ownerSchedule);
      }
      // Sort the combined schedule by time for display
      schedule.sort((a, b) => (a.follow_up_time || '23:59').localeCompare(b.follow_up_time || '23:59'));
    }

    res.json({
      appointments: schedule,
      schedule,
      owner_config: ownerStarts,
      google_maps_configured: gmaps.isConfigured(),
    });
  } catch (e) {
    console.error('[routing] daily-schedule error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /backfill-geocodes ──────────────────────────────────────────────────

router.post('/backfill-geocodes', requireAdmin, async (req, res) => {
  try {
    await ensureGeocodeTable();
    await ensureLeadsGeocodeColumns();

    if (!gmaps.isConfigured()) {
      return res.status(503).json({
        error: 'google_maps_not_configured',
        message: 'Set GOOGLE_MAPS_API_KEY or GOOGLE_SERVICE_ACCOUNT_KEY on Railway.',
      });
    }

    // Clear ALL stale geocode errors so they get re-geocoded with the fixed
    // normalization pipeline. Only entries with geocode_status = 'ok' are
    // kept as cache; everything else is deleted and re-processed.
    await query(`DELETE FROM lead_geocodes WHERE geocode_status != 'ok'`);
    // Also reset leads that were previously marked as geocode errors
    await query(`UPDATE leads SET property_geocode_status = 'pending' WHERE property_geocode_status IN ('not_found', 'error', 'pending') OR property_geocode_status IS NULL`);

    // Fetch all leads with addresses that need geocoding
    const { rows: leads } = await query(`
      SELECT id, property_address, city
      FROM leads
      WHERE property_address IS NOT NULL AND property_address != ''
      ORDER BY created_at DESC
      LIMIT 500
    `);

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const lead of leads) {
      const normalizedAddr = gmaps.normalizeAddress(lead.property_address, lead.city);

      // Check if already cached with this address hash
      const cached = await getCachedGeocode(lead.id, normalizedAddr);
      if (cached) {
        // Persist the cached verified address to the leads table
        const verifiedAddr = cached.verifiedAddress || cached.formattedAddress || normalizedAddr;
        await persistVerifiedAddress(lead.id, verifiedAddr, cached, 'verified');
        skipped++;
        continue;
      }

      try {
        const coords = await gmaps.geocodeAddress(normalizedAddr);
        if (coords) {
          const verifiedAddr = coords.formattedAddress || normalizedAddr;
          await saveGeocode(lead.id, normalizedAddr, coords, 'ok', verifiedAddr);
          await persistVerifiedAddress(lead.id, verifiedAddr, coords, 'verified');
          success++;
        } else {
          await saveGeocode(lead.id, normalizedAddr, null, 'not_found', null);
          await persistVerifiedAddress(lead.id, null, null, 'not_found');
          failed++;
        }
      } catch (e) {
        await saveGeocode(lead.id, normalizedAddr, null, 'error', null);
        await persistVerifiedAddress(lead.id, null, null, 'error');
        failed++;
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    res.json({
      total: leads.length,
      success,
      failed,
      skipped,
      message: `Geocoded ${success} new, skipped ${skipped} cached, ${failed} failed`,
    });
  } catch (e) {
    console.error('[routing] backfill error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /reconcile-addresses ────────────────────────────────────────────────
// System-wide address reconciliation: for each lead with a property_address,
// reconstruct the full address, geocode with Google, and if Google returns a
// high-confidence unambiguous match, split the verified result back into
// Street / City / State / ZIP and persist to the leads table.
// Ambiguous records are marked 'needs_review' and left untouched.
// Original raw values are preserved in original_property_address / original_city.
router.post('/reconcile-addresses', requireAdmin, async (req, res) => {
  try {
    await ensureGeocodeTable();
    await ensureLeadsGeocodeColumns();

    if (!gmaps.isConfigured()) {
      return res.status(503).json({
        error: 'google_maps_not_configured',
        message: 'Set GOOGLE_MAPS_API_KEY on Railway.',
      });
    }

    // If lead_id is provided, process ONLY that lead (ignoring status filter).
    // Otherwise, fetch all leads with addresses that haven't been reconciled yet.
    // NOTE: Lead sales status (Lost, Sold, etc.) is independent business state and
    // must NEVER be mutated by reconciliation/routing. Address reconciliation covers
    // ALL leads regardless of sales status.
    const { lead_id } = req.body || {};
    let leads;
    if (lead_id) {
      leads = (await query(`
        SELECT id, property_address, city, state, zip,
               verified_property_address, property_geocode_status,
               original_property_address, original_city
        FROM leads
        WHERE id = $1 AND property_address IS NOT NULL AND property_address != ''
      `, [lead_id])).rows;
    } else {
      leads = (await query(`
        SELECT id, property_address, city, state, zip,
               verified_property_address, property_geocode_status,
               original_property_address, original_city
        FROM leads
        WHERE property_address IS NOT NULL AND property_address != ''
          AND (property_geocode_status IS NULL OR property_geocode_status NOT IN ('reconciled', 'needs_review'))
        ORDER BY created_at DESC
        LIMIT 500
      `)).rows;
    }

    let reconciled = 0;
    let needsReview = 0;
    let failed = 0;
    let skipped = 0;
    const errors = [];

    for (const lead of leads) {
      try {
        // Reconstruct the full address from raw fields
        const normalizedAddr = gmaps.normalizeAddress(lead.property_address, lead.city);

        // Geocode with Google (bypass cache — we need address_components)
        const coords = await gmaps.geocodeAddress(normalizedAddr);

        if (!coords) {
          await query('UPDATE leads SET property_geocode_status = $1 WHERE id = $2', ['needs_review', lead.id]);
          needsReview++;
          continue;
        }

        // Only auto-correct when Google returns a high-confidence unambiguous match
        if (!coords.isHighConfidence || coords.partialMatch) {
          // Persist verified address + coords but don't overwrite the raw fields
          await persistVerifiedAddress(lead.id, coords.formattedAddress, coords, 'needs_review');
          needsReview++;
          continue;
        }

        const { street, city, state, zip } = coords.addressComponents;

        // Preserve original raw values (only if not already preserved)
        const updates = [];
        const params = [];
        let paramIdx = 1;

        if (!lead.original_property_address && lead.property_address) {
          updates.push(`original_property_address = $${paramIdx++}`);
          params.push(lead.property_address);
        }
        if (!lead.original_city && lead.city) {
          updates.push(`original_city = $${paramIdx++}`);
          params.push(lead.city);
        }

        // Overwrite with Google-verified components
        updates.push(`property_address = $${paramIdx++}`);
        params.push(street);
        updates.push(`city = $${paramIdx++}`);
        params.push(city);
        updates.push(`state = $${paramIdx++}`);
        params.push(state);
        updates.push(`zip = $${paramIdx++}`);
        params.push(zip);
        updates.push(`verified_property_address = $${paramIdx++}`);
        params.push(coords.formattedAddress);
        updates.push(`property_lat = $${paramIdx++}`);
        params.push(coords.lat);
        updates.push(`property_lng = $${paramIdx++}`);
        params.push(coords.lng);
        updates.push(`property_geocode_status = $${paramIdx++}`);
        params.push('reconciled');

        params.push(lead.id);

        await query(
          `UPDATE leads SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
          params
        );

        // Also update the geocode cache with the reconcled address
        await saveGeocode(lead.id, normalizedAddr, coords, 'ok', coords.formattedAddress);

        reconciled++;
      } catch (e) {
        console.warn(`[routing] reconcile failed for lead ${lead.id}:`, e.message);
        errors.push(`${lead.id}: ${e.message}`);
        failed++;
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    res.json({
      total: leads.length,
      reconciled,
      needs_review: needsReview,
      failed,
      skipped,
      message: `Reconciled ${reconciled}, ${needsReview} need review, ${failed} failed`,
      errors: errors.slice(0, 10),
    });
  } catch (e) {
    console.error('[routing] reconcile-addresses error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /owner-config ────────────────────────────────────────────────────────

router.get('/owner-config', async (req, res) => {
  try {
    const starts = await getOwnerStarts();
    res.json({ owner_starts: starts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /owner-config ────────────────────────────────────────────────────────

router.put('/owner-config', requireAdmin, async (req, res) => {
  try {
    const { owner_starts } = req.body;
    if (!owner_starts || typeof owner_starts !== 'object') {
      return res.status(400).json({ error: 'owner_starts object required' });
    }

    // Merge with defaults (don't allow removing defaults)
    const merged = { ...DEFAULT_OWNER_STARTS, ...owner_starts };

    await query(
      `INSERT INTO app_settings (key, value, type) VALUES ('owner_starting_locations', $1, 'json')
       ON CONFLICT (key) DO UPDATE SET value = $1, type = 'json'`,
      [JSON.stringify(merged)]
    );

    res.json({ owner_starts: merged });
  } catch (e) {
    console.error('[routing] owner-config update error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;