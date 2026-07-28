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
 * rep's email is derived as <first>@ecconstructiongroup.com and the direct
 * phone falls back to the office line (honest — the office reaches them).
 *
 * Future-ready: multiple office locations / per-rep SMS numbers can be
 * added to the same directory map with no routing changes.
 */
'use strict';

const OFFICE_EMAIL = 'office@ecconstructiongroup.com';
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

function derivedRepEmail(assignedRep) {
  const first = firstName(assignedRep).toLowerCase();
  return first ? `${first}@ecconstructiongroup.com` : OFFICE_EMAIL;
}

function getRepContact(assignedRep) {
  const name = (assignedRep && String(assignedRep).trim()) || 'EC Construction Group';
  const first = firstName(assignedRep).toLowerCase();
  const entry = first ? directory()[first] : null;
  const email = (entry && entry.email) || derivedRepEmail(assignedRep);
  const directPhone = (entry && entry.phone) || OFFICE_PHONE;
  return { name, directPhone, email, officePhone: OFFICE_PHONE, officeEmail: OFFICE_EMAIL };
}

/** Strip a phone string to dial digits for tel: links. */
function telDigits(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

/** Rep email for fingerprinting: stored snapshot email, else derived. */
function repEmailForLead(lead) {
  if (lead && lead.assigned_rep_email) return String(lead.assigned_rep_email).toLowerCase();
  return derivedRepEmail(lead && lead.assigned_rep).toLowerCase();
}

module.exports = { getRepContact, telDigits, repEmailForLead, derivedRepEmail, OFFICE_EMAIL, OFFICE_PHONE };