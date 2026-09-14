/* eslint-disable no-undef */
'use strict';

/**
 * qbInboundSync — QuickBooks INBOUND synchronization engine.
 *
 * QuickBooks is the authoritative source for QB financial entities (estimates,
 * invoices, payments). This module fetches them from QB and persists to the
 * CRM database so the UI reflects QB-created transactions automatically.
 *
 * Primary matching: qb_customer_id (NOT customer name).
 * Idempotency: QB entity IDs are primary keys (ON CONFLICT DO UPDATE).
 * Duplicate prevention: re-running sync creates zero duplicates.
 *
 * Triggered by:
 *   1. Webhook (fast, event-driven) — routes/qbWebhook.js
 *   2. Scheduled reconciliation (recovery) — routes/cronJobs.js + Base44 workflow
 *   3. Manual refresh — routes/leadQB.js
 *   4. Full historical backfill — routes/qbInboundSync.js /full-backfill
 */
const { query } = require('../db/client');
const { upsertInvoiceCacheFromQb, upsertMapping } = require('./qbInvoiceSaleMap');
const tokenStore = require('./qbTokenStore');
const qbMatch = require('./qbMatch');

const QB_API_BASE = (process.env.QB_ENVIRONMENT === 'production')
  ? 'https://quickbooks.api.intuit.com/v3/company'
  : 'https://sandbox-quickbooks.api.intuit.com/v3/company';

const SANDBOX = process.env.QB_SANDBOX === 'true';
const QB_PAGE_SIZE = 100;
let _syncing = false;

// ── Token management ──────────────────────────────────────────────────────────
async function getValidTokens() {
  const environment = SANDBOX ? 'sandbox' : 'production';
  let tokens = await tokenStore.loadPersistedTokens(environment);
  if (!tokens) return null;
  const isExpired = !tokens.expires_at ||
    Date.now() >= new Date(tokens.expires_at).getTime() - 5 * 60 * 1000;
  if (isExpired) tokens = await refreshTokens(tokens, environment);
  return tokens;
}

async function refreshTokens(tokens, environment) {
  const creds = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error(`Token refresh failed: ${tokenData.error_description || tokenData.error}`);
  const refreshed = {
    ...tokens,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || tokens.refresh_token,
    expires_at: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
    last_refresh_at: new Date().toISOString(),
  };
  await tokenStore.savePersistedTokens(environment, refreshed);
  return refreshed;
}

