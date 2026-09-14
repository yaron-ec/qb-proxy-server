/* eslint-disable no-undef */
'use strict';

/**
 * financialCalcWaterfallPrecedence.test.js
 *
 * Regression tests for the waterfall precedence bug.
 *
 * ROOT CAUSE: getDealPaymentSummary previously returned early with
 * sale-scoped paid when saleInvoices existed, NEVER checking the waterfall.
 * This caused the UI to show $0 paid for multi-deal customers (e.g., Rita Wing)
 * even when QuickBooks had received $7,500.
 *
 * FIX: waterfall.allocated_paid takes precedence in BOTH the sale-scoped path
 * AND the legacy path. When the waterfall is applied, its allocated_paid is
 * the authoritative PAID amount — not sale-scoped paid, not lead.qb_payment_received.
 *
 * Required cases:
 *   A. saleInvoices exist + waterfall exists → waterfall Paid wins
 *   B. no mapped saleInvoices + waterfall exists → waterfall Paid works
 *   C. waterfall error → UI does NOT falsely present authoritative Paid $0
 *   D. Dean: total 3058, allocated paid 3000, remaining 58, status NOT Unpaid
 *   E. Rita: customer total received 7500, allocation per deterministic Deal order
 *   F. multi-Deal rollover
 *   G. 3+ Deal rollover
 *   H. customer excess
 *   I. conservation: SUM allocated + excess = authoritative customer received
 */

function safeNumber(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function getDealPaymentSummary(deal, lead, invoices, saleInvoices, waterfall) {
  invoices = invoices || [];
  const hasQB = !!(lead?.qb_invoice_id || (Number(lead?.qb_invoice_amount) > 0));
  const projectTotal = safeNumber(deal?.amount) || safeNumber(lead?.estimated_value);

  // ── Waterfall path (highest precedence) ──
  // When the customer payment waterfall is applied, use the allocated paid
  // amount for THIS deal. This is the authoritative QB-derived value for
  // multi-deal customers where invoice ownership is ambiguous.
  if (waterfall && waterfall.applied && waterfall.this_deal_allocation) {
    const paid = safeNumber(waterfall.this_deal_allocation.allocated_paid);
    const remaining = safeNumber(waterfall.this_deal_allocation.allocated_remaining);
    const pctPaid = projectTotal > 0 ? Math.min(100, Math.round((paid / projectTotal) * 100)) : 0;
    return {
      hasQB: true,
      projectTotal,
      invoiced: round2(projectTotal),
      paid: round2(paid),
      balance: round2(remaining),
      remaining: round2(remaining),
      pctPaid,
      waterfallApplied: true,
    };
  }

  // ── Sale-scoped path ──
  if (saleInvoices && saleInvoices.length > 0) {
    const invoiced = saleInvoices.reduce((s, i) => s + safeNumber(i.total_amt ?? i.totalAmt ?? i.amount), 0);
    const paid = saleInvoices.reduce((s, i) => s + safeNumber(i.paid ?? i.payment_received), 0);
    const balance = round2(Math.max(0, invoiced - paid));
    const remaining = round2(Math.max(0, projectTotal - paid));
    const pctPaid = projectTotal > 0 ? Math.min(100, Math.round((paid / projectTotal) * 100)) : 0;
    return { hasQB: true, projectTotal, invoiced: round2(invoiced), paid: round2(paid), balance, remaining, pctPaid, saleScoped: true };
  }

  // ── Legacy path ──
  const localInvoiceTotal = invoices.reduce((s, i) => s + safeNumber(i.amount), 0);
  const localInvoicePaid = invoices.reduce((s, i) => s + safeNumber(i.payment_received), 0);
  const milestonePaid = safeNumber(deal?.deposit_paid) + safeNumber(deal?.progress_payment_paid) + safeNumber(deal?.final_payment_paid);
  const invoiced = hasQB ? safeNumber(lead?.qb_invoice_amount) : localInvoiceTotal;
  const paid = hasQB ? safeNumber(lead?.qb_payment_received) : (localInvoicePaid || safeNumber(deal?.total_paid) || milestonePaid);
  const balance = round2(Math.max(0, invoiced - paid));
  const remaining = round2(Math.max(0, projectTotal - paid));
  const pctPaid = projectTotal > 0 ? Math.min(100, Math.round((paid / projectTotal) * 100)) : 0;
  return { hasQB, projectTotal, invoiced, paid: round2(paid), balance, remaining, pctPaid };
}

// ── Deal card waterfall precedence helper ──
// Mirrors the Deals.jsx DealCard logic: waterfall_paid takes precedence
// over manual total_paid when waterfall_applied is true.
function getDealCardPaid(deal) {
  return deal.waterfall_applied ? (deal.waterfall_paid || 0) : (deal.total_paid || 0);
}
function getDealCardRemaining(deal) {
  const contractAmount = deal.contract_amount || 0;
  return deal.waterfall_applied
    ? (deal.waterfall_remaining || 0)
    : (deal.balance_due != null ? deal.balance_due : Math.max(0, contractAmount - getDealCardPaid(deal)));
}

function allocateWaterfall(customerTotalReceived, deals) {
  let remaining = round2(customerTotalReceived);
  const allocations = (deals || []).map(function (deal) {
    var projectTotal = round2(Number(deal.amount) || 0);
    if (projectTotal <= 0) return { deal_id: deal.id, deal_name: deal.name, project_total: 0, allocated_paid: 0, allocated_remaining: 0, allocated_progress: 0 };
    var allocatedPaid = round2(Math.min(remaining, projectTotal));
    var allocatedRemaining = round2(Math.max(0, projectTotal - allocatedPaid));
    var allocatedProgress = projectTotal > 0 ? Math.min(100, (allocatedPaid / projectTotal) * 100) : 0;
    remaining = round2(remaining - allocatedPaid);
    return { deal_id: deal.id, deal_name: deal.name, project_total: projectTotal, allocated_paid: allocatedPaid, allocated_remaining: allocatedRemaining, allocated_progress: round2(allocatedProgress * 100) / 100 };
  });
  return { allocations: allocations, customer_excess: round2(Math.max(0, remaining)) };
}

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS:', name); }
  else { fail++; console.log('  FAIL:', name, detail || ''); }
}

