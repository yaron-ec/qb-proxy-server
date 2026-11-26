/* eslint-disable no-undef */
'use strict';

/**
 * dealFinancialAggregation — the "Master Project" consolidated financial
 * picture across a parent deal and all of its approved addendums.
 *
 * Built for the November 2026 production correction: "the master project
 * must show consolidated totals for the original contract and all approved
 * addendums, without double-counting invoices, payments, or expenses."
 *
 * Reuses, never re-implements:
 *   - routes/dealFinancials.js#getSaleFinancialSummary for each deal's own
 *     invoiced/paid/balance — the SAME direct-invoice-vs-waterfall
 *     precedence rule the single-deal endpoint uses (see that file's own
 *     root-cause-fix comment).
 *   - crm-frontend/src/lib/financialCalc.js#computeFinancials, imported
 *     directly (dynamic import — it is a self-contained ES module with no
 *     React/browser dependency, the same technique already proven in
 *     scripts/auditFinancialRecords2026.js) for each deal's own revenue/
 *     cost/profit math, so this aggregation can never drift from what a
 *     single deal's own Financials tab displays.
 *
 * No double-counting: each deal (the parent + each addendum) is summed
 * EXACTLY ONCE into the combined totals — an addendum's own figures are
 * never also folded into the parent's standalone figures, and the parent's
 * own `deal.amount` is never added a second time when summing addendums'
 * contract amounts (matches the existing GET /:id/addendums contract-value
 * rule this module extends).
 */
const path = require('path');
const { round2 } = require('./qbInvoiceSaleMap');
const { getCustomerTotalReceived, allocateWaterfall } = require('./customerPaymentWaterfall');

const FINANCIAL_CALC_PATH = path.resolve(__dirname, '..', 'crm-frontend', 'src', 'lib', 'financialCalc.js');

async function loadComputeFinancials() {
  const mod = await import(`file://${FINANCIAL_CALC_PATH}`);
  return mod.computeFinancials;
}

/**
 * Compute each deal's own full financial picture (revenue/costs/profit),
 * then sum across deals. `rootDeal` and each of `addendumDeals` are raw
 * `deals` table rows (must include at least id, lead_id, amount, name, and
 * every column computeFinancials reads off `deal`).
 *
 * @param db              { query }
 * @param rootDeal        the parent deal's own row
 * @param addendumDeals   array of this root's addendum deal rows
 * @returns the combined Master Project summary + a per-deal breakdown
 */
