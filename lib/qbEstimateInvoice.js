/* eslint-disable no-undef */
'use strict';

/**
 * qbEstimateInvoice — real QuickBooks Estimate/Invoice CREATION from a CRM
 * Deal (CRM STABILITY PHASE, completion pass, Section B).
 *
 * Prior state (audited in PR #17): the frontend ("Create Invoice in
 * QuickBooks" in InvoiceCreationFlow.jsx, a separate lead-scoped legacy
 * flow) called POST /qb/sync-lead with action: 'sync_invoice'/'sync_estimate',
 * which server.js correctly turned into an honest 501 rather than silently
 * no-op'ing as success — no QB Invoice/Estimate Line/ItemRef construction
 * existed anywhere. This module is the real implementation, built
 * DEAL-scoped (never lead-scoped) per the audit's own multi-project
 * finding: a QB customer can have more than one CRM Deal, and an invoice/
 * estimate belongs to exactly one Deal — never resolved by shared customer
 * alone (lib/qbInvoiceSaleMap.js, lib/customerPaymentWaterfall.js).
 *
 * NO LIVE QUICKBOOKS ACCOUNT ACCESS was available in the environment this
 * was written in (zero QB credentials configured) — so the one thing that
 * is genuinely account-specific and could not be verified live is which
 * QB Item/Service + Income Account an installation's invoices should use
 * for a lump-sum "construction services" line. Rather than inventing one
 * (CLAUDE.md: "Do NOT invent an ItemRef"), that single choice is the one
 * required admin configuration point (`getInvoiceItemConfig`/
 * `setInvoiceItemConfig`, admin-set via GET/PUT /api/v1/qb/invoice-config
 * in routes/qbInvoicing.js), discoverable read-only via `listQbItems()`
 * (GET /api/v1/qb/items — a live, read-only `SELECT * FROM Item` query,
 * never a write) so an admin picks their REAL item from their REAL
 * account rather than guessing. Until configured, Estimate/Invoice
 * creation fails closed with a clear, specific error — never a malformed
 * QuickBooks transaction.
 *
 * Idempotency/concurrency: a session-scoped Postgres advisory lock keyed
 * per Deal (same pattern as lib/qbTokenManager.js's refresh lock — a lock
 * held across the live QB network call, never a held-open DB transaction,
 * per CLAUDE.md's "do not hold a transaction open across an external API
 * call" rule) serializes concurrent create attempts for the SAME deal
 * (double-click, retry, two browser tabs). The existing qb_estimate_id/
 * qb_invoice_sale_map row is re-read under the lock — if already present,
 * the existing result is returned rather than creating a duplicate QB
 * transaction.
 */
const { query, pool } = require('../db/client');
const qbTokenManager = require('./qbTokenManager');
const { upsertMapping, upsertInvoiceCacheFromQb, getInvoicesForSale } = require('./qbInvoiceSaleMap');

const QB_API_BASE = (process.env.QB_ENVIRONMENT === 'production')
  ? 'https://quickbooks.api.intuit.com/v3/company'
  : 'https://sandbox-quickbooks.api.intuit.com/v3/company';
const SANDBOX = process.env.QB_SANDBOX === 'true';
const ENVIRONMENT = SANDBOX ? 'sandbox' : 'production';

// Distinct advisory-lock namespace — see lib/booking/appointmentWriter.js
// (1001) and lib/booking/leadResolution.js (1002) for the sibling
// namespaces this must never collide with.
const QB_DEAL_LOCK_NAMESPACE = 1003;
const LOCK_PURPOSE = { ESTIMATE: 1, INVOICE: 2 };

async function withDealLock(dealId, purpose, fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, hashtext($2::text))', [QB_DEAL_LOCK_NAMESPACE, `${purpose}:${dealId}`]);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, hashtext($2::text))', [QB_DEAL_LOCK_NAMESPACE, `${purpose}:${dealId}`]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function qbRequest(buildPath, init = {}) {
  const r = await qbTokenManager.qbApiRequest(ENVIRONMENT, (t) => `${QB_API_BASE}/${t.realm_id}${buildPath(t)}`, init);
  if (!r) {
    const err = new Error('QuickBooks is not connected for this installation');
    err.code = 'QB_NOT_CONNECTED';
    throw err;
  }
  if (!r.res.ok) {
    const err = new Error(`QuickBooks API ${r.res.status}: ${(r.text || '').substring(0, 300)}`);
    err.status = r.res.status;
    err.qbResponse = r.json;
    throw err;
  }
  return r.json;
}

