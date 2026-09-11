/* eslint-disable no-undef */
/**
 * googleMapsClient — Google Maps Platform client for traffic-aware routing
 * and geocoding. Used by the Daily Appointment Map routing subsystem.
 *
 * AUTH: Prefers GOOGLE_MAPS_API_KEY (simplest, works with all Maps APIs).
 * Falls back to GOOGLE_SERVICE_ACCOUNT_KEY with OAuth token (scope:
 * maps-platform.routes) — works with the Routes API but NOT the Geocoding API.
 *
 * APIs used:
 *   - Routes API (v2): POST /directions/v2:computeRoutes
 *     Supports arrivalTime for traffic-aware backward routing.
 *   - Geocoding API: GET /maps/api/geocode/json (API key only)
 *
 * Address normalization handles malformed CRM addresses (commas in street
 * names, missing ZIP, full-word suffixes) and produces a canonical format
 * before geocoding.
 */
'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ROUTES_SCOPE = 'https://www.googleapis.com/auth/maps-platform.routes';
const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

let _oauthToken = null;
let _oauthExp = 0;

// ── Address Normalization ────────────────────────────────────────────────────

const SUFFIX_MAP = {
  'lane': 'Ln', 'ln': 'Ln',
  'avenue': 'Ave', 'ave': 'Ave',
  'street': 'St', 'st': 'St',
  'boulevard': 'Blvd', 'blvd': 'Blvd',
  'drive': 'Dr', 'dr': 'Dr',
  'road': 'Rd', 'rd': 'Rd',
  'court': 'Ct', 'ct': 'Ct',
  'place': 'Pl', 'pl': 'Pl',
  'way': 'Way',
  'circle': 'Cir', 'cir': 'Cir',
  'terrace': 'Ter', 'ter': 'Ter',
  'parkway': 'Pkwy', 'pkwy': 'Pkwy',
  'highway': 'Hwy', 'hwy': 'Hwy',
  'trail': 'Trl', 'trl': 'Trl',
  'square': 'Sq', 'sq': 'Sq',
  'loop': 'Loop',
  'alley': 'Aly', 'aly': 'Aly',
};

const UNIT_PREFIXES = ['apt', 'apartment', 'ste', 'suite', 'unit', 'bldg', 'building', 'fl', 'floor', '#'];

/**
 * Normalize a raw CRM address into canonical US format.
 * "14572 Fountain Brook, Lane, Corona, CA" → "14572 Fountain Brook Ln, Corona, CA"
 * "12004 W Ayres Ave, Los Angeles, CA" → "12004 W Ayres Ave, Los Angeles, CA"
 */
function normalizeAddress(rawAddress, rawCity, rawState) {
  if (!rawAddress) return '';
  let s = String(rawAddress).trim();

  // Step 1: Remove commas that appear before a street suffix
  // "Fountain Brook, Lane" → "Fountain Brook Lane"
  const suffixWords = Object.keys(SUFFIX_MAP).join('|');
  s = s.replace(new RegExp(`,\\s*(${suffixWords})\\b`, 'gi'), ' $1');

  // Step 2: Collapse multiple spaces/commas
  s = s.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').trim();

  // Step 3: Parse into street, city, state, zip
  // Try to split by comma first
  let street = s;
  let city = rawCity || '';
  let state = rawState || 'CA';
  let zip = '';

  // If the address itself contains commas, split them
  const commaParts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    street = commaParts[0];
    // If the raw address had city/state embedded, extract them
    if (!rawCity && commaParts.length >= 2) city = commaParts[1];
    if (!rawState && commaParts.length >= 3) {
      const stateZip = commaParts[2];
      const stateMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)?$/i);
      if (stateMatch) {
        state = stateMatch[1].toUpperCase();
        zip = stateMatch[2] || '';
      }
    }
    if (commaParts.length >= 4 && !zip) {
      const zipPart = commaParts[commaParts.length - 1];
      const zipMatch = zipPart.match(/(\d{5}(-\d{4})?)/);
      if (zipMatch) zip = zipMatch[1];
    }
  }

  // Also try to extract ZIP from the end of the last part
  if (!zip) {
    const zipMatch = s.match(/\b(\d{5}(-\d{4})?)\b/);
    if (zipMatch) zip = zipMatch[1];
  }

  // Step 4: Normalize the street suffix
  street = normalizeStreetSuffix(street);

  // Step 5: Normalize state to 2-letter
  state = normalizeState(state);

  // Step 5.5: Strip state abbreviation from city ("Corona Ca" → "Corona")
  city = stripStateFromCity(city);

  // Step 6: Build canonical format
  const parts = [street];
  if (city) parts.push(city);
  const stateZip = [state, zip].filter(Boolean).join(' ');
  if (stateZip) parts.push(stateZip);
  return parts.join(', ');
}