// ── QB API helpers ───────────────────────────────────────────────────────────
async function qbQuery(q, tokens) {
  const url = `${QB_API_BASE}/${tokens.realm_id}/query?query=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`QB query failed ${res.status}: ${text.substring(0, 200)}`);
  return JSON.parse(text);
}

// Paginated fetch: STARTPOSITION + MAXRESULTS until ALL entities retrieved
async function qbQueryAll(entityType, whereClause, tokens) {
  const all = [];
  let startPosition = 1;
  while (true) {
    const q = `SELECT * FROM ${entityType} WHERE ${whereClause} STARTPOSITION ${startPosition} MAXRESULTS ${QB_PAGE_SIZE}`;
    const data = await qbQuery(q, tokens);
    const items = data?.QueryResponse?.[entityType] || [];
    all.push(...items);
    if (items.length < QB_PAGE_SIZE) break;
    startPosition += QB_PAGE_SIZE;
    if (all.length >= 5000) break; // safety valve
  }
  return all;
}

// ── Auto-map invoice to sale (qb_customer_id ONLY — never customer name) ──────
async function autoMapInvoiceToSale(inv, qbCustomerId) {
  const leadRes = await query('SELECT id FROM leads WHERE qb_customer_id = $1 LIMIT 1', [String(qbCustomerId)]);
  if (!leadRes.rows.length) return { mapped: false, reason: 'no_lead_for_customer' };
  const leadId = leadRes.rows[0].id;
  const dealRes = await query('SELECT id FROM deals WHERE lead_id = $1', [leadId]);
  if (dealRes.rows.length === 0) return { mapped: false, reason: 'no_deal_for_lead' };
  if (dealRes.rows.length > 1) return { mapped: false, reason: 'ambiguous_multiple_deals' };
  const saleId = dealRes.rows[0].id;
  await upsertMapping({ query }, {
    qb_invoice_id: String(inv.Id), qb_doc_number: inv.DocNumber || null,
    crm_sale_id: saleId, crm_lead_id: leadId, qb_customer_id: String(qbCustomerId),
    mapping_method: 'backfill',
  });
  return { mapped: true, sale_id: saleId, lead_id: leadId };
}

// ── Persist payment + LinkedTxn allocations ─────────────────────────────────
async function upsertPaymentWithAllocations(payment, qbCustomerId) {
  const qbPaymentId = String(payment.Id);
  const totalAmt = Number(payment.TotalAmt) || 0;
  const unappliedAmt = Number(payment.UnappliedAmt) || 0;
  const txnDate = payment.TxnDate || null;
  const method = payment.PaymentMethodRef ? (payment.PaymentMethodRef.name || payment.PaymentMethodRef.value) : null;
  const docNumber = payment.DocNumber || null;

  await query(
    `INSERT INTO qb_payments_cache (qb_payment_id, qb_doc_number, qb_customer_id, total_amt, unapplied_amt, txn_date, method, voided, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW())
     ON CONFLICT (qb_payment_id) DO UPDATE SET
       qb_doc_number = EXCLUDED.qb_doc_number, qb_customer_id = EXCLUDED.qb_customer_id,
       total_amt = EXCLUDED.total_amt, unapplied_amt = EXCLUDED.unapplied_amt,
       txn_date = EXCLUDED.txn_date, method = EXCLUDED.method, voided = FALSE, last_synced_at = NOW()`,
    [qbPaymentId, docNumber, String(qbCustomerId), totalAmt, unappliedAmt, txnDate, method]
  );

  // Replace allocations (DELETE + INSERT) — idempotent mirror of QB LinkedTxn
  await query('DELETE FROM qb_payment_allocations WHERE qb_payment_id = $1', [qbPaymentId]);

  let allocCount = 0;
  const lines = payment.Line || [];
  for (const line of lines) {
    const linked = line.LinkedTxn || [];
    for (const txn of linked) {
      if (txn.TxnType === 'Invoice' && txn.TxnId) {
        const allocationAmt = Number(line.Amount) || 0;
        await query(
          `INSERT INTO qb_payment_allocations (qb_payment_id, qb_invoice_id, allocation_amt, last_synced_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (qb_payment_id, qb_invoice_id) DO UPDATE SET
             allocation_amt = EXCLUDED.allocation_amt, last_synced_at = NOW()`,
          [qbPaymentId, String(txn.TxnId), allocationAmt]
        );
        allocCount++;
      }
    }
  }
  return allocCount;
}

// ── Mark cached entities not in QB response as voided (deleted in QB) ─────────
async function markStaleAsVoided(qbCustomerId, foundInvoiceIds, foundPaymentIds) {
  // Mark invoices that are in the cache for this customer but NOT in QB response
  if (foundInvoiceIds.length > 0) {
    const placeholders = foundInvoiceIds.map((_, i) => `$${i + 2}`).join(',');
    await query(
      `UPDATE qb_invoices_cache SET voided = TRUE WHERE qb_customer_id = $1 AND qb_invoice_id NOT IN (${placeholders})`,
      [String(qbCustomerId), ...foundInvoiceIds]
    );
  } else {
    await query('UPDATE qb_invoices_cache SET voided = TRUE WHERE qb_customer_id = $1', [String(qbCustomerId)]);
  }
  // Mark payments not in QB response as voided
  if (foundPaymentIds.length > 0) {
    const placeholders = foundPaymentIds.map((_, i) => `$${i + 2}`).join(',');
    await query(
      `UPDATE qb_payments_cache SET voided = TRUE WHERE qb_customer_id = $1 AND qb_payment_id NOT IN (${placeholders})`,
      [String(qbCustomerId), ...foundPaymentIds]
    );
  } else {
    await query('UPDATE qb_payments_cache SET voided = TRUE WHERE qb_customer_id = $1', [String(qbCustomerId)]);
  }
}

// ── Core: sync a single customer's financials (paginated) ────────────────────
async function syncCustomerFinancials(qbCustomerId) {
  if (!qbCustomerId) throw new Error('qbCustomerId is required');
  const tokens = await getValidTokens();
  if (!tokens) return { synced: false, reason: 'no_qb_tokens' };
  const result = { qb_customer_id: String(qbCustomerId), invoices: 0, payments: 0, mapped: 0, allocations: 0, errors: [] };
  try {
    // 1. Fetch ALL invoices (paginated) and persist
    const invoices = await qbQueryAll('Invoice', `CustomerRef = '${String(qbCustomerId)}'`, tokens);
    result.invoices = invoices.length;
    const foundInvoiceIds = [];
    for (const inv of invoices) {
      try {
        await upsertInvoiceCacheFromQb({ query }, inv);
        foundInvoiceIds.push(String(inv.Id));
        const mapResult = await autoMapInvoiceToSale(inv, qbCustomerId);
        if (mapResult.mapped) result.mapped++;
      } catch (e) { result.errors.push({ invoice_id: inv.Id, error: e.message }); }
    }

    // 2. Fetch ALL payments (paginated) and persist with allocations
    const payments = await qbQueryAll('Payment', `CustomerRef = '${String(qbCustomerId)}'`, tokens);
    result.payments = payments.length;
    const foundPaymentIds = [];
    for (const payment of payments) {
      try {
        const allocCount = await upsertPaymentWithAllocations(payment, qbCustomerId);
        foundPaymentIds.push(String(payment.Id));
        result.allocations += allocCount;
      } catch (e) { result.errors.push({ payment_id: payment.Id, error: e.message }); }
    }

    // 3. Mark stale cached entities (deleted in QB) as voided
    await markStaleAsVoided(qbCustomerId, foundInvoiceIds, foundPaymentIds);

    // 4. Update lead sync timestamp
    await query('UPDATE leads SET qb_last_sync_at = NOW(), qb_last_sync_result = $1, updated_at = NOW() WHERE qb_customer_id = $2',
      ['success', String(qbCustomerId)]);
    if (tokens.realm_id) { try { await tokenStore.markUsed(SANDBOX ? 'sandbox' : 'production', tokens.realm_id); } catch {} }
    result.synced = true;
    return result;
  } catch (e) {
    result.synced = false; result.error = e.message;
    try { await query('UPDATE leads SET qb_last_sync_at = NOW(), qb_last_sync_result = $1, qb_last_error = $2, updated_at = NOW() WHERE qb_customer_id = $3',
      ['error', e.message.substring(0, 500), String(qbCustomerId)]); } catch {}
    return result;
  }
}

// ── Sync ALL mapped customers (scheduled reconciliation) ─────────────────────
async function syncAllMappedCustomers() {
  if (_syncing) return { skipped: true, reason: 'already_in_progress' };
  _syncing = true;
  try {
    const res = await query('SELECT DISTINCT qb_customer_id FROM leads WHERE qb_customer_id IS NOT NULL AND qb_customer_id != \'\'');
    const customerIds = res.rows.map(r => r.qb_customer_id);
    const results = []; let synced = 0, failed = 0;
    for (const customerId of customerIds) {
      try {
        const r = await syncCustomerFinancials(customerId);
        results.push(r); if (r.synced) synced++; else failed++;
      } catch (e) { results.push({ qb_customer_id: customerId, synced: false, error: e.message }); failed++; }
    }
    return { total: customerIds.length, synced, failed, results };
  } finally { _syncing = false; }
}

// ── Discovery: link unmapped CRM leads to existing QB customers ──────────────
// Conservative matching: requires email OR phone match + name match.
// NEVER guesses. Multiple matches → unresolved.
async function discoverAndLinkUnmappedCustomers() {
  const tokens = await getValidTokens();
  if (!tokens) return { discovered: false, reason: 'no_qb_tokens' };

  // 1. Fetch ALL QB customers (paginated)
  const qbCustomers = await qbQueryAll('Customer', 'Active = true', tokens);

  // 2. Fetch ALL unmapped CRM leads (no qb_customer_id)
  const leadRes = await query(
    'SELECT id, first_name, last_name, email, phone FROM leads WHERE (qb_customer_id IS NULL OR qb_customer_id = \'\') AND first_name IS NOT NULL AND last_name IS NOT NULL'
  );
  const unmappedLeads = leadRes.rows;

  let linked = 0, unresolved = 0, noMatch = 0;
  const unresolvedDetails = [];

  for (const lead of unmappedLeads) {
    const leadEmail = qbMatch.normalizeEmail(lead.email || '');
    const leadPhone = qbMatch.normalizePhone(lead.phone || '');

    // Skip leads with no email AND no phone — can't safely match
    if (!leadEmail && !leadPhone) { noMatch++; continue; }

    const candidates = [];
    for (const cust of qbCustomers) {
      const custEmail = qbMatch.normalizeEmail(cust.PrimaryEmailAddr ? cust.PrimaryEmailAddr.Address : '');
      const custPhone = qbMatch.normalizePhone(cust.PrimaryPhone ? cust.PrimaryPhone.FreeFormNumber : '');
      const custName = cust.DisplayName || '';
      const custId = String(cust.Id);

      let score = 0;
      const matchedOn = [];

      // Email match: strong signal
      if (leadEmail && custEmail && leadEmail === custEmail) { score += 100; matchedOn.push('email'); }
      // Phone match: strong signal
      if (leadPhone && custPhone && leadPhone === custPhone) { score += 80; matchedOn.push('phone'); }
      // Name match: confirming signal (only counts if email or phone also matched)
      if (score > 0 && custName && qbMatch.partialNameMatch(custName, lead.first_name, lead.last_name)) {
        score += 20; matchedOn.push('name');
      }

      // Require at least email or phone match (score >= 80)
      if (score >= 80) {
        candidates.push({ qb_customer_id: custId, score, matchedOn });
      }
    }

    if (candidates.length === 1) {
      // Unambiguous match → persist qb_customer_id
      const match = candidates[0];
      await query(
        'UPDATE leads SET qb_customer_id = $1, qb_last_sync_at = NOW(), qb_last_sync_result = $2, updated_at = NOW() WHERE id = $3',
        [match.qb_customer_id, 'auto_linked', lead.id]
      );
      linked++;
    } else if (candidates.length > 1) {
      // Ambiguous → unresolved
      unresolved++;
      unresolvedDetails.push({ lead_id: lead.id, lead_name: `${lead.first_name} ${lead.last_name}`, candidates: candidates.length });
    } else {
      noMatch++;
    }
  }

  return {
    discovered: true,
    qb_customers_inspected: qbCustomers.length,
    unmapped_leads: unmappedLeads.length,
    linked, unresolved, no_match: noMatch,
    unresolved_details: unresolvedDetails.slice(0, 50), // cap for response size
  };
}

// ── Full historical backfill ─────────────────────────────────────────────────
// Orchestrates: discovery → sync all mapped customers → comprehensive report
async function runFullHistoricalBackfill() {
  const report = {
    phase1_discovery: null,
    phase2_sync: null,
    summary: {},
  };

  // Phase 1: Discovery — link unmapped CRM leads to existing QB customers
  try {
    report.phase1_discovery = await discoverAndLinkUnmappedCustomers();
  } catch (e) {
    report.phase1_discovery = { discovered: false, error: e.message };
  }

  // Phase 2: Sync ALL mapped customers (including newly linked ones)
  try {
    report.phase2_sync = await syncAllMappedCustomers();
  } catch (e) {
    report.phase2_sync = { error: e.message };
  }

  // Build summary
  const disc = report.phase1_discovery || {};
  const sync = report.phase2_sync || {};
  report.summary = {
    qb_customers_inspected: disc.qb_customers_inspected || 0,
    crm_leads_already_mapped: (sync.total || 0) - (disc.linked || 0),
    crm_leads_newly_linked: disc.linked || 0,
    unresolved_customer_matches: disc.unresolved || 0,
    total_invoices_fetched: (sync.results || []).reduce((s, r) => s + (r.invoices || 0), 0),
    total_payments_fetched: (sync.results || []).reduce((s, r) => s + (r.payments || 0), 0),
    total_allocations: (sync.results || []).reduce((s, r) => s + (r.allocations || 0), 0),
    total_invoice_deal_mappings: (sync.results || []).reduce((s, r) => s + (r.mapped || 0), 0),
    total_failed_customers: sync.failed || 0,
    total_synced_customers: sync.synced || 0,
  };

  return report;
}

module.exports = {
  syncCustomerFinancials, syncAllMappedCustomers,
  discoverAndLinkUnmappedCustomers, runFullHistoricalBackfill,
  getValidTokens,
};
