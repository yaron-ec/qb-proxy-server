/**
 * Shared dashboard metrics — single source of truth for "Sold This Month",
 * "Revenue This Month", "Total Revenue", "Total Sold", "Avg Deal Size".
 *
 * Used by:
 *   - FollowUpsWidget (Dashboard page) — client-side computation
 *   - getReportsData backend function — server-side computation (mirrors this logic)
 *
 * DEFINITIONS (authoritative):
 *
 * "Sold This Month":
 *   - lead.status === 'Sold'
 *   - lead.sold_date is set AND falls within the current America/Los_Angeles calendar month
 *   - Excluded: leads without sold_date, leads with status !== 'Sold',
 *     cancelled/deleted/duplicate/test records (these have status !== 'Sold' by definition)
 *
 * "Revenue This Month":
 *   - Sum of (deal.amount || lead.estimated_value || 0) for each "Sold This Month" lead
 *   - Represents the contract value of deals sold this month
 *   - Uses deal.amount (source of truth) when available, falls back to lead.estimated_value
 *
 * "Total Revenue":
 *   - Sum of (deal.amount || lead.estimated_value || 0) for ALL sold leads (all time)
 *
 * Month boundary: America/Los_Angeles (Pacific Time)
 *   - A sale at 11pm Pacific on Aug 31 counts for August, not September.
 */

export const DASHBOARD_TIMEZONE = 'America/Los_Angeles';

/**
 * Get the year and month (0-indexed) of a Date in America/Los_Angeles.
 */
export function getLAMonthParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DASHBOARD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return { year: parseInt(map.year), month: parseInt(map.month) - 1 };
}

/**
 * Get the current America/Los_Angeles year and month.
 */
export function getCurrentLAMonth(now = new Date()) {
  return getLAMonthParts(now);
}

/**
 * Check if a sold_date falls within the current LA month.
 * Handles both date-only strings ("2026-08-15") and ISO datetime strings.
 */
export function isSoldInCurrentLAMonth(soldDate, now = new Date()) {
  if (!soldDate) return false;
  const current = getCurrentLAMonth(now);

  // Date-only string: compare calendar date directly (no timezone conversion)
  if (typeof soldDate === 'string' && !soldDate.includes('T')) {
    const m = soldDate.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return false;
    return parseInt(m[1]) === current.year && parseInt(m[2]) - 1 === current.month;
  }

  // ISO datetime string: convert to LA timezone and compare
  const d = new Date(soldDate);
  if (isNaN(d.getTime())) return false;
  const laParts = getLAMonthParts(d);
  return laParts.year === current.year && laParts.month === current.month;
}

/**
 * Compute the revenue for a single sold lead.
 * Uses deal.amount (source of truth) when available, falls back to estimated_value.
 */
export function getLeadRevenue(lead, dealMap) {
  if (!lead) return 0;
  const deal = dealMap && dealMap[lead.id];
  return Number(deal?.amount || lead.estimated_value || 0);
}

/**
 * Compute all dashboard sales metrics from a set of leads and deals.
 *
 * @param {Array} leads - all leads (already scoped to the user's role)
 * @param {Array} deals - all deals (already scoped to the user's role)
 * @param {Date} now - reference date (default: current time)
 * @returns {{ soldThisMonth, revenueThisMonth, totalSold, totalRevenue, avgDealSize, soldThisMonthLeads }}
 */
export function computeSalesMetrics(leads, deals, now = new Date()) {
  // Build deal lookup map by lead_id
  const dealMap = {};
  for (const d of (deals || [])) {
    if (d.lead_id) dealMap[d.lead_id] = d;
  }

  // All sold leads
  const soldLeads = (leads || []).filter(l => l.status === 'Sold');

  // Sold this month (LA timezone)
  const soldThisMonthLeads = soldLeads.filter(l =>
    isSoldInCurrentLAMonth(l.sold_date, now)
  );

  const revenueThisMonth = soldThisMonthLeads.reduce(
    (sum, l) => sum + getLeadRevenue(l, dealMap),
    0
  );

  const totalRevenue = soldLeads.reduce(
    (sum, l) => sum + getLeadRevenue(l, dealMap),
    0
  );

  const totalSold = soldLeads.length;
  const avgDealSize = totalSold > 0 ? Math.round(totalRevenue / totalSold) : 0;

  return {
    soldThisMonth: soldThisMonthLeads.length,
    revenueThisMonth,
    totalSold,
    totalRevenue,
    avgDealSize,
    soldThisMonthLeads,
  };
}