function normalizeStreetSuffix(street) {
  if (!street) return '';
  // Tokenize and replace full-word suffixes with abbreviations
  const tokens = street.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const lower = tokens[i].toLowerCase().replace(/[.,]/g, '');
    if (SUFFIX_MAP[lower]) {
      tokens[i] = SUFFIX_MAP[lower];
      break; // Only replace the last suffix
    }
  }
  return tokens.join(' ');
}

function normalizeState(state) {
  if (!state) return 'CA';
  const s = state.trim().toUpperCase();
  if (s.length === 2) return s;
  const stateNames = {
    'CALIFORNIA': 'CA', 'OREGON': 'OR', 'WASHINGTON': 'WA', 'NEVADA': 'NV',
    'ARIZONA': 'AZ', 'TEXAS': 'TX', 'NEW YORK': 'NY', 'FLORIDA': 'FL',
    'ILLINOIS': 'IL', 'COLORADO': 'CO',
  };
  return stateNames[s] || s.slice(0, 2);
}

// Strip a trailing state abbreviation from a city string.
// "Corona Ca" → "Corona", "Los Angeles, CA" → "Los Angeles"
const US_STATE_CODES = new Set([
  'CA','NY','TX','NV','AZ','OR','WA','FL','IL','CO','NJ','PA','OH','MI','GA',
  'NC','VA','MA','MD','MN','WI','IN','TN','MO','CT','UT','NM','ID','MT','WY',
  'OK','AR','LA','MS','AL','SC','WV','KY','IA','NE','KS','ND','SD','DE','RI',
  'NH','VT','ME','AK','HI','DC',
]);

function stripStateFromCity(city) {
  if (!city) return '';
  let c = city.trim();
  // Remove ", STATE" suffix (e.g., "Corona, CA" → "Corona")
  c = c.replace(/,\s*[A-Za-z]{2}\s*$/, '').trim();
  // Remove " STATE" suffix — only if the last word is a known 2-letter state code
  c = c.replace(/\s+([A-Za-z]{2})$/, (match, code) => {
    return US_STATE_CODES.has(code.toUpperCase()) ? '' : match;
  }).trim();
  return c;
}

// ── Authentication ────────────────────────────────────────────────────────────

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

async function getOauthToken() {
  const now = Date.now();
  if (_oauthToken && _oauthExp > now + 10000) return _oauthToken;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;

  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;

    const iat = Math.floor(now / 1000);
    const exp = iat + 3600;
    const claim = { iss: sa.client_email, scope: ROUTES_SCOPE, aud: TOKEN_URL, iat, exp };
    const header = { alg: 'RS256', typ: 'JWT' };
    const signingInput = `${b64url(header)}.${b64url(claim)}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    sign.end();
    const signature = sign.sign(sa.private_key, 'base64url');
    const assertion = `${signingInput}.${signature}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const data = await res.json();
    if (!data.access_token) return null;

    _oauthToken = data.access_token;
    _oauthExp = now + (data.expires_in || 3600) * 1000;
    return _oauthToken;
  } catch (e) {
    console.warn('[googleMaps] OAuth token failed:', e.message);
    return null;
  }
}

function getApiKey() {
  return process.env.GOOGLE_MAPS_API_KEY || null;
}

