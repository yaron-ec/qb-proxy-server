/* eslint-disable no-undef */
/**
 * metaLeadMapper — Fetch and map Meta/Facebook leadgen data to CRM capture format.
 *
 * Called by the Meta webhook receiver to:
 *   1. Fetch the leadgen data from the Facebook Graph API
 *   2. Map the field_data array to the CRM capture payload
 *   3. Return a normalized lead object compatible with bookingService.createBooking
 *
 * Env: META_PAGE_ACCESS_TOKEN (or FACEBOOK_PAGE_ACCESS_TOKEN)
 *
 * Graph API: GET https://graph.facebook.com/v18.0/{leadgen_id}?access_token=...
 */
'use strict';

const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || 'v18.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function getAccessToken() {
  return process.env.META_PAGE_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '';
}

/**
 * Fetch leadgen data from the Graph API.
 * @param {string} leadgenId — The leadgen_id from the webhook payload
 * @returns {Promise<object|null>} — The leadgen data with field_data array
 */
async function fetchLeadgenData(leadgenId) {
  const token = getAccessToken();
  if (!token) throw new Error('META_PAGE_ACCESS_TOKEN not configured');

  const url = `${GRAPH_API_BASE}/${leadgenId}?access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph API fetch failed ${res.status}: ${text.substring(0, 300)}`);
  }
  return res.json();
}

/**
 * Extract a field value from the field_data array.
 * Meta field_data format: [{ name: 'first_name', values: ['John'] }, ...]
 */
function getField(fieldData, ...names) {
  if (!fieldData) return '';
  for (const name of names) {
    const field = fieldData.find(f => f.name === name);
    if (field && field.values && field.values.length > 0 && field.values[0]) {
      return String(field.values[0]).trim();
    }
  }
  return '';
}

/**
 * Map a Meta leadgen record to the CRM capture payload.
 * @param {object} leadgenData — The Graph API response
 * @param {object} defaults — Default values (owner_email, source, etc.)
 * @returns {object} — Normalized lead object for bookingService.createBooking
 */
function mapMetaLead(leadgenData, defaults = {}) {
  const fd = leadgenData.field_data || [];

  const first_name = getField(fd, 'first_name', 'FIRST_NAME', 'full_name').split(' ')[0] || '';
  const last_name = getField(fd, 'last_name', 'LAST_NAME').split(' ').slice(1).join(' ') || getField(fd, 'last_name', 'LAST_NAME') || '';
  const email = getField(fd, 'email', 'EMAIL');
  const phone = getField(fd, 'phone_number', 'PHONE', 'PHONE_NUMBER', 'MOBILE_PHONE', 'WORK_PHONE');
  const property_address = getField(fd, 'street_address', 'ADDRESS', 'PROPERTY_ADDRESS', 'STREET_ADDRESS');
  const city = getField(fd, 'city', 'CITY');
  const project_type = getField(fd, 'project_type', 'PROJECT_TYPE', 'WHAT_SERVICES_ARE_YOU_INTERESTED_IN', 'SERVICES');
  const message = getField(fd, 'message', 'MESSAGE', 'NOTES', 'COMMENTS', 'ADDITIONAL_COMMENTS');

  // Parse appointment date/time from Meta custom fields if present
  const appointment_date = getField(fd, 'appointment_date', 'APPOINTMENT_DATE', 'PREFERRED_DATE');
  const appointment_time = getField(fd, 'appointment_time', 'APPOINTMENT_TIME', 'PREFERRED_TIME');

  return {
    first_name,
    last_name,
    email,
    phone,
    property_address,
    city,
    project_type: project_type || 'Other',
    source: defaults.source || 'Instagram / Facebook',
    message: message || '',
    appointment_date: appointment_date || '',
    appointment_time: appointment_time || '09:00',
    owner_email: defaults.owner_email || 'yaron@ecconstructiongroup.com',
    assigned_rep: defaults.assigned_rep || 'Yaron Drilevich',
    photo_urls: [],
  };
}

module.exports = { fetchLeadgenData, mapMetaLead, getAccessToken };