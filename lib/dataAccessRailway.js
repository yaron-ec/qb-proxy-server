/* eslint-disable no-undef */
/**
 * dataAccessRailway — PERMANENT Postgres-based data access for email routes.
 *
 * Replaces lib/dataAccess.js (which reads from Base44 via REST API) with direct
 * Railway Postgres queries. Same function signatures so emails.js can swap
 * imports with a one-line change.
 *
 * No Base44, no REST API calls — pure Postgres reads.
 */
'use strict';

const { query } = require('../db/client');

const CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com';

/**
 * Get a lead by Railway UUID. Returns an object with the same shape that
 * emails.js expects (camelCase fields + assigned_rep as display name).
 */
async function getLead(id) {
  if (!id) return null;
  try {
    const { rows } = await query(
      `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
       FROM leads l LEFT JOIN owners o ON o.id = l.owner_id
       WHERE l.id = $1`,
      [id]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    // Map to the shape emails.js expects (compatible with old Base44 lead object)
    return {
      id: r.id,
      external_ref: r.external_ref,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      phone: r.phone,
      property_address: r.property_address,
      city: r.city,
      project_type: r.project_type,
      assigned_rep: r.owner_display_name || r.owner_email || null,
      owner_email: r.owner_email,
      follow_up_date: r.follow_up_date,
      follow_up_time: r.follow_up_time,
      follow_up_type: r.follow_up_type,
      appointment_date: r.appointment_date,
      appointment_time: r.appointment_time,
      notes: r.notes,
      customer_reminders_disabled: r.customer_reminders_disabled || false,
      status: r.status,
    };
  } catch (e) {
    console.error('[dataAccessRailway] getLead error:', e.message);
    return null;
  }
}

/**
 * Get an invoice by Railway UUID.
 */
async function getInvoice(id) {
  if (!id) return null;
  try {
    const { rows } = await query('SELECT * FROM invoices WHERE id = $1', [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      lead_id: r.lead_id,
      invoice_number: r.invoice_number,
      amount: r.amount,
      description: r.description,
      qb_invoice_id: r.qb_invoice_id,
      qb_invoice_number: r.qb_invoice_number,
      qb_invoice_url: r.qb_invoice_url,
      status: r.status,
    };
  } catch (e) {
    console.error('[dataAccessRailway] getInvoice error:', e.message);
    return null;
  }
}

/**
 * Get company settings (first row).
 */
async function getCompanySettings() {
  try {
    const { rows } = await query('SELECT * FROM company_settings LIMIT 1');
    return rows[0] || null;
  } catch (e) {
    console.error('[dataAccessRailway] getCompanySettings error:', e.message);
    return null;
  }
}

/**
 * Resolve a staff email from an owner display name (e.g. "Yaron Drilevich" → yaron@…).
 * Same logic as dataAccess.js — pure function, no I/O.
 */
function resolveOwnerEmail(ownerName) {
  if (!ownerName || typeof ownerName !== 'string') return null;
  // If it's already an email, return as-is
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerName.trim().toLowerCase())) {
    return ownerName.trim().toLowerCase();
  }
  const first = ownerName.trim().split(/\s+/)[0].toLowerCase();
  return first ? `${first}@ecconstructiongroup.com` : null;
}

function leadLink(leadId) {
  return `${CRM_PUBLIC_URL}/leads/${leadId}`;
}

module.exports = {
  getLead,
  getInvoice,
  getCompanySettings,
  resolveOwnerEmail,
  leadLink,
  CRM_PUBLIC_URL,
};