/**
 * Format currency consistently across all dashboard components.
 * - Shows $0 for zero/null/undefined (never "—")
 * - Uses thousands separators
 * - Uses 0 decimal places for whole numbers, 2 for fractional
 * - Never shows one-decimal like $838,659.5
 */
/**
 * Compute ALL deal-centric metrics from a set of deals.
 *
 * This is the ONE canonical source of truth for:
 *   - totalRevenue, revenueThisMonth, revenueThisYear
 *   - soldThisMonth, totalDeals, avgDealSize
 *   - openBalance, inProgress
 *
 * Used by:
 *   - Deals.jsx (KPI cards)
 *   - FollowUpsWidget (Dashboard soldThisMonth / revenueThisMonth)
 *   - Any other consumer that needs deal financial metrics
 *
 * Canonical definitions:
 *   "sold_date" = deal.sold_date (NOT created_date). A deal without sold_date
 *     is not counted as "sold this month" even if it exists.
 *   "contract amount" = deal.contract_amount || deal.amount (fallback)
 *   "balance due" = deal.balance_due, or (contract_amount - total_paid) if null
 *   "in progress" = stage is set AND not 'Job Completed' or 'Sold / Estimate Approved'
 *
 * Month/year boundary: America/Los_Angeles (Pacific Time)
 *
 * @param {Array} deals - raw deals from Railway API (may be pre-filtered)
 * @param {Date} now - reference date (default: current time)
 */
export function computeDealMetrics(deals, now = new Date()) {
  const allDeals = deals || [];
  const currentLA = getCurrentLAMonth(now);

  // Canonical sold date: prefer actual_sold_date (transformed), then sold_date (raw)
  const getSoldDate = (d) => d.actual_sold_date || d.sold_date;

  // Canonical contract amount
  const getDealAmount = (d) => Number(d.contract_amount || d.amount || 0);

  // Canonical balance due
  const getDealBalance = (d) => {
    if (d.balance_due != null) return Number(d.balance_due);
    return Math.max(0, getDealAmount(d) - Number(d.total_paid || 0));
  };

  // Sold this month (LA timezone)
  const soldThisMonthDeals = allDeals.filter(d => {
    const sd = getSoldDate(d);
    return sd && isSoldInCurrentLAMonth(sd, now);
  });

  // Sold this year (LA timezone)
  const soldThisYearDeals = allDeals.filter(d => {
    const sd = getSoldDate(d);
    if (!sd) return false;
    const m = String(sd).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return false;
    return parseInt(m[1]) === currentLA.year;
  });

  const totalRevenue     = allDeals.reduce((s, d) => s + getDealAmount(d), 0);
  const revenueThisMonth = soldThisMonthDeals.reduce((s, d) => s + getDealAmount(d), 0);
  const revenueThisYear  = soldThisYearDeals.reduce((s, d) => s + getDealAmount(d), 0);
  const soldThisMonth    = soldThisMonthDeals.length;
  const totalDeals       = allDeals.length;
  const avgDealSize      = totalDeals > 0 ? Math.round(totalRevenue / totalDeals) : 0;
  const openBalance      = allDeals.reduce((s, d) => s + getDealBalance(d), 0);
  const inProgress       = allDeals.filter(d =>
    d.stage && !['Job Completed', 'Sold / Estimate Approved'].includes(d.stage)
  ).length;

  return {
    totalRevenue,
    revenueThisMonth,
    revenueThisYear,
    soldThisMonth,
    totalDeals,
    avgDealSize,
    openBalance,
    inProgress,
  };
}

export function formatDashboardCurrency(n) {
  if (n === null || n === undefined || isNaN(n)) return '$0';
  const num = Number(n);
  if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `$${Math.round(num).toLocaleString('en-US')}`;
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}