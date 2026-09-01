/* eslint-disable no-undef */
/**
 * captureValidation — pure, DB-free validation + normalization for the public
 * Lead Capture submission. Extracted so it can be unit-tested without a DB.
 *
 * Ports the normalization rules from base44/functions/submitLeadCapture
 * (phone/email/name/address) so Railway capture leads match CRM conventions.
 *
 * Owner resolution: an assigned_rep name resolves to <first>@ecconstructiongroup.com.
 * Only @ecconstructiongroup.com owners are accepted (safety whitelist — no
 * arbitrary internal owner IDs from a public form).
 */
'use strict';

const crypto = require('crypto');
const { toUtcIso } = require('./booking/slotBlocking');

const EC_DOMAIN = 'ecconstructiongroup.com';
const MAX_FIELD = 500;
const MAX_NOTES = 4000;
const MAX_PHOTOS = 10;

function normalizePhone(p) {
  const digits = (p || '').replace(/\D/g, '');
  return digits.slice(-10); // last 10 digits for comparison
}
function normalizeEmail(e) {
  return (e || '').trim().toLowerCase();
}
function toProperCase(str) {
  if (!str) return str;
  return String(str).trim().split(' ').map(word => {
    if (!word) return word;
    if (word.includes('-')) return word.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('-');
    if (word.includes("'")) return word.split("'").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("'");
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}
function normalizeName(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function normalizeAddress(s) { return (s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s]/g, ''); }

function firstName(assignedRep) {
  if (!assignedRep || typeof assignedRep !== 'string') return '';
  return assignedRep.trim().split(/\s+/)[0] || '';
}
function resolveOwnerEmail(assignedRep) {
  const first = firstName(assignedRep).toLowerCase();
  return first ? `${first}@${EC_DOMAIN}` : null;
}
function isValidOwnerEmail(email) {
  return !!email && email.endsWith(`@${EC_DOMAIN}`);
}

// Convert a (YYYY-MM-DD, HH:MM) America/Los_Angeles wall-clock time to a UTC ISO.
function laToUtcStart(date, time) {
  return toUtcIso(date, time, 'America/Los_Angeles');
}

// Deterministic idempotency key from the canonical submission. Same lead +
// same slot → same key → idempotent return (no duplicate). Different content →
// different key → new booking attempt (EXCLUDE constraint guards the slot).
function computeIdempotencyKey(c) {
  const canon = {
    owner_email: (c.owner_email || '').toLowerCase() || null,
    first_name: c.first_name || null,
    last_name: c.last_name || null,
    email: (c.email || '').toLowerCase() || null,
    phone: c.phone || null,
    property_address: c.property_address || null,
    appointment_type_id: c.appointment_type_id || null,
    start_at: c.start_at || null,
    appointment_override: !!c.appointment_override,
  };
  return 'cap:' + crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

function validateCapturePayload(body) {
  const errors = [];
  const cleaned = {};
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body required'], cleaned: {} };

  const first_name = toProperCase(body.first_name);
  const last_name = toProperCase(body.last_name);
  if (!first_name) errors.push('first_name is required');
  if (!last_name) errors.push('last_name is required');
  cleaned.first_name = first_name;
  cleaned.last_name = last_name;

  const email = body.email ? normalizeEmail(body.email) : '';
  const phone = body.phone ? normalizePhone(body.phone) : '';
  if (!email && !phone) errors.push('phone or email is required');
  cleaned.email = email || null;
  cleaned.phone = phone || null;

  const project_type = body.project_type
    ? (Array.isArray(body.project_type) ? body.project_type.join(', ') : String(body.project_type))
    : '';
  if (!project_type) errors.push('project_type is required');
  cleaned.project_type = project_type.slice(0, MAX_FIELD);

  const source = body.source ? String(body.source).trim() : '';
  if (!source) errors.push('source is required');
  cleaned.source = source.slice(0, MAX_FIELD);

  const assigned_rep = body.assigned_rep ? String(body.assigned_rep).trim() : '';
  if (!assigned_rep) errors.push('assigned_rep is required');
  const owner_email = resolveOwnerEmail(assigned_rep);
  if (!owner_email || !isValidOwnerEmail(owner_email)) {
    errors.push('assigned_rep must resolve to an @ecconstructiongroup.com owner');
  }
  cleaned.assigned_rep = assigned_rep;
  cleaned.owner_email = owner_email;

  const appointment_date = body.appointment_date ? String(body.appointment_date) : '';
  const appointment_time = body.appointment_time ? String(body.appointment_time) : '';
  if (!appointment_date) errors.push('appointment_date is required');
  if (!appointment_time) errors.push('appointment_time is required');
  if (appointment_date && !/^\d{4}-\d{2}-\d{2}$/.test(appointment_date)) errors.push('appointment_date must be YYYY-MM-DD');
  if (appointment_time && !/^\d{2}:\d{2}$/.test(appointment_time)) errors.push('appointment_time must be HH:MM');
  cleaned.appointment_date = appointment_date || null;
  cleaned.appointment_time = appointment_time || null;

  cleaned.property_address = body.property_address ? toProperCase(body.property_address).slice(0, MAX_FIELD) : null;
  cleaned.city = body.city ? toProperCase(body.city).slice(0, MAX_FIELD) : null;
  cleaned.budget_range = body.budget_range ? String(body.budget_range).slice(0, MAX_FIELD) : null;
  cleaned.start_timeframe = body.start_timeframe ? String(body.start_timeframe).slice(0, MAX_FIELD) : null;
  cleaned.referral_name = body.referral_name ? toProperCase(body.referral_name).slice(0, MAX_FIELD) : null;
  cleaned.message = body.message ? String(body.message).slice(0, MAX_NOTES) : null;
  cleaned.notes = body.notes ? String(body.notes).slice(0, MAX_NOTES) : null;
  cleaned.photo_urls = Array.isArray(body.photo_urls)
    ? body.photo_urls.filter(u => typeof u === 'string' && u.length > 0 && u.length < 1000).slice(0, MAX_PHOTOS)
    : [];

  // Admin conflict-override flag. Optional; defaults to false. The route
  // authorizes it server-side (lib/captureOverrideAuth) before passing it
  // through to bookingService as override_conflict.
  cleaned.appointment_override = !!body.appointment_override;

  return { ok: errors.length === 0, errors, cleaned };
}

module.exports = {
  normalizePhone, normalizeEmail, toProperCase, normalizeName, normalizeAddress,
  resolveOwnerEmail, isValidOwnerEmail, laToUtcStart, computeIdempotencyKey,
  validateCapturePayload, EC_DOMAIN, MAX_FIELD, MAX_NOTES, MAX_PHOTOS,
};