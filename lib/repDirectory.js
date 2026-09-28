/* eslint-disable no-undef */
/**
 * Sales-representative contact directory.
 *
 * Resolves a lead's `assigned_rep` name into a contact card
 * { name, directPhone, email, officePhone, officeEmail }.
 *
 * Direct rep phone/email come from an optional JSON env map so the page
 * never invents contact data:
 *   REMINDER_REP_DIRECTORY = { "yaron": {"phone":"...","email":"..."}, ... }
 * Keys are the lowercased first name of the rep. When no entry exists the
 * rep's email is derived as <first>@<company email domain> and the direct
 * phone falls back to the office line (honest — the office reaches them).
 *
 * getRepContact (this file's original export) stays SYNCHRONOUS and its
 * behavior is byte-for-byte unchanged — lib/leadIngest.js calls it without
 * awaiting, so making it async would silently break every rep-contact
 * lookup for every lead (an object destructured off an un-awaited Promise
 * is all `undefined`). PRODUCTIZATION FOUNDATION: the hardcoded
 * '@ecconstructiongroup.com' domain moved to FALLBACK_DOMAIN, used only
 * when nothing more specific is configured, and a NEW async
 * getRepContactAsync() reads this installation's configured email domain
 * from lib/companyConfig.js (Company Settings) for any call site able to
 * await it. Prefer getRepContactAsync in new/updated call sites so a non-EC
 * installation gets its own domain instead of ecconstructiongroup.com.
 *
 * Future-ready: multiple office locations / per-rep SMS numbers can be
 * added to the same directory map with no routing changes.
 */
'use strict';

const companyConfig = require('./companyConfig');

// Historical hardcoded fallback — used only when company_settings has no
// company_email/admin_email configured (an unbootstrapped database, or the
// synchronous legacy path below). Never presented as configuration; it is
// the last-resort default, not a company-specific assumption baked into
// business logic.
const FALLBACK_DOMAIN = 'ecconstructiongroup.com';
const OFFICE_EMAIL = `office@${FALLBACK_DOMAIN}`;
const OFFICE_PHONE = process.env.COMPANY_PHONE || '(310) 310-4108';

let _dir = null;
function directory() {
  if (_dir !== null) return _dir;
  try {
    _dir = JSON.parse(process.env.REMINDER_REP_DIRECTORY || '{}');
    if (!(_dir && typeof _dir === 'object')) _dir = {};
  } catch {
    _dir = {};
  }
  return _dir;
}

function firstName(assignedRep) {
  if (!assignedRep || typeof assignedRep !== 'string') return '';
  return assignedRep.trim().split(/\s+/)[0] || '';
}

function derivedRepEmail(assignedRep, domain = FALLBACK_DOMAIN) {
  const first = firstName(assignedRep).toLowerCase();
  return first ? `${first}@${domain}` : `office@${domain}`;
}

/**
 * Original, synchronous entry point — behavior unchanged from before the
 * productization pass. The only existing caller (lib/leadIngest.js) does
 * not await this, so it must never become a Promise-returning function.
 */
function getRepContact(assignedRep) {
  const name = (assignedRep && String(assignedRep).trim()) || 'EC Construction Group';
  const first = firstName(assignedRep).toLowerCase();
  const entry = first ? directory()[first] : null;
  const email = (entry && entry.email) || derivedRepEmail(assignedRep, FALLBACK_DOMAIN);
  const directPhone = (entry && entry.phone) || OFFICE_PHONE;
  return { name, directPhone, email, officePhone: OFFICE_PHONE, officeEmail: OFFICE_EMAIL };
}

/**
 * Config-aware variant for call sites that can await a DB read: uses this
 * installation's configured company email domain (Company Settings)
 * instead of the hardcoded EC fallback, and its company_name instead of
 * the literal "EC Construction Group" when no rep name is given.
 */
async function getRepContactAsync(assignedRep) {
  const domain = (await companyConfig.getCompanyEmailDomain()) || FALLBACK_DOMAIN;
  const officeEmail = `office@${domain}`;
  const name = (assignedRep && String(assignedRep).trim()) || (await companyConfig.getCompanyConfig()).company_name || 'CRM';
  const first = firstName(assignedRep).toLowerCase();
  const entry = first ? directory()[first] : null;
  const email = (entry && entry.email) || derivedRepEmail(assignedRep, domain);
  const directPhone = (entry && entry.phone) || OFFICE_PHONE;
  return { name, directPhone, email, officePhone: OFFICE_PHONE, officeEmail };
}

/** Strip a phone string to dial digits for tel: links. */
function telDigits(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

/** Rep email for fingerprinting: stored snapshot email, else derived (sync, historical fallback domain). */
function repEmailForLead(lead) {
  if (lead && lead.assigned_rep_email) return String(lead.assigned_rep_email).toLowerCase();
  return derivedRepEmail(lead && lead.assigned_rep, FALLBACK_DOMAIN).toLowerCase();
}

module.exports = {
  getRepContact, getRepContactAsync, telDigits, repEmailForLead, derivedRepEmail,
  OFFICE_EMAIL, OFFICE_PHONE, FALLBACK_DOMAIN,
};