function qbQuery(q) {
  return qbRequest(() => `/query?query=${encodeURIComponent(q)}`);
}

// ── Admin-configured default Item/Income Account (the one genuinely
//    account-specific decision this feature needs — see file header) ──────
const INVOICE_CONFIG_KEY = 'qb_invoice_item_config';

async function getInvoiceItemConfig() {
  const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [INVOICE_CONFIG_KEY]);
  return rows[0]?.value || null;
}

async function setInvoiceItemConfig({ item_ref, item_name, income_account_ref, income_account_name }) {
  if (!item_ref) throw new Error('item_ref is required');
  const value = { item_ref: String(item_ref), item_name: item_name || null, income_account_ref: income_account_ref || null, income_account_name: income_account_name || null };
  await query(
    `INSERT INTO app_settings (key, value, type) VALUES ($1, $2, 'json')
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [INVOICE_CONFIG_KEY, JSON.stringify(value)]
  );
  return value;
}

/**
 * READ-ONLY: list this QB account's real Items, for the admin config UI.
 * Never writes. Never invents an Item.
 */
async function listQbItems() {
  const data = await qbQuery('SELECT * FROM Item WHERE Active = true MAXRESULTS 200');
  const items = data?.QueryResponse?.Item || [];
  return items.map((i) => ({
    id: i.Id,
    name: i.Name,
    type: i.Type,
    income_account_ref: i.IncomeAccountRef?.value || null,
    income_account_name: i.IncomeAccountRef?.name || null,
  }));
}

// ── QB Customer find-or-create (deal-agnostic — a Deal's lead owns the QB
//    Customer identity; never create a second QB Customer for the same
//    lead just because it's a different Deal) ──────────────────────────────
async function findOrCreateQbCustomer(lead) {
  if (lead.qb_customer_id) {
    try {
      const data = await qbRequest((t) => `/customer/${lead.qb_customer_id}?minorversion=65`);
      if (data?.Customer) return data.Customer;
    } catch (e) {
      // Stored id no longer resolves (deleted/wrong realm) — fall through to
      // search/create rather than failing the whole operation.
      console.warn('[qbEstimateInvoice] stored qb_customer_id did not resolve, falling back to search:', e.message);
    }
  }
  const displayName = `${lead.first_name || ''} ${lead.last_name || ''}`.trim();
  if (displayName) {
    const qr = await qbQuery(`SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "\\'")}' MAXRESULTS 1`);
    const found = qr?.QueryResponse?.Customer?.[0];
    if (found) return found;
  }
  const payload = { DisplayName: displayName || `Lead ${lead.id}` };
  if (lead.email) payload.PrimaryEmailAddr = { Address: lead.email };
  if (lead.phone) payload.PrimaryPhone = { FreeFormNumber: lead.phone };
  if (lead.property_address) payload.BillAddr = { Line1: lead.property_address, City: lead.city || '' };
  const created = await qbRequest(() => '/customer?minorversion=65', { method: 'POST', body: JSON.stringify(payload) });
  return created.Customer;
}

async function buildLineItems(deal, itemConfig) {
  if (!itemConfig?.item_ref) {
    const err = new Error('Cannot create a QuickBooks document: no default Item is configured. An admin must set one in Settings → QuickBooks (GET /api/v1/qb/items lists the real items on this account to choose from).');
    err.code = 'qb_item_not_configured';
    throw err;
  }
  const amount = Number(deal.amount) || 0;
  return [{
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    Description: deal.name || 'Project',
    SalesItemLineDetail: { ItemRef: { value: String(itemConfig.item_ref), name: itemConfig.item_name || undefined }, Qty: 1, UnitPrice: amount },
  }];
}

async function loadDealAndLead(dealId) {
  const { rows } = await query(
    `SELECT d.*, l.id AS lead_id, l.first_name, l.last_name, l.email, l.phone,
            l.property_address, l.city, l.qb_customer_id
     FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.id = $1`,
    [dealId]
  );
  return rows[0] || null;
}