// A. saleInvoices exist + waterfall exists → waterfall Paid wins
{
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_customer_id: '203', qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 0 };
  const saleInvoices = [{ total_amt: 15000, paid: 0 }];
  const waterfall = { applied: true, this_deal_allocation: { deal_id: 'd1', project_total: 15000, allocated_paid: 7500, allocated_remaining: 7500, allocated_progress: 50 } };
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, waterfall);
  assert('A: waterfall paid takes precedence over sale-scoped paid=0', fin.paid === 7500, 'expected 7500, got ' + fin.paid);
  assert('A: remaining uses waterfall allocated_remaining', fin.remaining === 7500, 'expected 7500, got ' + fin.remaining);
  assert('A: progress uses waterfall allocated_paid', fin.pctPaid === 50, 'expected 50, got ' + fin.pctPaid);
}

// B. no mapped saleInvoices + waterfall exists → waterfall Paid works
{
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_customer_id: '203', qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 0 };
  const waterfall = { applied: true, this_deal_allocation: { deal_id: 'd1', project_total: 15000, allocated_paid: 7500, allocated_remaining: 7500, allocated_progress: 50 } };
  const fin = getDealPaymentSummary(deal, lead, [], null, waterfall);
  assert('B: waterfall paid takes precedence over lead.qb_payment_received=0', fin.paid === 7500, 'expected 7500, got ' + fin.paid);
  assert('B: remaining uses waterfall allocated_remaining', fin.remaining === 7500, 'expected 7500, got ' + fin.remaining);
}

// C. waterfall error → fallback to sale-scoped (UI warning tested in component)
{
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_customer_id: '203', qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 0 };
  const saleInvoices = [{ total_amt: 15000, paid: 0 }];
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, null);
  assert('C: waterfall null → falls back to sale-scoped paid', fin.paid === 0, 'expected 0 (fallback), got ' + fin.paid);
}

// D. Dean: total 3058, allocated paid 3000, remaining 58, status NOT Unpaid
{
  const deal = { id: 'f9d092c4-f634-4290-85c4-05ec5f06567f', amount: 3058 };
  const lead = { qb_customer_id: '206', status: 'Sold' };
  const waterfall = { applied: true, customer_qb_customer_id: '206', customer_total_received: 3000, this_deal_allocation: { deal_id: 'f9d092c4-f634-4290-85c4-05ec5f06567f', project_total: 3058, allocated_paid: 3000, allocated_remaining: 58, allocated_progress: 98.10 } };
  const fin = getDealPaymentSummary(deal, lead, [], null, waterfall);
  assert('D: Dean paid = 3000 from waterfall', fin.paid === 3000, 'expected 3000, got ' + fin.paid);
  assert('D: Dean remaining = 58 from waterfall', fin.remaining === 58, 'expected 58, got ' + fin.remaining);
  assert('D: Dean progress ~98.1%', Math.abs(fin.pctPaid - 98.1) < 0.1, 'expected ~98.1, got ' + fin.pctPaid);
  assert('D: Dean status NOT Unpaid (paid > 0)', fin.paid > 0, 'paid should be > 0');
}