async function computeMasterFinancials(db, rootDeal, addendumDeals) {
  const computeFinancials = await loadComputeFinancials();

  const leadId = rootDeal.lead_id;
  const [leadRes, invoicesRes] = await Promise.all([
    leadId
      ? db.query(
          `SELECT l.*, o.display_name AS owner_display_name, o.email AS owner_email
           FROM leads l LEFT JOIN owners o ON o.id = l.owner_id WHERE l.id = $1`,
          [leadId]
        )
      : Promise.resolve({ rows: [] }),
    // Legacy, lead-scoped invoices — intentionally shared across every deal
    // on this lead, matching the exact input crm-frontend/src/pages/DealDetail.jsx
    // already passes into computeFinancials for ANY single deal on this
    // lead today (pre-existing behavior, unchanged by this aggregation).
    leadId ? db.query('SELECT * FROM invoices WHERE lead_id = $1', [leadId]) : Promise.resolve({ rows: [] }),
  ]);
  const lead = leadRes.rows[0] || null;
  const sharedInvoices = invoicesRes.rows;

  const allDeals = [rootDeal, ...addendumDeals];
  const perDeal = [];
  for (const deal of allDeals) {
    const saleTotal = Number(deal.amount) || 0;
    const { summary, invoices: saleInvoices, waterfall, waterfallError } = await require('../routes/dealFinancials')
      .getSaleFinancialSummary(db, deal.id, saleTotal);
    const [expRes, comRes, loanRes] = await Promise.all([
      db.query('SELECT * FROM deal_expenses WHERE deal_id = $1', [deal.id]),
      db.query('SELECT * FROM deal_commissions WHERE deal_id = $1', [deal.id]),
      db.query('SELECT * FROM deal_loan_payments WHERE deal_id = $1', [deal.id]),
    ]);
    const fin = computeFinancials({
      deal, lead, invoices: sharedInvoices, saleInvoices,
      expenses: expRes.rows, commissions: comRes.rows, loanPayments: loanRes.rows,
      waterfall,
    });
    // November 2026 production correction — "Lalani $49,965 Collected"
    // double-counting bug. This deal's OWN saleScopedPaid (the real,
    // directly-attributed qb_invoice_sale_map-backed paid amount) is the
    // one authoritative claim on the customer's total received money
    // this deal can make — matches getDealPaymentSummary's own
    // `directWins = saleScopedPaid > 0` precedence rule exactly, so this
    // never disagrees with what the single-deal Financials tab would
    // independently compute for THIS deal in isolation.
    const saleScopedPaid = round2((saleInvoices || []).reduce((s, i) => s + (Number(i.paid ?? i.payment_received) || 0), 0));
    const hasDirectClaim = saleInvoices.length > 0 && saleScopedPaid > 0;
    perDeal.push({
      deal_id: deal.id,
      deal_name: deal.name,
      is_root: deal.id === rootDeal.id,
      invoiced: fin.invoiced,
      // `collected` below is corrected in the second pass for any deal that
      // relies on the customer-level waterfall fallback (never for a deal
      // with its own direct invoice claim) — see the de-duplication pass
      // below this loop for why a naive per-deal sum double-counts.
      collected: fin.paymentsReceived,
      outstanding: fin.remainingCustomerBalance,
      total_costs: fin.totalCosts,
      profit: fin.netProfit,
      sale_invoice_count: saleInvoices.length,
      waterfallError: waterfallError || null,
      // Signals this specific deal's direct-invoice total vs. its own
      // waterfall-estimated share, independent of the combined-contract
      // comparison below — surfaced so an admin reviewing one addendum can
      // tell whether THAT deal's own number came from a real mapped
      // invoice or (only when it had none) the waterfall fallback.
      used_waterfall_fallback: saleInvoices.length === 0 && !!(waterfall && waterfall.applied),
      _hasDirectClaim: hasDirectClaim,
      _directPaid: hasDirectClaim ? saleScopedPaid : 0,
      _qbCustomerId: waterfall && waterfall.applied ? waterfall.customer_qb_customer_id : null,
      _sortKey: [deal.sold_date || deal.created_at || '', String(deal.id)],
      _totalRevenue: fin.totalRevenue,
    });
  }

  // De-duplicate "collected" across sibling deals before summing.
  //
  // ROOT CAUSE (confirmed via the Ali & Mohemmed Lalani production report,
  // November 2026 — $42,031 (root, direct invoice claim) + $7,934
  // (addendum, waterfall fallback) = $49,965 displayed, a $9,031
  // overstatement): `lib/customerPaymentWaterfall.js#computeWaterfallForDeal`
  // allocates the SAME customer-level pool of received QuickBooks money
  // (`getCustomerTotalReceived`) independently for EVERY deal that calls it
  // — correct for a single-deal lookup in isolation, but when a sibling
  // deal in the SAME master project already has its OWN real, directly-
  // attributed invoice claim on that pool (via qb_invoice_sale_map), that
  // claim is never subtracted before the waterfall computes a fallback
  // deal's own "share" — so the same real dollars can be counted once via
  // the direct deal and AGAIN via the fallback deal's independent
  // allocation. Fixed by computing one, group-wide allocation: every
  // direct-claim deal's money is set aside FIRST (`directClaimed`,
  // authoritative, never re-attributed), then ONLY the genuinely
  // unclaimed remainder of that same customer's total received money
  // (`customerTotalReceived - directClaimed`) is allocated — via the exact
  // same chronological, contract-capped `allocateWaterfall` sequence the
  // single-deal waterfall already uses — across the sibling deals that
  // have no direct claim of their own. A deal with no QuickBooks customer
  // at all (waterfall never applied) is left completely untouched here —
  // its own `fin.paymentsReceived` (manual-invoice/milestone data,
  // independent of the QB-customer pool) carries no double-counting risk
  // and is not corrected.
  //
  // This intentionally does NOT change what a single deal's OWN Financials
  // tab shows in isolation (routes/dealFinancials.js / financialCalc.js are
  // untouched) — only this consolidated Master Project aggregation, and
  // only the deals explicitly passed in here.
  const directClaimDeals = perDeal.filter((d) => d._hasDirectClaim);
  const fallbackDeals = perDeal.filter((d) => !d._hasDirectClaim && d._qbCustomerId);
  const directClaimedByCustomer = new Map();
  for (const d of directClaimDeals) {
    const key = d._qbCustomerId || '__no_qb_customer__';
    directClaimedByCustomer.set(key, round2((directClaimedByCustomer.get(key) || 0) + d._directPaid));
  }
  const fallbackByCustomer = new Map();
  for (const d of fallbackDeals) {
    const key = d._qbCustomerId;
    if (!fallbackByCustomer.has(key)) fallbackByCustomer.set(key, []);
    fallbackByCustomer.get(key).push(d);
  }
  // Real money received from a customer can genuinely exceed what this
  // specific Master Project's own fallback deals can absorb (each capped
  // at its own contract amount, mirroring the single-deal waterfall's
  // existing, deliberate "never guess which deal an overpayment belongs
  // to" behavior) — `allocateWaterfall` reports that leftover as
  // `customer_excess` rather than attributing it to any one deal. Per the
  // explicit business rule ("genuine overpayments must remain visible —
  // never simply cap collected revenue at the contract value"), that
  // excess is still real collected revenue for THIS customer and must not
  // be silently dropped from the combined total — it is added to the
  // group-level `collected` figure (never attributed to a specific deal,
  // since the waterfall itself has no evidence of which one it belongs
  // to) and separately reported as `unattributed_customer_excess` so it is
  // never mistaken for ordinary per-deal collected revenue.
  let unattributedExcess = 0;
  for (const [qbCustomerId, deals] of fallbackByCustomer) {
    const customerTotalReceived = await getCustomerTotalReceived(db, qbCustomerId);
    const alreadyClaimed = directClaimedByCustomer.get(qbCustomerId) || 0;
    const remainingPool = round2(Math.max(0, customerTotalReceived - alreadyClaimed));
    const orderedDeals = [...deals].sort((a, b) => {
      if (a._sortKey[0] !== b._sortKey[0]) return a._sortKey[0] < b._sortKey[0] ? -1 : 1;
      return a._sortKey[1] < b._sortKey[1] ? -1 : a._sortKey[1] > b._sortKey[1] ? 1 : 0;
    });
    const { allocations, customer_excess } = allocateWaterfall(
      remainingPool,
      orderedDeals.map((d) => ({
        id: d.deal_id,
        amount: Number((allDeals.find((x) => x.id === d.deal_id) || {}).amount) || 0,
        name: d.deal_name,
      }))
    );
    for (const alloc of allocations) {
      const target = perDeal.find((d) => d.deal_id === alloc.deal_id);
      if (target) target.collected = round2(alloc.allocated_paid);
    }
    unattributedExcess = round2(unattributedExcess + (Number(customer_excess) || 0));
  }
  // Recompute each deal's own `outstanding` (remaining customer balance)
  // from its (possibly corrected) `collected` — unchanged for a
  // direct-claim or non-QB deal, and now internally consistent for a
  // corrected fallback deal rather than mixing its OLD (double-counted)
  // collected figure against its own total revenue. `profit` (the
  // CONTRACT-based, planning-only figure) is deliberately left untouched —
  // it was never derived from `collected` and carries no double-counting
  // risk from this fix.
  for (const d of perDeal) {
    d.outstanding = round2(Math.max(0, d._totalRevenue - d.collected));
    delete d._hasDirectClaim;
    delete d._directPaid;
    delete d._qbCustomerId;
    delete d._sortKey;
    delete d._totalRevenue;
  }

  const sum = (key) => round2(perDeal.reduce((s, d) => s + (Number(d[key]) || 0), 0));
  const originalContractAmount = round2(Number(rootDeal.amount) || 0);
  const approvedAddendumsAmount = round2(addendumDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0));
  const totalApprovedContract = round2(originalContractAmount + approvedAddendumsAmount);
  const invoiced = sum('invoiced');
  const collected = round2(sum('collected') + unattributedExcess);
  const totalCosts = sum('total_costs');
  // PROJECTED PROFIT (contract-based) — unchanged in meaning: planning-only,
  // measured against the full combined approved contract value. See
  // actual_profit below for the primary, collected-revenue-based figure.
  const projectedProfit = round2(totalApprovedContract - totalCosts);
  const profitMarginPct = totalApprovedContract > 0 ? round2((projectedProfit / totalApprovedContract) * 100) : 0;
  const outstanding = round2(Math.max(0, totalApprovedContract - collected));

  // ACTUAL PROFIT / ACTUAL PROFIT MARGIN (November 2026 business rule —
  // see crm-frontend/src/lib/financialCalc.js#computeFinancials's own
  // header for the full rationale: EC issues invoices only after receiving
  // the customer's check, so collected revenue IS realized revenue).
  // Consolidated the SAME way every other Master Project figure already is
  // — summed once per deal via the `sum()` helper above, never re-derived
  // from the combined contract value. No new revenue is inferred and no
  // payment is fabricated: `collected` and `totalCosts` are the exact same
  // per-deal sums every other Master Project figure already uses.
  const actualProfit = round2(collected - totalCosts);
  const actualProfitMarginPct = collected > 0 ? round2((actualProfit / collected) * 100) : 0;

  // Requirement: surface (never silently force-reconcile) any gap between
  // what's actually been invoiced across every deal in this project and
  // the combined APPROVED CONTRACT value — invoiced can legitimately
  // exceed the contract (change orders invoiced before the CRM's own
  // contract amount was updated, sales tax, a permit-fee line item billed
  // separately) or fall short of it (work not yet invoiced). Either way
  // this is a fact for a human to review against the real QuickBooks
  // invoice list, never something this aggregation corrects on its own.
  const invoicedVsContractDiscrepancy = round2(invoiced - totalApprovedContract);

  return {
    original_contract_amount: originalContractAmount,
    approved_addendums_amount: approvedAddendumsAmount,
    total_approved_contract: totalApprovedContract,
    invoiced,
    collected,
    outstanding,
    total_costs: totalCosts,
    projected_profit: projectedProfit,
    profit_margin_pct: profitMarginPct,
    actual_profit: actualProfit,
    actual_profit_margin_pct: actualProfitMarginPct,
    invoiced_vs_contract_discrepancy: invoicedVsContractDiscrepancy,
    has_invoiced_vs_contract_discrepancy: Math.abs(invoicedVsContractDiscrepancy) > 0.01,
    unattributed_customer_excess: round2(unattributedExcess),
    per_deal: perDeal,
  };
}

module.exports = { computeMasterFinancials };
