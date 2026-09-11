/* eslint-disable no-undef */
/**
 * addressPipeline — THE ONE CANONICAL address ingestion + normalization service.
 *
 * Every source of Lead/address data MUST route address writes through
 * processAddress() before persisting to the leads table.
 */
'use strict';

const gmaps = require('./googleMapsClient');
const { query } = require('../db/client');

const SUFFIX_WORDS = new Set([
  'lane', 'ln', 'avenue', 'ave', 'street', 'st', 'boulevard', 'blvd',
  'drive', 'dr', 'road', 'rd', 'court', 'ct', 'place', 'pl', 'way',
  'circle', 'cir', 'terrace', 'ter', 'parkway', 'pkwy', 'highway', 'hwy',
  'trail', 'trl', 'square', 'sq', 'loop', 'alley', 'aly', 'row', 'run',
]);

function detectAndReconstruct(rawStreet, rawCity, rawState, rawZip) {
  let street = (rawStreet || '').trim();
  let city = (rawCity || '').trim();
  let state = (rawState || '').trim();
  let zip = (rawZip || '').trim();
  let malformed = false;

  // Case 1: City field starts with a street suffix word
  if (city) {
    const cityFirstToken = city.toLowerCase().split(/[\s,]/)[0];
    if (SUFFIX_WORDS.has(cityFirstToken)) {
      malformed = true;
      const commaParts = city.split(',').map(p => p.trim()).filter(Boolean);
      if (commaParts.length >= 2) {
        street = street + ' ' + commaParts[0];
        street = street.trim();
        city = commaParts.slice(1).join(', ');
      } else {
        const tokens = city.split(/\s+/);
        street = (street + ' ' + tokens[0]).trim();
        city = tokens.slice(1).join(' ');
      }
    }
  }

  // Case 3: Street field contains full address with commas
  if (street) {
    const commaParts = street.split(',').map(p => p.trim()).filter(Boolean);
    if (commaParts.length >= 3) {
      const lastPart = commaParts[commaParts.length - 1];
      const stateZipMatch = lastPart.match(/^([A-Za-z]{2})\s+(\d{5}(-\d{4})?)$/);
      if (stateZipMatch) {
        malformed = true;
        state = stateZipMatch[1].toUpperCase();
        zip = zip || stateZipMatch[2];
        city = city || commaParts[commaParts.length - 2];
        street = commaParts.slice(0, commaParts.length - 2).join(', ');
      }
    }
  }

  // Case 4: Concatenated street address (no spaces) — e.g., "12046riohondopkwy"
  // Insert spaces: after the leading street number, before the suffix word.
  // Google Maps can geocode "12046 riohondo pkwy" but not "12046riohondopkwy".
  if (street && !street.includes(' ') && !malformed) {
    const lowerStreet = street.toLowerCase();
    let bestSuffix = null;
    let bestIdx = -1;
    for (const suffix of SUFFIX_WORDS) {
      const idx = lowerStreet.lastIndexOf(suffix);
      if (idx > bestIdx) { bestSuffix = suffix; bestIdx = idx; }
    }
    if (bestSuffix && bestIdx > 0) {
      const beforeSuffix = street.substring(0, bestIdx);
      const suffixPart = street.substring(bestIdx, bestIdx + bestSuffix.length);
      const afterSuffix = street.substring(bestIdx + bestSuffix.length);
      const numMatch = beforeSuffix.match(/^(\d+)(.*)/);
      if (numMatch && numMatch[2]) {
        malformed = true;
        street = numMatch[1] + ' ' + numMatch[2] + ' ' + suffixPart + (afterSuffix ? ' ' + afterSuffix : '');
      }
    }
  }

  return { street, city, state, zip, malformed };
}

let _columnsEnsured = false;
async function ensureAddressColumns() {
  if (_columnsEnsured) return;
  try {
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS verified_property_address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lat DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_lng DOUBLE PRECISION');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS property_geocode_status TEXT DEFAULT \'pending\'');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS state TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_property_address TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS original_city TEXT');
    await query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS google_place_id TEXT');
    _columnsEnsured = true;
  } catch (e) {
    console.warn('[addressPipeline] ensureAddressColumns deferred:', e.message);
  }
}

