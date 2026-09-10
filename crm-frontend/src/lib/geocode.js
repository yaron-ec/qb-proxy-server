/**
 * Geocoding subsystem — system-wide address normalization, geocoding, and caching.
 *
 * Primary geocoder: US Census Geocoder (free, no API key, USPS data — comprehensive US coverage)
 * Fallback geocoder: Nominatim/OpenStreetMap (for non-US or edge cases)
 *
 * Key features:
 * - Address normalization (removes accidental commas inside street names)
 * - Client-side cache (localStorage) — avoids re-geocoding the same address
 * - Re-geocodes when the address actually changes (cache key = normalized address)
 * - Does NOT overwrite the customer's stored address — normalization is for geocoding only
 * - Retry with fallback if the primary geocoder fails
 */

// ── Address Normalization ────────────────────────────────────────────────────

// Street suffixes that may be accidentally separated by a comma.
// e.g., "14572 Fountain Brook, Lane" → "14572 Fountain Brook Lane"
const STREET_SUFFIXES = [
  'Lane', 'Ln',
  'Avenue', 'Ave',
  'Street', 'St',
  'Boulevard', 'Blvd',
  'Drive', 'Dr',
  'Road', 'Rd',
  'Court', 'Ct',
  'Place', 'Pl',
  'Way',
  'Circle', 'Cir',
  'Terrace', 'Ter',
  'Parkway', 'Pkwy',
  'Highway', 'Hwy',
  'Trail', 'Trl',
  'Square', 'Sq',
  'Loop',
  'Alley', 'Aly',
  'Apartment', 'Apt',
  'Building', 'Bldg',
  'Floor', 'Fl',
  'Suite', 'Ste',
  'Unit',
];

const SUFFIX_PATTERN = new RegExp(
  `,\\s*(${STREET_SUFFIXES.join('|')})\\b`,
  'gi'
);

/**
 * Normalize a street address by removing accidental commas before street suffixes.
 * "14572 Fountain Brook, Lane" → "14572 Fountain Brook Lane"
 * Does NOT change the stored lead address — only used for geocoding + display.
 */
export function normalizeStreetAddress(street) {
  if (!street) return '';
  let s = street.trim();
  // Remove commas that appear before a street suffix
  // "Fountain Brook, Lane" → "Fountain Brook Lane"
  s = s.replace(SUFFIX_PATTERN, ' $1');
  // Also handle "St, " or "Ave, " at the end before city — but only if followed by
  // something that looks like a city (not another street suffix)
  // e.g., "114 W Mariposa St, Altadena" should stay as "114 W Mariposa St, Altadena"
  // (This is handled by the caller splitting property_address from city.)
  // Collapse multiple spaces
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Build a full normalized address string from lead components.
 * @param {string} propertyAddress - raw street address from lead
 * @param {string} city - city
 * @param {string} state - state abbreviation (defaults to CA)
 * @returns {string} normalized full address "123 Main St, City, CA"
 */
export function buildFullAddress(propertyAddress, city, state) {
  const normalizedStreet = normalizeStreetAddress(propertyAddress);
  const parts = [normalizedStreet, city, state || 'CA'].filter(Boolean);
  return parts.join(', ');
}

// ── Geocoders ────────────────────────────────────────────────────────────────

/**
 * US Census Geocoder — primary geocoder.
 * Free, no API key, uses USPS data. Covers all US addresses.
 * Handles malformed input (commas in street names) gracefully.
 */
async function censusGeocode(address) {
  const params = new URLSearchParams({
    address: address,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params.toString()}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Census geocoder HTTP ${res.status}`);
  const data = await res.json();
  const matches = data?.result?.addressMatches || [];
  if (matches.length > 0) {
    const m = matches[0];
    return {
      lat: parseFloat(m.coordinates.y),
      lng: parseFloat(m.coordinates.x),
      matchedAddress: m.matchedAddress,
      source: 'census',
    };
  }
  return null;
}

/**
 * Nominatim/OpenStreetMap — fallback geocoder.
 * Used when Census Geocoder fails or for non-US addresses.
 */
async function nominatimGeocode(address) {
  const params = new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
    'accept-language': 'en',
  });
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  if (data?.length > 0) {
    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      matchedAddress: data[0].display_name,
      source: 'nominatim',
    };
  }
  return null;
}

// ── Client-side Cache ────────────────────────────────────────────────────────

const CACHE_KEY = 'ec-geocode-cache-v1';
const CACHE_TTL_SUCCESS = 30 * 24 * 60 * 60 * 1000; // 30 days for successful geocodes
const CACHE_TTL_FAILURE = 5 * 60 * 1000;            // 5 minutes for failed geocodes (allows retry)

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    // Prune expired entries to prevent unbounded growth
    const now = Date.now();
    for (const key of Object.keys(cache)) {
      const entry = cache[key];
      const ttl = entry.coords ? CACHE_TTL_SUCCESS : CACHE_TTL_FAILURE;
      if (now - entry.timestamp > ttl) {
        delete cache[key];
      }
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable — silently skip caching
  }
}

// ── Main Geocoding Function ──────────────────────────────────────────────────

/**
 * Geocode an address with normalization, caching, and fallback.
 *
 * @param {string} propertyAddress - raw street address (may contain commas)
 * @param {string} city - city name
 * @param {string} state - state abbreviation (defaults to CA)
 * @returns {Promise<{lat:number, lng:number, matchedAddress:string, source:string, fullAddress:string, fromCache:boolean}|null>}
 *   Returns null if both geocoders fail to find the address.
 */
export async function geocodeWithCache(propertyAddress, city, state) {
  const fullAddress = buildFullAddress(propertyAddress, city, state);

  // Check cache
  const cache = loadCache();
  const cacheKey = fullAddress.toLowerCase();
  const cached = cache[cacheKey];
  if (cached) {
    const ttl = cached.coords ? CACHE_TTL_SUCCESS : CACHE_TTL_FAILURE;
    if (Date.now() - cached.timestamp < ttl) {
      if (cached.coords) {
        return { ...cached.coords, fullAddress, fromCache: true };
      }
      // Cached failure — return null but don't re-try (within TTL)
      return null;
    }
  }

  // Try Census Geocoder first (most comprehensive for US addresses)
  let coords = null;
  try {
    coords = await censusGeocode(fullAddress);
  } catch {
    // Census failed — fall through to Nominatim
  }

  // Fallback to Nominatim
  if (!coords) {
    try {
      coords = await nominatimGeocode(fullAddress);
    } catch {
      // Both failed
    }
  }

  // Cache the result
  if (coords) {
    cache[cacheKey] = { coords, timestamp: Date.now() };
  } else {
    // Cache failure with short TTL to allow retry without hammering
    cache[cacheKey] = { coords: null, timestamp: Date.now() };
  }
  saveCache(cache);

  return coords ? { ...coords, fullAddress, fromCache: false } : null;
}

/**
 * Clear the geocode cache for a specific address (or all if no address given).
 * Called when an address is edited to force re-geocoding.
 */
export function clearGeocodeCache(address) {
  const cache = loadCache();
  if (address) {
    const normalized = buildFullAddress(address.propertyAddress, address.city, address.state);
    delete cache[normalized.toLowerCase()];
  } else {
    for (const key of Object.keys(cache)) delete cache[key];
  }
  saveCache(cache);
}