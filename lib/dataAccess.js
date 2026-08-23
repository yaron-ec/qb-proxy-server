/* eslint-disable no-undef */
/**
 * dataAccess — Railway Postgres data-access layer for email endpoints.
 *
 * PURPOSE: give the Railway email endpoints access to Lead/Invoice/CompanySettings
 * data from the Railway Postgres database. Replaces the temporary Base44 bridge.
 *
 * Tables: leads, invoices, company_settings (Railway Postgres).
 * No Gmail, no sending — pure data reads.
 *
 * MIGRATION NOTE: invoices and company_settings tables are created by migration
 * 2026-14-crm-remaining-tables.sql. If that migration has not been applied yet,
 * getInvoice() and getCompanySettings() will return null (table-not-found errors
 * are caught and suppressed, matching the previous Base44 fallback behavior).
 */
'use strict';

const db = require('../db/client');

const CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL || 'https://crm.ecconstructiongroup.com';

// ── Snake-case DB row → camelCase object (matches Base44 Lead shape) ──────────
function serializeLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    property_address: row.property_address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    project_type: row.project_type,
    budget_range: row.budget_range,
    start_timeframe: row.start_timeframe,
    source: row.source,
    referral_name: row.referral_name,
    owner_id: row.owner_id,
    status: row.status,
    notes: row.notes,
    message: row.message,
    lead_score: row.lead_score,
    is_new_intake_lead: row.is_new_intake_lead,
    customer_reminders_disabled: row.customer_reminders_disabled,
    photo_urls: row.photo_urls,
    record_type: row.record_type,
    follow_up_date: row.follow_up_date,
    follow_up_time: row.follow_up_time,
    follow_up_type: row.follow_up_type,
    meeting_stage: row.meeting_stage,
    crm_created_date: row.crm_created_date,
    reviewed_at: row.reviewed_at,
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

function serializeInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_ref: row.external_ref,
    lead_id: row.lead_id,
    deal_id: row.deal_id,
    invoice_number: row.invoice_number,
    amount: row.amount,
    description: row.description,
    payment_stage: row.payment_stage,
    due_date: row.due_date,
    status: row.status,
    qb_invoice_id: row.qb_invoice_id,
    qb_invoice_number: row.qb_invoice_number,
    qb_status: row.qb_status,
    qb_invoice_url: row.qb_invoice_url,
    qb_pdf_url: row.qb_pdf_url,
    payment_received: row.payment_received,
    payment_status: row.payment_status,
    payment_method: row.payment_method,
    payment_date: row.payment_date,
    notes: row.notes,
    synced_to_qb: row.synced_to_qb,
    email_sent_date: row.email_sent_date,
    email_recipients: row.email_recipients,
    email_delivery_status: row.email_delivery_status,
  };
}

async function getLead(id) {
  if (!id) return null;
  try {
    const { rows } = await db.query(
      `SELECT * FROM leads WHERE id::text = $1 OR external_ref = $1 LIMIT 1`,
      [String(id)]
    );
    return serializeLead(rows[0]);
  } catch { return null; }
}

async function getInvoice(id) {
  if (!id) return null;
  try {
    const { rows } = await db.query(
      `SELECT * FROM invoices WHERE id::text = $1 OR external_ref = $1 LIMIT 1`,
      [String(id)]
    );
    return serializeInvoice(rows[0]);
  } catch { return null; }
}

async function getCompanySettings() {
  try {
    const { rows } = await db.query(
      `SELECT * FROM company_settings ORDER BY created_at DESC LIMIT 1`
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      company_name: rows[0].company_name,
      company_logo_url: rows[0].company_logo_url,
      company_email: rows[0].company_email,
      company_phone: rows[0].company_phone,
      company_address: rows[0].company_address,
      company_city: rows[0].company_city,
      company_state: rows[0].company_state,
      company_zip: rows[0].company_zip,
      admin_name: rows[0].admin_name,
      admin_email: rows[0].admin_email,
      company_website: rows[0].company_website,
      crm_activity_notifications_enabled: rows[0].crm_activity_notifications_enabled,
    };
  } catch { return null; }
}

// Resolve the staff email for an assigned rep name (e.g. "Yaron Drilevich" -> yaron@…).
function resolveOwnerEmail(ownerName) {
  if (!ownerName || typeof ownerName !== 'string') return null;
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