/**
 * Create a QB Estimate for a Deal. Idempotent: if the Deal already has a
 * qb_estimate_id, returns the existing one rather than creating a second.
 */
async function createEstimateForDeal(dealId) {
  return withDealLock(dealId, LOCK_PURPOSE.ESTIMATE, async () => {
    const deal = await loadDealAndLead(dealId);
    if (!deal) { const e = new Error('deal_not_found'); e.status = 404; throw e; }
    if (deal.qb_estimate_id) {
      return { created: false, qb_estimate_id: deal.qb_estimate_id, qb_estimate_number: deal.qb_estimate_number };
    }
    const itemConfig = await getInvoiceItemConfig();
    const lines = await buildLineItems(deal, itemConfig);
    const customer = await findOrCreateQbCustomer(deal);
    if (!deal.qb_customer_id || deal.qb_customer_id !== customer.Id) {
      await query('UPDATE leads SET qb_customer_id = $1 WHERE id = $2', [customer.Id, deal.lead_id]);
    }
    const payload = { CustomerRef: { value: customer.Id }, Line: lines };
    const created = await qbRequest(() => '/estimate?minorversion=65', { method: 'POST', body: JSON.stringify(payload) });
    const estimate = created.Estimate;
    await query(
      `UPDATE deals SET qb_estimate_id = $1, qb_estimate_number = $2, qb_estimate_synced_at = NOW() WHERE id = $3`,
      [estimate.Id, estimate.DocNumber || null, dealId]
    );
    return { created: true, qb_estimate_id: estimate.Id, qb_estimate_number: estimate.DocNumber || null, raw: estimate };
  });
}

/**
 * Create a QB Invoice for a Deal. Idempotent: if an active (non-voided)
 * invoice is already mapped to this Deal in qb_invoice_sale_map, returns
 * the existing one rather than creating a second QB Invoice — this is the
 * SAME ownership table dealFinancials.js/customerPaymentWaterfall.js read,
 * so a newly created invoice is immediately visible to those, and a retry
 * can never create a duplicate transaction in a real QuickBooks account.
 */
async function createInvoiceForDeal(dealId) {
  return withDealLock(dealId, LOCK_PURPOSE.INVOICE, async () => {
    const deal = await loadDealAndLead(dealId);
    if (!deal) { const e = new Error('deal_not_found'); e.status = 404; throw e; }
    const existing = await getInvoicesForSale({ query }, dealId);
    if (existing.length > 0) {
      return { created: false, qb_invoice_id: existing[0].qb_invoice_id, qb_doc_number: existing[0].qb_doc_number };
    }
    const itemConfig = await getInvoiceItemConfig();
    const lines = await buildLineItems(deal, itemConfig);
    const customer = await findOrCreateQbCustomer(deal);
    if (!deal.qb_customer_id || deal.qb_customer_id !== customer.Id) {
      await query('UPDATE leads SET qb_customer_id = $1 WHERE id = $2', [customer.Id, deal.lead_id]);
    }
    const payload = { CustomerRef: { value: customer.Id }, Line: lines };
    const created = await qbRequest(() => '/invoice?minorversion=65', { method: 'POST', body: JSON.stringify(payload) });
    const invoice = created.Invoice;
    // Deal-scoped ownership — the ONE durable source of truth (never
    // reassignable; ON CONFLICT DO NOTHING inside upsertMapping).
    await upsertMapping({ query }, {
      qb_invoice_id: String(invoice.Id),
      qb_doc_number: invoice.DocNumber || null,
      crm_sale_id: dealId,
      crm_lead_id: deal.lead_id,
      qb_customer_id: customer.Id,
      mapping_method: 'crm_created',
    });
    await upsertInvoiceCacheFromQb({ query }, invoice);
    return { created: true, qb_invoice_id: invoice.Id, qb_doc_number: invoice.DocNumber || null, raw: invoice };
  });
}

module.exports = {
  getInvoiceItemConfig,
  setInvoiceItemConfig,
  listQbItems,
  findOrCreateQbCustomer,
  createEstimateForDeal,
  createInvoiceForDeal,
};