async function processAddress(input) {
  const rawStreet = (input.street || '').trim();
  const rawCity = (input.city || '').trim();
  const rawState = (input.state || '').trim();
  const rawZip = (input.zip || '').trim();

  if (!rawStreet) {
    return {
      status: 'no_address',
      street: null, city: rawCity || null, state: rawState || null, zip: rawZip || null,
      verifiedAddress: null, lat: null, lng: null, placeId: null,
      originalStreet: null, originalCity: rawCity || null, malformed: false,
    };
  }

  const { street, city, state, zip, malformed } = detectAndReconstruct(
    rawStreet, rawCity, rawState, rawZip
  );

  const normalizedAddr = gmaps.normalizeAddress(street, city, state || 'CA');

  let coords = null;
  let geocodeError = null;
  try {
    coords = await gmaps.geocodeAddress(normalizedAddr);
  } catch (e) {
    geocodeError = e.message;
  }

  if (coords && coords.isHighConfidence && !coords.partialMatch) {
    const ac = coords.addressComponents || {};
    return {
      status: 'verified',
      street: ac.street || street,
      city: ac.city || city,
      state: ac.state || state || 'CA',
      zip: ac.zip || zip,
      verifiedAddress: coords.formattedAddress,
      lat: coords.lat,
      lng: coords.lng,
      placeId: coords.placeId || null,
      originalStreet: rawStreet,
      originalCity: rawCity,
      malformed,
    };
  }

  if (coords) {
    return {
      status: 'needs_review',
      street: rawStreet,
      city: rawCity,
      state: rawState || null,
      zip: rawZip || null,
      verifiedAddress: coords.formattedAddress,
      lat: coords.lat,
      lng: coords.lng,
      placeId: coords.placeId || null,
      originalStreet: rawStreet,
      originalCity: rawCity,
      malformed,
    };
  }

  if (geocodeError) {
    return {
      status: 'error',
      street: rawStreet, city: rawCity, state: rawState || null, zip: rawZip || null,
      verifiedAddress: null, lat: null, lng: null, placeId: null,
      originalStreet: rawStreet, originalCity: rawCity, malformed,
      error: geocodeError,
    };
  }

  return {
    status: 'not_found',
    street: rawStreet, city: rawCity, state: rawState || null, zip: rawZip || null,
    verifiedAddress: null, lat: null, lng: null, placeId: null,
    originalStreet: rawStreet, originalCity: rawCity, malformed,
  };
}

function buildAddressFieldMap(result, existingRow) {
  const fields = {};
  fields.property_address = result.street;
  fields.city = result.city;
  fields.state = result.state;
  fields.zip = result.zip;
  fields.verified_property_address = result.verifiedAddress;
  fields.property_lat = result.lat;
  fields.property_lng = result.lng;
  fields.google_place_id = result.placeId;
  fields.property_geocode_status = result.status === 'verified' ? 'verified' : result.status;

  if (result.originalStreet) {
    const hasOriginal = existingRow && existingRow.original_property_address;
    if (!hasOriginal) {
      fields.original_property_address = result.originalStreet;
    }
  }
  if (result.originalCity) {
    const hasOriginalCity = existingRow && existingRow.original_city;
    if (!hasOriginalCity) {
      fields.original_city = result.originalCity;
    }
  }
  return fields;
}

async function persistAddressForLead(leadId, result) {
  await ensureAddressColumns();
  try {
    const { rows } = await query(
      'SELECT original_property_address, original_city FROM leads WHERE id = $1',
      [leadId]
    );
    const existing = rows[0] || {};
    const fields = buildAddressFieldMap(result, existing);
    const cols = Object.keys(fields);
    const vals = cols.map(c => fields[c]);
    const setClause = cols.map((c, i) => c + ' = $' + (i + 1)).join(', ');
    await query(
      'UPDATE leads SET ' + setClause + ', updated_at = NOW() WHERE id = $' + (cols.length + 1),
      [...vals, leadId]
    );
  } catch (e) {
    console.warn('[addressPipeline] persist failed for lead ' + leadId + ':', e.message);
  }
}

module.exports = {
  processAddress,
  ensureAddressColumns,
  buildAddressFieldMap,
  persistAddressForLead,
  detectAndReconstruct,
};
