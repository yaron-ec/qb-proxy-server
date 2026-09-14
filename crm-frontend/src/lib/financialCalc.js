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
 * WATERFALL PRECEDENCE: When the customer payment waterfall is applied
 * (waterfallAllocation.applied === true AND this_deal_allocation exists),
 * the waterfall's allocated_paid / allocated_remaining take PRECEDENCE over
 * both the sale-scoped path and the legacy path. The waterfall is the
 * authoritative customer-level allocation from QuickBooks received money.
 *
 * This ensures the UI never shows $0 paid when QuickBooks has received money
 * for the customer, even when invoices are not mapped to this sale or the
 * cache has stale paid=0 values.
 *
 * Manual payment schedule (deposit_paid, progress_payment_paid,
 * final_payment_paid) is NEVER read or mutated here — those are displayed
 * separately by DealPaymentPanel.
 */
export function getDealPaymentSummary(deal, lead, invoices = [], saleInvoices = null, waterfallAllocation = null) {
  const hasQB = !!(lead?.qb_invoice_id || (Number(lead?.qb_invoice_amount) > 0));
  const invs = invoices || [];

  const projectTotal = safeNumber(deal?.amount) || safeNumber(lead?.estimated_value);

  // Waterfall allocation — authoritative customer-level QB received money.
  // Takes PRECEDENCE over both sale-scoped and legacy paths when applied.
  const waterfallApplied = !!(waterfallAllocation?.applied && waterfallAllocation?.this_deal_allocation);
  const waterfallPaid = waterfallApplied
    ? safeNumber(waterfallAllocation.this_deal_allocation.allocated_paid)
    : null;
  const waterfallRemaining = waterfallApplied
    ? safeNumber(waterfallAllocation.this_deal_allocation.allocated_remaining)
    : null;

  // Sale-scoped path — INVOICED from sale-scoped invoices, PAID from waterfall.
  if (saleInvoices && saleInvoices.length > 0) {
    const invoiced = saleInvoices.reduce((s, i) => s + safeNumber(i.total_amt ?? i.totalAmt ?? i.amount), 0);
    const saleScopedPaid = saleInvoices.reduce((s, i) => s + safeNumber(i.paid ?? i.payment_received), 0);
    const paid = waterfallPaid !== null ? waterfallPaid : saleScopedPaid;
    const balance = round2(Math.max(0, invoiced - paid));
    const remaining = waterfallRemaining !== null ? waterfallRemaining : round2(Math.max(0, projectTotal - paid));
    const pctPaid = projectTotal > 0 ? Math.min(100, round2((paid / projectTotal) * 100 * 100) / 100) : 0;
    return { hasQB: true, projectTotal, invoiced: round2(invoiced), paid: round2(paid), balance, remaining, pctPaid, saleScoped: true, waterfall: waterfallAllocation };
  }

  // Legacy path — single-Sale leads / backward compatibility.
  const localInvoiceTotal = invs.reduce((s, i) => s + safeNumber(i.amount), 0);
  const localInvoicePaid  = invs.reduce((s, i) => s + safeNumber(i.payment_received), 0);
  const milestonePaid =
    safeNumber(deal?.deposit_paid) +
    safeNumber(deal?.progress_payment_paid) +
    safeNumber(deal?.final_payment_paid);

  const invoiced = hasQB ? safeNumber(lead?.qb_invoice_amount) : localInvoiceTotal;

  const paid = waterfallPaid !== null
    ? waterfallPaid
    : (hasQB
      ? safeNumber(lead?.qb_payment_received)
      : (localInvoicePaid || safeNumber(deal?.total_paid) || milestonePaid));

  const balance   = round2(Math.max(0, invoiced - paid));
  const remaining = waterfallRemaining !== null ? waterfallRemaining : round2(Math.max(0, projectTotal - paid));
  const pctPaid   = projectTotal > 0 ? Math.min(100, round2((paid / projectTotal) * 100 * 100) / 100) : 0;

  return { hasQB, projectTotal, invoiced, paid, balance, remaining, pctPaid, waterfall: waterfallAllocation };
}

export function computeFinancials({ deal, lead, invoices, saleInvoices, expenses, commissions, loanPayments, waterfall }) {
  const hasQB = !!lead?.qb_invoice_id;
  const qbInvoiceAmount = safeNumber(lead?.qb_invoice_amount);
  const qbPaymentReceived = safeNumber(lead?.qb_payment_received);

  const contractAmount = hasQB && qbInvoiceAmount > 0 ? qbInvoiceAmount : safeNumber(deal?.amount);
  const changeOrders = safeNumber(deal?.financial_change_orders_amount);
  const manualAdj = safeNumber(deal?.financial_manual_revenue_adjustment);
  const totalRevenue = round2(contractAmount + changeOrders + manualAdj);

  const paymentsReceived = getDealPaymentSummary(deal, lead, invoices, saleInvoices, waterfall).paid;
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