function isConfigured() {
  return !!(getApiKey() || process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
}

// ── Geocoding ─────────────────────────────────────────────────────────────────

/**
 * Geocode an address using Google Geocoding API (API key) or Routes API (OAuth).
 * Returns { lat, lng, formattedAddress, placeId } or null.
 */
async function geocodeAddress(address) {
  if (!address) return null;
  const apiKey = getApiKey();

  // Prefer Geocoding API with API key (returns formatted address + placeId)
  if (apiKey) {
    try {
      const url = `${GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Geocoding API HTTP ${res.status}`);
      const data = await res.json();
      if (data.status === 'OK' && data.results?.[0]) {
        const r = data.results[0];
        return {
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
          formattedAddress: r.formatted_address,
          placeId: r.place_id,
        };
      }
      // Google returned an error status (ZERO_RESULTS, INVALID_REQUEST, etc.)
      console.warn(`[googleMaps] Geocoding API status: ${data.status} for "${address}"`);
      return null;
    } catch (e) {
      console.warn('[googleMaps] Geocoding API failed:', e.message);
    }
  }

  // Fall back to Routes API with geocodeWaypoints (OAuth)
  const token = await getOauthToken();
  if (token) {
    try {
      const body = {
        origin: { address },
        destination: { address },
        travelMode: 'DRIVE',
        geocodeWaypoints: true,
        computeAlternativeRoutes: false,
      };
      const res = await fetch(ROUTES_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Goog-FieldMask': 'geocodingResults',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(`[googleMaps] Routes API geocode HTTP ${res.status}: ${errText.slice(0, 200)}`);
        return null;
      }
      const data = await res.json();
      const geo = data.geocodingResults?.[0];
      if (geo?.geocodedWaypoint?.location?.latLng) {
        return {
          lat: geo.geocodedWaypoint.location.latLng.latitude,
          lng: geo.geocodedWaypoint.location.latLng.longitude,
          formattedAddress: null,
          placeId: geo.geocodedWaypoint.placeId || null,
        };
      }
      return null;
    } catch (e) {
      console.warn('[googleMaps] Routes API geocode failed:', e.message);
    }
  }

  return null;
}

// ── Route Computation (traffic-aware) ────────────────────────────────────────

/**
 * Compute a traffic-aware route from origin to destination, arriving at
 * the specified arrivalTime. Returns { durationSeconds, distanceMeters }.
 *
 * Uses Google Routes API (v2) with routingPreference: TRAFFIC_AWARE and
 * arrivalTime set to the target arrival. The API calculates the backward
 * route and returns the traffic-aware duration. The caller then computes:
 *   departure = arrivalTime - duration
 */
async function computeRoute(originAddr, destAddr, arrivalTimeIso) {
  const apiKey = getApiKey();
  const token = await getOauthToken();

  if (!apiKey && !token) {
    throw new Error('Google Maps not configured — set GOOGLE_MAPS_API_KEY or GOOGLE_SERVICE_ACCOUNT_KEY');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-Goog-Api-Key'] = apiKey;
  } else {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // Field mask: request only the fields we need (reduces cost)
  headers['X-Goog-FieldMask'] = 'routes.duration,routes.distanceMeters,routes.legs.startLocation,routes.legs.endLocation';

  const body = {
    origin: { address: originAddr },
    destination: { address: destAddr },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: false,
  };

  // Set arrivalTime so Google calculates the route backward (traffic-aware)
  if (arrivalTimeIso) {
    body.arrivalTime = arrivalTimeIso;
  }

  const res = await fetch(ROUTES_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Routes API HTTP ${res.status}: ${errText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const route = data.routes?.[0];
  if (!route) return null;

  // Parse duration: "1800s" → 1800 seconds
  const durationStr = route.duration || '';
  const durationSeconds = parseInt(durationStr, 10) || 0;
  const distanceMeters = route.distanceMeters || 0;

  // Extract geocoded coordinates from legs
  const startLoc = route.legs?.[0]?.startLocation?.latLng;
  const endLoc = route.legs?.[0]?.endLocation?.latLng;

  return {
    durationSeconds,
    distanceMeters,
    originCoords: startLoc ? { lat: startLoc.latitude, lng: startLoc.longitude } : null,
    destCoords: endLoc ? { lat: endLoc.latitude, lng: endLoc.longitude } : null,
  };
}

module.exports = {
  normalizeAddress,
  stripStateFromCity,
  geocodeAddress,
  computeRoute,
  isConfigured,
  getOauthToken,
  getApiKey,
};