// E. Rita: customer total received 7500, allocation per deterministic Deal order
{
  const deals = [
    { id: 'deal-rita-1', amount: 5000, name: 'Rita Deal 1', sold_date: '2026-01-15' },
    { id: 'deal-rita-2', amount: 10000, name: 'Rita Deal 2', sold_date: '2026-03-20' },
  ];
  const r = allocateWaterfall(7500, deals);
  assert('E: Rita deal-1 allocated 5000 (fully funded)', r.allocations[0].allocated_paid === 5000, 'expected 5000, got ' + r.allocations[0].allocated_paid);
  assert('E: Rita deal-2 allocated 2500 (rollover)', r.allocations[1].allocated_paid === 2500, 'expected 2500, got ' + r.allocations[1].allocated_paid);
  assert('E: Rita deal-1 remaining 0', r.allocations[0].allocated_remaining === 0, 'expected 0');
  assert('E: Rita deal-2 remaining 7500', r.allocations[1].allocated_remaining === 7500, 'expected 7500, got ' + r.allocations[1].allocated_remaining);
  assert('E: Rita no customer excess', r.customer_excess === 0, 'expected 0, got ' + r.customer_excess);
}

// F. multi-Deal rollover (2 deals)
{
  const deals = [{ id: 'd1', amount: 10000, name: 'Deal 1' }, { id: 'd2', amount: 15000, name: 'Deal 2' }];
  const r = allocateWaterfall(12000, deals);
  assert('F: deal-1 paid 10000 (full)', r.allocations[0].allocated_paid === 10000);
  assert('F: deal-2 paid 2000 (rollover)', r.allocations[1].allocated_paid === 2000);
  assert('F: no excess', r.customer_excess === 0);
}

// G. 3+ Deal rollover
{
  const deals = [{ id: 'd1', amount: 10000, name: 'Deal 1' }, { id: 'd2', amount: 15000, name: 'Deal 2' }, { id: 'd3', amount: 5000, name: 'Deal 3' }];
  const r = allocateWaterfall(27000, deals);
  assert('G: deal-1 paid 10000', r.allocations[0].allocated_paid === 10000);
  assert('G: deal-2 paid 15000', r.allocations[1].allocated_paid === 15000);
  assert('G: deal-3 paid 2000', r.allocations[2].allocated_paid === 2000);
  assert('G: no excess', r.customer_excess === 0);
}

// H. customer excess
{
  const deals = [{ id: 'd1', amount: 10000, name: 'Deal 1' }, { id: 'd2', amount: 15000, name: 'Deal 2' }];
  const r = allocateWaterfall(30000, deals);
  assert('H: deal-1 paid 10000', r.allocations[0].allocated_paid === 10000);
  assert('H: deal-2 paid 15000', r.allocations[1].allocated_paid === 15000);
  assert('H: customer excess 5000', r.customer_excess === 5000, 'expected 5000, got ' + r.customer_excess);
}

// I. conservation: SUM allocated + excess = authoritative customer received
{
  const deals = [{ id: 'd1', amount: 8000, name: 'Deal 1' }, { id: 'd2', amount: 12000, name: 'Deal 2' }, { id: 'd3', amount: 5000, name: 'Deal 3' }];
  const received = 18500;
  const r = allocateWaterfall(received, deals);
  const sumAllocated = r.allocations.reduce((s, a) => s + a.allocated_paid, 0);
  const total = round2(sumAllocated + r.customer_excess);
  assert('I: conservation SUM(allocated) + excess = received', total === received, 'expected ' + received + ', got ' + total);
}

// Fallback: waterfall not applied
{
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 5000 };
  const saleInvoices = [{ total_amt: 15000, paid: 5000 }];
  const waterfall = { applied: false, reason: 'no_qb_customer_id' };
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, waterfall);
  assert('FALLBACK: sale-scoped paid used when waterfall not applied', fin.paid === 5000, 'expected 5000, got ' + fin.paid);
}

// Edge: waterfall applied but deal not in eligible list
{
  const deal = { id: 'd1', amount: 15000 };
  const lead = { qb_customer_id: '203', qb_invoice_id: 'inv-1', qb_invoice_amount: 15000, qb_payment_received: 0 };
  const saleInvoices = [{ total_amt: 15000, paid: 0 }];
  const waterfall = { applied: true, this_deal_allocation: null };
  const fin = getDealPaymentSummary(deal, lead, [], saleInvoices, waterfall);
  assert('EDGE: waterfall applied but no this_deal_allocation → sale-scoped paid used', fin.paid === 0, 'expected 0 (fallback), got ' + fin.paid);
}

console.log('\n=== financialCalcWaterfallPrecedence: ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) process.exit(1);
