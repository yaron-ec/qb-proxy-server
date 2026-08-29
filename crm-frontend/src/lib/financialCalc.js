/**
 * financialCalc.js — shared financial helpers + summary calculation.
 * Used by the Deal Financials tab. No backend calls.
 */

export function safeNumber(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatCurrency(v) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeNumber(v));
}

export function formatPercent(v, digits = 2) {
  const n = safeNumber(v);
  return `${Number(n.toFixed(digits))}%`;
}

export function formatDate(d) {
  if (!d) return "—";
  try {
    const s = String(d);
    return new Date(s.length <= 10 ? s + "T00:00:00" : s).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return String(d);
  }
}

export function leadCostBase(deal, ctx) {
  switch (deal?.lead_cost_calculation_base) {
    case "payments_received": return ctx.paymentsReceived;
    case "gross_profit_before_lead_cost": return ctx.totalRevenue;
    case "custom": return safeNumber(deal?.lead_cost_custom_base_amount);
    case "total_contract":
    default: return ctx.totalRevenue;
  }
}

export function computeLeadCost(deal, ctx) {
  if (deal?.lead_cost_type === "fixed") return round2(safeNumber(deal?.lead_cost_fixed_amount));
  return round2(leadCostBase(deal, ctx) * (safeNumber(deal?.lead_cost_percentage) / 100));
}

export function commissionBase(c, ctx) {
  switch (c?.calculation_base) {
    case "payments_received": return ctx.paymentsReceived;
    case "gross_profit_before_commission": return ctx.grossProfitBeforeCommission;
    case "custom": return safeNumber(c?.custom_base_amount);
    case "total_contract":
    default: return ctx.totalRevenue;
  }
}

export function commissionAmount(c, ctx) {
  if (!c || c.status === "Cancelled") return 0;
  if (c.commission_type === "fixed") return round2(safeNumber(c.commission_fixed_amount));
  return round2(commissionBase(c, ctx) * (safeNumber(c.commission_percentage) / 100));
}

/**
 * getDealPaymentSummary — THE single source of truth for deal payment KPIs.
 *
 * Every financial display component in the CRM — the Financial tab KPI chips,
 * Payment Progress, Financial Summary, Dashboard widgets, Reports — MUST call
 * this function. Never recalculate Invoiced / Paid / Balance / Remaining
 * separately in a component.
 *
 * Reads from the lead's synchronized QuickBooks fields, which are kept current
 * by getQBLeadStatus (sums across ALL active non-voided QB invoices and writes
 * the totals back to the lead entity):
 *   lead.qb_invoice_amount   = sum of all active (non-voided) QB invoice totals
 *   lead.qb_payment_received = total payments received from QuickBooks
 *   lead.qb_balance_due      = invoiced - paid (QB-side balance)
 *
 * When QB is NOT connected, falls back to local Invoice records or deal milestones.
 *
 * Formula (global financial architecture):
 *   Project Total = deal.amount || lead.estimated_value
 *   Invoiced  = lead.qb_invoice_amount  (QB) || sum(local invoice amounts)
 *   Paid      = lead.qb_payment_received (QB) || sum(local invoice payments) || deal milestones
 *   Balance   = Invoiced - Paid   (unpaid portion of what's been billed)
 *   Remaining = Project Total - Paid  (total left to collect on the project)
 *   Pct Paid  = Paid / Project Total * 100
 *
 * @returns {{ hasQB, projectTotal, invoiced, paid, balance, remaining, pctPaid }}
 */
