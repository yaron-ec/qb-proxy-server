#!/usr/bin/env node
'use strict';

/**
 * auditFinancialRecords2026.js — read-only financial reconciliation audit
 * for 2026+ deals, built to satisfy the "reconcile existing 2026+ records
 * without destructive migrations" requirement and to give a concrete,
 * repeatable tool for the Lalani-class invoice-misattribution investigation.
 *
 * DESIGN: this script makes ONLY GET requests against the real, authenticated
 * CRM API (never SQL directly, never a write of any kind) and feeds the
 * EXACT same raw data the Financials tab UI fetches into the EXACT same
 * canonical calculation — `crm-frontend/src/lib/financialCalc.js#computeFinancials`,
 * imported directly (not re-implemented), so there is zero duplicate
 * financial-math logic to drift from the one the UI renders. This mirrors
 * CLAUDE.md's own "centralized financial calculation engine" requirement:
 * an audit tool is exactly the kind of "adjacent code" that must reuse that
 * engine, never build a second one.
 *
 * It flags, per deal, for human review (never auto-corrects anything):
 *   - a waterfall computation error on that deal
 *   - a negative remaining customer balance (overpaid beyond contract total)
 *   - a deeply negative or non-finite profit margin
 *   - INVOICE_VS_WATERFALL_MISMATCH — the Lalani-class signal: this deal HAS
 *     at least one direct (qb_invoice_sale_map-attributed) sale-scoped
 *     invoice, and that invoice's own paid amount disagrees with what the
 *     customer-level payment waterfall (lib/customerPaymentWaterfall.js,
 *     the authoritative cross-deal allocator) independently computed this
 *     deal actually received. A deal with ZERO direct invoices relying
 *     entirely on the waterfall is a normal, documented state and is never
 *     flagged on that basis alone — only an existing, conflicting direct
 *     mapping is suspicious. A material mismatch here most likely means
 *     invoices were mapped via qb_invoice_sale_map to the wrong deal for
 *     that customer, exactly as happened to Lalani. This script only
 *     flags; a human decides whether
 *     `POST /api/v1/qb-invoice-mapping/:id/reassign` is warranted, per
 *     CLAUDE.md's "never resolve invoice ownership by amount/customer/date
 *     automatically" rule.
 *   - ADDENDUM_AMOUNT_VS_ESTIMATE_MISMATCH — for an addendum deal
 *     (`parent_deal_id` set) whose lead has EXACTLY ONE `handoff_estimates`
 *     row, this deal's own `amount` disagrees with that estimate's
 *     `estimate_amount` (e.g. the real production finding: a deal stored
 *     as $7,934.00 while its QuickBooks estimate reads $7,934.35). Flags
 *     only — never auto-corrects `deals.amount` or the estimate, per
 *     "do not silently change the contractual value without verifying the
 *     approved CRM record." `handoff_estimates` is keyed by `lead_id`, not
 *     `deal_id` — when a lead has MORE than one estimate, this script
 *     cannot safely tell which one corresponds to this specific addendum
 *     without guessing, so it instead emits
 *     ADDENDUM_AMOUNT_UNVERIFIABLE_MULTIPLE_ESTIMATES listing every
 *     candidate for a human to match by hand.
 *
 * USAGE (read-only, no --apply flag exists in this script at all):
 *   node scripts/auditFinancialRecords2026.js --base-url=<backend URL> --token=<admin JWT> [--year=2026] [--json] [--limit=5000]
 *
 * --base-url: the qb-proxy-server backend's own public URL (never the
 *   frontend's — e.g. https://qb-proxy-server-production.up.railway.app or
 *   the production custom domain if one fronts the backend API directly).
 * --token: a real admin-role Railway JWT access token (DevTools → Application
 *   → Local Storage → railway_access_token, while logged in as an admin).
 *   Never logged, never written to disk by this script.
 *
 * Tested against a disposable local Postgres + dev backend seeded to
 * reproduce the EXACT Lalani shape (two deals for one QB customer, with one
 * deal's invoice deliberately mis-mapped to the other) — confirmed the
 * mismatch is flagged, and confirmed an ordinary single-deal customer is
 * NOT flagged. NOT run against the real production database/API from this
 * environment (no network path to production from this sandbox) — running
 * it against production, with a real admin token, is the operator action
 * this tool exists to make possible.
 */

