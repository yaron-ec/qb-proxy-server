/* eslint-disable no-undef */
'use strict';

/**
 * qbInvoiceSaleMap — canonical sale→invoice ownership helpers.
 *
 * The qb_invoice_sale_map table is the ONLY durable source of truth for which
 * Sale (crm_sale_id) a QuickBooks invoice belongs to. Financial ownership
 * NEVER resolves by customer, amount, project name, or date.
 *
 * Payment resolution chain:
 *   QuickBooks Payment → QuickBooks Invoice → qb_invoice_sale_map.crm_sale_id → Sale
 */

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Upsert a mapping row. Idempotent on qb_invoice_id (PK).
 * Once a qb_invoice_id is mapped to a crm_sale_id, this function NEVER
 * reassigns it — ON CONFLICT DO NOTHING preserves the original ownership.
 * Reassignment requires an explicit, audited manual operation.
 */
async function upsertMapping(db, { qb_invoice_id, qb_doc_number, crm_sale_id, crm_lead_id, qb_customer_id, mapping_method = 'crm_created' }) {
  if (!qb_invoice_id || !crm_sale_id || !crm_lead_id || !qb_customer_id) {
    throw new Error('upsertMapping: qb_invoice_id, crm_sale_id, crm_lead_id, qb_customer_id are all required');
  }
  await db.query(
    `INSERT INTO qb_invoice_sale_map (qb_invoice_id, qb_doc_number, crm_sale_id, crm_lead_id, qb_customer_id, mapping_method)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (qb_invoice_id) DO NOTHING`,
    [String(qb_invoice_id), qb_doc_number || null, crm_sale_id, crm_lead_id, String(qb_customer_id), mapping_method]
  );
}

/**
 * Upsert a cached QB invoice row (read-only mirror of QB financials).
 * Called by the QB sync worker after every invoice fetch/refresh.
 */
async function upsertInvoiceCache(db, { qb_invoice_id, qb_doc_number, qb_customer_id, total_amt, balance, paid, txn_status, voided, txn_date }) {
  if (!qb_invoice_id || !qb_customer_id) {
    throw new Error('upsertInvoiceCache: qb_invoice_id and qb_customer_id are required');
  }
  await db.query(
    `INSERT INTO qb_invoices_cache (qb_invoice_id, qb_doc_number, qb_customer_id, total_amt, balance, paid, txn_status, voided, txn_date, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (qb_invoice_id) DO UPDATE SET
       qb_doc_number = EXCLUDED.qb_doc_number,
       qb_customer_id = EXCLUDED.qb_customer_id,
       total_amt = EXCLUDED.total_amt,
       balance = EXCLUDED.balance,
       paid = EXCLUDED.paid,
       txn_status = EXCLUDED.txn_status,
       voided = qb_invoices_cache.voided,
       txn_date = EXCLUDED.txn_date,
       last_synced_at = NOW()`,
    [String(qb_invoice_id), qb_doc_number || null, String(qb_customer_id),
     Number(total_amt) || 0, Number(balance) || 0, Number(paid) || 0,
     txn_status || null, !!voided, txn_date || null]
  );
}

async function getMappingByInvoiceId(db, qb_invoice_id) {
  const r = await db.query('SELECT * FROM qb_invoice_sale_map WHERE qb_invoice_id = $1', [String(qb_invoice_id)]);
  return r.rows[0] || null;
}

/**
 * Return all ACTIVE (non-voided) invoices mapped to this Sale, with cached
 * financials. This is the ONLY query used to compute a Sale's invoiced/paid.
 */
async function getInvoicesForSale(db, crm_sale_id) {
  const r = await db.query(
    `SELECT m.qb_invoice_id, m.qb_doc_number, m.crm_sale_id, m.crm_lead_id, m.qb_customer_id, m.mapping_method,
            c.total_amt, c.balance, c.paid, c.txn_status, c.voided, c.txn_date
     FROM qb_invoice_sale_map m
     LEFT JOIN qb_invoices_cache c ON c.qb_invoice_id = m.qb_invoice_id
     WHERE m.crm_sale_id = $1
       AND COALESCE(m.voided, FALSE) = FALSE
       AND COALESCE(c.voided, FALSE) = FALSE
     ORDER BY c.txn_date NULLS LAST, m.qb_invoice_id`,
    [crm_sale_id]
  );
  return r.rows;
}