export function getDealPaymentSummary(deal, lead, invoices = [], saleInvoices = null) {
  const hasQB = !!(lead?.qb_invoice_id || (Number(lead?.qb_invoice_amount) > 0));
  const invs = invoices || [];

  const projectTotal = safeNumber(deal?.amount) || safeNumber(lead?.estimated_value);

  // ── Sale-scoped path (sale-level financial isolation) ──
  // When sale-scoped QB invoices are supplied (each mapped to THIS deal's
  // crm_sale_id via Railway qb_invoice_sale_map), compute invoiced/paid from
  // them ONLY. No customer-level fallback is permitted for multi-Sale leads —
  // unmapped invoices contribute to no Sale. The caller is responsible for
  // passing saleInvoices for multi-Sale leads; omitting them for a single-Sale
  // lead falls through to the legacy path below.
  if (saleInvoices && saleInvoices.length > 0) {
    const invoiced = saleInvoices.reduce((s, i) => s + safeNumber(i.total_amt ?? i.totalAmt ?? i.amount), 0);
    const paid = saleInvoices.reduce((s, i) => s + safeNumber(i.paid ?? i.payment_received), 0);
    const balance = round2(Math.max(0, invoiced - paid));
    const remaining = round2(Math.max(0, projectTotal - paid));
    const pctPaid = projectTotal > 0 ? Math.min(100, Math.round((paid / projectTotal) * 100)) : 0;
    return { hasQB: true, projectTotal, invoiced: round2(invoiced), paid: round2(paid), balance, remaining, pctPaid, saleScoped: true };
  }

  // ── Legacy path (single-Sale leads / backward compatibility) ──
  // Uses lead-level QB aggregates. Correct ONLY when the lead has exactly one
  // Sale. For multi-Sale leads the caller MUST supply saleInvoices instead.
  const localInvoiceTotal = invs.reduce((s, i) => s + safeNumber(i.amount), 0);
  const localInvoicePaid  = invs.reduce((s, i) => s + safeNumber(i.payment_received), 0);
  const milestonePaid =
    safeNumber(deal?.deposit_paid) +
    safeNumber(deal?.progress_payment_paid) +
    safeNumber(deal?.final_payment_paid);

  const invoiced = hasQB ? safeNumber(lead?.qb_invoice_amount) : localInvoiceTotal;

  const paid = hasQB
    ? safeNumber(lead?.qb_payment_received)
    : (localInvoicePaid || safeNumber(deal?.total_paid) || milestonePaid);

  const balance   = round2(Math.max(0, invoiced - paid));
  const remaining = round2(Math.max(0, projectTotal - paid));
  const pctPaid   = projectTotal > 0 ? Math.min(100, Math.round((paid / projectTotal) * 100)) : 0;

  return { hasQB, projectTotal, invoiced, paid, balance, remaining, pctPaid };
}

export function computeFinancials({ deal, lead, invoices, expenses, commissions, loanPayments }) {
  const hasQB = !!lead?.qb_invoice_id;
  const qbInvoiceAmount = safeNumber(lead?.qb_invoice_amount);
  const qbPaymentReceived = safeNumber(lead?.qb_payment_received);

  const contractAmount = hasQB && qbInvoiceAmount > 0 ? qbInvoiceAmount : safeNumber(deal?.amount);
  const changeOrders = safeNumber(deal?.financial_change_orders_amount);
  const manualAdj = safeNumber(deal?.financial_manual_revenue_adjustment);
  const totalRevenue = round2(contractAmount + changeOrders + manualAdj);

  // ── paymentsReceived delegates to the shared helper so the P&L always
  // matches the Financial tab / Payment Progress / Financial Summary. ──
  const paymentsReceived = getDealPaymentSummary(deal, lead, invoices).paid;
  const remainingCustomerBalance = round2(Math.max(0, totalRevenue - paymentsReceived));

  const ctx0 = { totalRevenue, paymentsReceived };
  const leadCostAmount = computeLeadCost(deal, ctx0);
  const companyShareAmount = round2(totalRevenue - leadCostAmount);

  const activeExpenses = (expenses || []).filter(
    (e) => e.include_in_profit_calculation !== false && e.payment_status !== "Cancelled"
  );
  const totalVendorExpenses = round2(
    activeExpenses.reduce((s, e) => {
      const amt = safeNumber(e.amount);
      return e.payment_status === "Refunded" ? s - amt : s + amt;
    }, 0)
  );

  const totalLoanInterest = round2(
    (loanPayments || []).reduce(
      (s, lp) =>
        s + safeNumber(lp.interest_amount) + safeNumber(lp.fee_amount) + safeNumber(lp.other_cost_amount),
      0
    )
  );

  const otherIncludedCosts = safeNumber(deal?.financial_other_costs_amount);

  const grossProfitBeforeCommission = round2(
    totalRevenue - leadCostAmount - totalVendorExpenses - totalLoanInterest - otherIncludedCosts
  );

  const ctx = { totalRevenue, paymentsReceived, grossProfitBeforeCommission };
  const activeCommissions = (commissions || []).filter((c) => c.status !== "Cancelled");
  const salesCommissionAmount = round2(
    activeCommissions.reduce((s, c) => s + commissionAmount(c, ctx), 0)
  );
  const commissionPaid = round2(activeCommissions.reduce((s, c) => s + safeNumber(c.paid_amount), 0));
  const commissionBalance = round2(salesCommissionAmount - commissionPaid);

  const totalCosts = round2(
    leadCostAmount + salesCommissionAmount + totalVendorExpenses + totalLoanInterest + otherIncludedCosts
  );
  const netProfit = round2(totalRevenue - totalCosts);
  const profitMargin = totalRevenue > 0 ? round2((netProfit / totalRevenue) * 100) : 0;

  return {
    hasQB,
    contractAmount,
    changeOrders,
    manualAdj,
    totalRevenue,
    paymentsReceived,
    remainingCustomerBalance,
    leadCostAmount,
    companyShareAmount,
    totalVendorExpenses,
    totalLoanInterest,
    otherIncludedCosts,
    salesCommissionAmount,
    commissionPaid,
    commissionBalance,
    totalCosts,
    netProfit,
    profitMargin,
    ctx,
  };
}