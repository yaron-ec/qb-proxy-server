/* eslint-disable no-undef */
/**
 * companyConfig — single read path for per-installation configuration
 * (PRODUCTIZATION FOUNDATION, Phase 1: one company per database/deployment,
 * not shared multi-tenancy — see docs/PRODUCT_ARCHITECTURE.md).
 *
 * Backed by the company_settings singleton (routes/companySettings.js is the
 * admin-facing read/write API for the same row). This module is the READ
 * side business logic should call instead of hardcoding a company's
 * timezone, travel buffer, or enabled integrations — so a value that used
 * to be a source-code constant becomes configuration data that differs per
 * installation with zero source changes.
 *
 * PRODUCT_DEFAULTS below are last-resort fallbacks used only when no
 * company_settings row exists yet (a database that hasn't been bootstrapped)
 * or a column is NULL. They intentionally equal the CRM's historical
 * hardcoded values, so an existing installation's effective behavior is
 * byte-for-byte unchanged until an admin explicitly edits Company Settings.
 *
 * Never put secrets here. Secrets (OAuth tokens, API keys, encryption keys,
 * JWT secret) live in environment variables (Railway) or
 * integration_credentials (encrypted, per-provider) — never in this table,
 * never in this module. See docs/SECURITY_MODEL.md.
 *
 * Cached in-process for CACHE_MS; company_settings changes rarely (an admin
 * editing Company Settings) and every request re-querying it would be
 * wasteful. routes/companySettings.js's PUT handler calls invalidate() so a
 * save takes effect immediately without waiting for the cache to expire.
 */
'use strict';

const { query } = require('../db/client');

const PRODUCT_DEFAULTS = Object.freeze({
  company_name: null,
  legal_name: null,
  dba: null,
  timezone: 'America/Los_Angeles',
  locale: 'en-US',
  appointment_travel_buffer_minutes: 60,
  business_hours: null,
  enabled_modules: Object.freeze({
    quickbooks: false, gmail: false, google_calendar: false, google_contacts: false,
    signnow: false, handoff: false, meta: false, sms: false, website_intake: false,
  }),
  installation_id: null,
  // Neutral — never an EC address. Only used before any company_settings row
  // exists at all (e.g. a health check hit before bootstrap ever ran). A
  // real installation always has a row by the time it serves traffic; see
  // db/migrations/2026-47-notification-config.sql for the per-row defaults
  // (EC-preserving on upgrade, neutral on a fresh scripts/install/bootstrap.js
  // install).
  notification_recipients: Object.freeze({ to: [], cc: [] }),
  email_from_name: null,
  default_owner_email: null,
  default_owner_name: null,
  protected_admin_emails: Object.freeze([]),
});

const CACHE_MS = 30000;
let _cache = null; // { at, row }
// Bumped by invalidate(). A loadRow() call in flight when invalidate() runs
// must never let its (now-stale) result repopulate the cache once it resolves
// — captured at read-start and checked before the write, so a concurrent
// invalidate() (e.g. an admin's Company Settings save racing an in-flight
// request's read) can never be overwritten by a slower, stale query.
let _generation = 0;

function invalidate() {
  _cache = null;
  _generation++;
}

async function loadRow() {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.row;
  const generation = _generation;
  const { rows } = await query('SELECT * FROM company_settings ORDER BY created_at ASC LIMIT 1');
  const row = rows[0] || null;
  if (generation === _generation) _cache = { at: Date.now(), row };
  return row;
}

/**
 * Full config object merging the singleton row (when it exists) over
 * PRODUCT_DEFAULTS. Every key is always present, so callers never need a
 * defensive `|| fallback` for a value this module already owns.
 */
async function getCompanyConfig() {
  const row = await loadRow();
  if (!row) return { ...PRODUCT_DEFAULTS };
  return {
    ...PRODUCT_DEFAULTS,
    company_name: row.company_name ?? PRODUCT_DEFAULTS.company_name,
    legal_name: row.legal_name ?? PRODUCT_DEFAULTS.legal_name,
    dba: row.dba ?? PRODUCT_DEFAULTS.dba,
    company_email: row.company_email ?? null,
    company_phone: row.company_phone ?? null,
    company_website: row.company_website ?? null,
    admin_name: row.admin_name ?? null,
    admin_email: row.admin_email ?? null,
    favicon_url: row.favicon_url ?? null,
    brand_primary_color: row.brand_primary_color ?? null,
    timezone: row.timezone || PRODUCT_DEFAULTS.timezone,
    locale: row.locale || PRODUCT_DEFAULTS.locale,
    appointment_travel_buffer_minutes: row.appointment_travel_buffer_minutes ?? PRODUCT_DEFAULTS.appointment_travel_buffer_minutes,
    business_hours: row.business_hours ?? PRODUCT_DEFAULTS.business_hours,
    enabled_modules: row.enabled_modules || PRODUCT_DEFAULTS.enabled_modules,
    installation_id: row.installation_id ?? PRODUCT_DEFAULTS.installation_id,
    notification_recipients: row.notification_recipients || PRODUCT_DEFAULTS.notification_recipients,
    email_from_name: row.email_from_name ?? PRODUCT_DEFAULTS.email_from_name,
    default_owner_email: row.default_owner_email ?? PRODUCT_DEFAULTS.default_owner_email,
    default_owner_name: row.default_owner_name ?? PRODUCT_DEFAULTS.default_owner_name,
    protected_admin_emails: row.protected_admin_emails || PRODUCT_DEFAULTS.protected_admin_emails,
  };
}

/** Convenience: just the configured timezone (or the product default). */
async function getTimezone() {
  const c = await getCompanyConfig();
  return c.timezone;
}

/** Convenience: the domain to derive a rep's email from (part after '@'). */
async function getCompanyEmailDomain() {
  const c = await getCompanyConfig();
  if (c.company_email && c.company_email.includes('@')) return c.company_email.split('@')[1].toLowerCase();
  if (c.admin_email && c.admin_email.includes('@')) return c.admin_email.split('@')[1].toLowerCase();
  return null; // caller decides the fallback — this module never invents a domain.
}

/** Is a given optional module enabled for this installation? */
async function isModuleEnabled(moduleKey) {
  const c = await getCompanyConfig();
  return c.enabled_modules?.[moduleKey] === true;
}

module.exports = { getCompanyConfig, getTimezone, getCompanyEmailDomain, isModuleEnabled, invalidate, PRODUCT_DEFAULTS };