const path = require('path');

function parseArgs() {
  const out = { year: 2026, json: false, limit: 5000 };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) {
      const [, k, v] = m;
      if (k === 'year' || k === 'limit') out[k] = parseInt(v, 10);
      else if (k === 'json') out.json = v !== 'false';
      else out[k] = v;
    } else if (arg === '--json') {
      out.json = true;
    }
  }
  if (!out['base-url']) throw new Error('--base-url is required (the qb-proxy-server backend URL)');
  if (!out.token) throw new Error('--token is required (an admin Railway JWT access token)');
  return { baseUrl: out['base-url'].replace(/\/+$/, ''), token: out.token, year: out.year, json: out.json, limit: out.limit };
}

async function apiGet(baseUrl, token, p) {
  const res = await fetch(`${baseUrl}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function invoicePaidAmount(inv) {
  if (inv == null) return 0;
  // qb_invoices_cache numeric columns come back from Postgres as strings
  // (not JS numbers) via the raw query path this endpoint uses — never
  // gate on typeof, always coerce with Number(). qb_invoices_cache's own
  // real column names are total_amt/balance/paid (db/migrations); TotalAmt/
  // Balance are only ever seen on a LIVE QuickBooks API response shape,
  // never on this cached-row shape — both are checked so this still works
  // if a future caller passes the live QB shape instead.
  if (inv.paid !== undefined && inv.paid !== null && inv.paid !== '') {
    const n = Number(inv.paid);
    if (Number.isFinite(n)) return n;
  }
  const total = Number(inv.total_amt ?? inv.total_amount ?? inv.TotalAmt ?? 0) || 0;
  const bal = Number(inv.balance ?? inv.Balance ?? 0) || 0;
  return total - bal;
}

/**
 * checkAddendumAmountVsEstimate — pure, no network. Compares an addendum
 * deal's own `amount` against its lead's `handoff_estimates` row(s). Never
 * guesses which estimate applies when more than one exists for the lead
 * (handoff_estimates has no deal_id column at all — see this script's own
 * header) — returns a distinct, explicit "unverifiable" flag instead of
 * picking one.
 *
 * @param {{ amount: number|string, parent_deal_id?: string|null }} deal
 * @param {Array<{ estimate_amount: number|string, qb_estimate_id?: string, qb_estimate_number?: string, id?: string }>} estimates
 * @returns {string|null} a human-readable flag string, or null if nothing to flag
 */
function checkAddendumAmountVsEstimate(deal, estimates) {
  if (!deal || !deal.parent_deal_id) return null; // only an addendum deal has this specific risk
  if (!Array.isArray(estimates) || estimates.length === 0) return null;

  if (estimates.length > 1) {
    const ids = estimates.map((e) => e.qb_estimate_number || e.qb_estimate_id || e.id).filter(Boolean);
    return `ADDENDUM_AMOUNT_UNVERIFIABLE_MULTIPLE_ESTIMATES: lead has ${estimates.length} estimates (${ids.join(', ')}) — cannot safely match one to this addendum deal without human review; deal.amount=$${Number(deal.amount).toFixed(2)}`;
  }

  const est = estimates[0];
  const estAmount = Number(est.estimate_amount);
  const dealAmount = Number(deal.amount);
  if (!Number.isFinite(estAmount) || !Number.isFinite(dealAmount)) return null;
  const diff = estAmount - dealAmount;
  if (Math.abs(diff) > 0.005) {
    const estLabel = est.qb_estimate_number || est.qb_estimate_id || est.id || 'unknown';
    return `ADDENDUM_AMOUNT_VS_ESTIMATE_MISMATCH: deal.amount=$${dealAmount.toFixed(2)} vs QuickBooks estimate ${estLabel} amount=$${estAmount.toFixed(2)} (diff=$${diff.toFixed(2)}) — verify the correct contractual value before changing either; never auto-corrected`;
  }
  return null;
}

async function main() {
  const { baseUrl, token, year, json, limit } = parseArgs();
  const financialCalcPath = path.resolve(__dirname, '..', 'crm-frontend', 'src', 'lib', 'financialCalc.js');
  const { computeFinancials } = await import(`file://${financialCalcPath}`);

  const dealsRes = await apiGet(baseUrl, token, `/api/v1/deals?limit=${limit}&sort=-created_date`);
  const allDeals = dealsRes.items || [];
  if (typeof dealsRes.total === 'number' && dealsRes.total > allDeals.length) {
    console.warn(`[audit] WARNING: ${dealsRes.total} deals exist but only ${allDeals.length} were fetched (--limit=${limit}) — re-run with a higher --limit to cover every deal.`);
  }

  const targetDeals = allDeals.filter((d) => {
    const dateStr = d.sold_date || d.created_at;
    if (!dateStr) return false;
    return new Date(dateStr).getUTCFullYear() >= year;
  });

  console.error(`[audit] ${allDeals.length} total deals fetched; ${targetDeals.length} have sold_date/created_at in ${year} or later.`);

  const results = [];

  for (const deal of targetDeals) {
    try {
      const leadRes = deal.lead_id ? await apiGet(baseUrl, token, `/api/v1/leads/${deal.lead_id}`).catch(() => null) : null;
      const lead = leadRes?.lead || null;

      const [invRes, expRes, comRes, loanRes, finRes, estRes] = await Promise.all([
        deal.lead_id ? apiGet(baseUrl, token, `/api/v1/invoices?lead_id=${deal.lead_id}`).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
        apiGet(baseUrl, token, `/api/v1/deal-expenses?deal_id=${deal.id}`).catch(() => ({ items: [] })),
        apiGet(baseUrl, token, `/api/v1/deal-commissions?deal_id=${deal.id}`).catch(() => ({ items: [] })),
        apiGet(baseUrl, token, `/api/v1/deal-loan-payments?deal_id=${deal.id}`).catch(() => ({ items: [] })),
        apiGet(baseUrl, token, `/api/v1/deals/${deal.id}/financials?sale_total=${encodeURIComponent(deal.amount || 0)}`).catch((e) => ({ __fetchError: e.message })),
        // Only an addendum deal carries the "$7,934.00 vs $7,934.35" risk —
        // handoff_estimates is lead-scoped, never deal-scoped, so this is
        // fetched per-lead and cross-checked by checkAddendumAmountVsEstimate.
        deal.parent_deal_id && deal.lead_id
          ? apiGet(baseUrl, token, `/api/v1/handoff-estimates?lead_id=${deal.lead_id}`).catch(() => ({ items: [] }))
          : Promise.resolve({ items: [] }),
      ]);

      const invoices = invRes.items || [];
      const expenses = expRes.items || [];
      const commissions = comRes.items || [];
      const loanPayments = loanRes.items || [];
      const saleInvoices = finRes.invoices || [];
      const waterfall = finRes.waterfall || null;
      const waterfallError = finRes.waterfallError || finRes.__fetchError || null;
      const leadEstimates = estRes.items || [];

      const fin = computeFinancials({ deal, lead, invoices, saleInvoices, expenses, commissions, loanPayments, waterfall });

      const flags = [];
      if (waterfallError) flags.push(`waterfall_error: ${waterfallError}`);
      if (fin.remainingCustomerBalance < -0.01) flags.push(`negative_remaining_balance: ${fin.remainingCustomerBalance.toFixed(2)}`);
      if (Number.isFinite(fin.profitMargin) && fin.profitMargin < -50) flags.push(`deeply_negative_margin: ${fin.profitMargin}%`);
      if (!Number.isFinite(fin.profitMargin) && fin.totalCosts > 0) flags.push('non_finite_margin_with_costs');

      // A deal with ZERO direct (qb_invoice_sale_map) invoices, relying
      // entirely on the customer-level waterfall for its "paid" figure, is
      // a NORMAL, documented state (routes/dealFinancials.js's own header
      // comment) — never flag on that alone. The Lalani-class bug is the
      // opposite shape: a deal DOES have direct invoice attribution, and
      // that attribution disagrees with what the independent, authoritative
      // waterfall says this deal actually received — i.e. the direct
      // mapping itself is likely wrong (attached to this deal instead of a
      // sibling deal for the same customer, or vice versa).
      const naivePaid = saleInvoices.reduce((sum, inv) => sum + invoicePaidAmount(inv), 0);
      const waterfallPaid = waterfall && waterfall.applied && waterfall.this_deal_allocation
        ? Number(waterfall.this_deal_allocation.allocated_paid) || 0
        : null;
      if (naivePaid > 0.01 && waterfallPaid !== null && Math.abs(naivePaid - waterfallPaid) > 1) {
        flags.push(`INVOICE_VS_WATERFALL_MISMATCH: naive_invoice_paid=${naivePaid.toFixed(2)} waterfall_allocated_paid=${waterfallPaid.toFixed(2)} diff=${(naivePaid - waterfallPaid).toFixed(2)}`);
      }

      const addendumAmountFlag = checkAddendumAmountVsEstimate(deal, leadEstimates);
      if (addendumAmountFlag) flags.push(addendumAmountFlag);

      results.push({
        deal_id: deal.id,
        deal_name: deal.name,
        lead_id: deal.lead_id,
        customer: lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : null,
        qb_customer_id: lead ? lead.qb_customer_id : null,
        sold_date: deal.sold_date,
        stage: deal.stage,
        contract_total: fin.totalRevenue,
        collected: fin.paymentsReceived,
        remaining_balance: fin.remainingCustomerBalance,
        total_costs: fin.totalCosts,
        profit: fin.netProfit,
        margin_pct: fin.profitMargin,
        flags,
      });
    } catch (e) {
      results.push({ deal_id: deal.id, deal_name: deal.name, error: e.message, flags: ['fetch_error'] });
    }
  }

  const flagged = results.filter((r) => r.flags && r.flags.length > 0);

  if (json) {
    console.log(JSON.stringify({ year, total_deals_checked: results.length, flagged_count: flagged.length, results }, null, 2));
    return;
  }

  console.log(`\n=== Financial Records Audit — ${year}+ deals ===`);
  console.log(`Checked: ${results.length}   Flagged for review: ${flagged.length}\n`);
  if (flagged.length === 0) {
    console.log('No anomalies found among the checked deals.');
  } else {
    for (const r of flagged) {
      console.log(`--- ${r.deal_name || r.deal_id} (${r.customer || 'unknown customer'}) ---`);
      console.log(`  deal_id: ${r.deal_id}`);
      if (r.error) {
        console.log(`  ERROR: ${r.error}`);
      } else {
        console.log(`  contract_total=$${r.contract_total}  collected=$${r.collected}  remaining=$${r.remaining_balance}  profit=$${r.profit} (${r.margin_pct}%)`);
      }
      for (const f of r.flags) console.log(`  FLAG: ${f}`);
      console.log('');
    }
  }
}

module.exports = { invoicePaidAmount, parseArgs, checkAddendumAmountVsEstimate };

if (require.main === module) {
  main().catch((e) => {
    console.error('[audit] fatal:', e.message);
    process.exit(1);
  });
}