/**
 * Sale-scoped financial summary. THE single way to compute a Sale's financials.
 *
 * @param saleTotal  Deal.amount — passed in by the caller (the CRM). Never
 *                   derived from customer or invoices. During the Base44→Railway
 *                   migration the caller supplies this; once Deals live on
 *                   Railway the endpoint will load it from the deals table.
 * @param invoices   output of getInvoicesForSale (active, sale-scoped).
 */
function computeSaleFinancials(saleTotal, invoices) {
  const total = round2(Number(saleTotal) || 0);
  const invoiced = round2((invoices || []).reduce((s, i) => s + (Number(i.total_amt) || 0), 0));
  const paid = round2((invoices || []).reduce((s, i) => s + (Number(i.paid) || 0), 0));
  const balance = round2(Math.max(0, total - paid));
  let payment_status = 'unpaid';
  if (total > 0 && paid >= total) payment_status = 'paid';
  else if (paid > 0) payment_status = 'partial';
  return { total, invoiced, paid, balance, payment_status };
}

/**
 * READ-ONLY classification of existing cached invoices for backfill planning.
 * NEVER auto-assigns. amount is NEVER used as a disambiguator.
 *
 * @param db
 * @param resolvers  { leadIdForCustomer(qb_customer_id) -> lead_id|null,
 *                     dealCountForLead(lead_id) -> number }
 * @returns array of { qb_invoice_id, qb_doc_number, qb_customer_id, total_amt,
 *                     crm_lead_id, deal_count, classification }
 *   classification: 'SAFE_AUTO_MAP' (exactly 1 deal) | 'AMBIGUOUS' (>1 deal) |
 *                  'UNMAPPED' (no lead or 0 deals)
 */
async function classifyExisting(db, resolvers) {
  const r = await db.query('SELECT qb_invoice_id, qb_doc_number, qb_customer_id, total_amt FROM qb_invoices_cache WHERE voided = FALSE');
  const out = [];
  for (const inv of r.rows) {
    const leadId = resolvers.leadIdForCustomer ? resolvers.leadIdForCustomer(inv.qb_customer_id) : null;
    const dealCount = leadId && resolvers.dealCountForLead ? resolvers.dealCountForLead(leadId) : 0;
    let classification = 'UNMAPPED';
    if (leadId && dealCount === 1) classification = 'SAFE_AUTO_MAP';
    else if (leadId && dealCount > 1) classification = 'AMBIGUOUS';
    out.push({ ...inv, crm_lead_id: leadId, deal_count: dealCount, classification });
  }
  return out;
}

/**
 * Upsert the invoice cache from a raw QuickBooks Invoice object.
 * QuickBooks is authoritative for amounts. paid = max(0, TotalAmt - Balance).
 * voided is preserved on conflict (a refresh never un-voids an invoice);
 * only markVoided sets voided = TRUE.
 */
async function upsertInvoiceCacheFromQb(db, inv) {
  if (!inv || !inv.Id) throw new Error('upsertInvoiceCacheFromQb: inv.Id required');
  const total = round2(Number(inv.TotalAmt) || 0);
  const balance = round2(Number(inv.Balance) || 0);
  const paid = round2(Math.max(0, total - balance));
  await upsertInvoiceCache(db, {
    qb_invoice_id: String(inv.Id),
    qb_doc_number: inv.DocNumber || null,
    qb_customer_id: String((inv.CustomerRef && inv.CustomerRef.value) || ''),
    total_amt: total,
    balance: balance,
    paid: paid,
    txn_status: inv.TxnStatus || null,
    voided: false,
    txn_date: inv.TxnDate || null,
  });
}

/**
 * Mark an invoice voided in BOTH the ownership map and the cache.
 * Voided invoices are excluded from sale-scoped financials. Idempotent.
 */
async function markVoided(db, qb_invoice_id) {
  if (!qb_invoice_id) throw new Error('markVoided: qb_invoice_id required');
  const id = String(qb_invoice_id);
  await db.query('UPDATE qb_invoice_sale_map SET voided = TRUE WHERE qb_invoice_id = $1', [id]);
  await db.query('UPDATE qb_invoices_cache SET voided = TRUE WHERE qb_invoice_id = $1', [id]);
}

module.exports = {
  round2,
  upsertMapping,
  upsertInvoiceCache,
  upsertInvoiceCacheFromQb,
  markVoided,
  getMappingByInvoiceId,
  getInvoicesForSale,
  computeSaleFinancials,
  classifyExisting,
};