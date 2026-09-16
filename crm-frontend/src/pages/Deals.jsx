import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayLeads from "@/api/railway/leads";
import { TrendingUp, Search, ArrowRight, Calendar, MapPin, User, DollarSign, AlertCircle, Plus, AlertTriangle } from "lucide-react";
import { formatPhone } from "@/lib/formatters";
import SelectDialog from "@/components/SelectDialog";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import PullToRefreshIndicator from "@/components/PullToRefreshIndicator";
import { computeDealMetrics } from "@/lib/dashboardMetrics";
import * as railwayDealFinancials from "@/api/railway/dealFinancials";

const PIPELINE_STAGES = [
  "Sold / Estimate Approved",
  "Deposit Due",
  "Deposit Paid",
  "Work Scheduled",
  "Work Started",
  "Progress Payment Due",
  "Progress Payment Paid",
  "Final Payment Due",
  "Final Payment Paid",
  "Job Completed"
];

const STAGE_COLORS = {
  "Sold": "bg-emerald-100 text-emerald-800",
};

const fmtMoney = (v) => v != null ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}` : null;
const fmtDate  = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;

// ── Monthly metrics: delegated to canonical computeDealMetrics ───────────────
// All KPI cards use computeDealMetrics from dashboardMetrics.js — the ONE
// canonical source of truth shared with the Dashboard, Deal Detail, and
// financial summary components. No per-component patch calculations.

// Sort deals by sold date (newest first) with safe fallbacks
const sortDealsBySoldDate = (deals) => {
  return [...deals].sort((a, b) => {
    // Primary: sold_date descending (NULLS LAST — unsold deals sort to bottom)
    const aSold = a.sold_date ? new Date(a.sold_date).getTime() : null;
    const bSold = b.sold_date ? new Date(b.sold_date).getTime() : null;
    if (aSold !== null && bSold !== null) return bSold - aSold;
    if (aSold !== null) return -1;
    if (bSold !== null) return 1;
    // Both unsold: fallback to created_date descending
    const aCreated = a.created_date ? new Date(a.created_date).getTime() : 0;
    const bCreated = b.created_date ? new Date(b.created_date).getTime() : 0;
    return bCreated - aCreated;
  });
};

// Summary Card Component — compact, no overflow
function SummaryCard({ label, value, color, textColor }) {
  return (
    <div className={`${color} border border-slate-200 rounded-lg p-3 shadow-sm flex flex-col gap-1 min-w-0`}>
      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide leading-tight truncate">{label}</p>
      <p className={`text-sm font-bold truncate ${textColor}`}>{value}</p>
    </div>
  );
}

// Deal Card Component - Professional CRM Style
function DealCard({ deal, financials }) {
  const formatDate = (d) => {
    if (!d) return null;
    try {
      return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return null;
    }
  };

  // contract_amount is already computed by getSoldDeals with full fallback chain
  const displayContractAmount = deal.contract_amount || 0;
  // Waterfall-authoritative paid from the financials API takes precedence.
  // deal.total_paid is a stale stored field — the waterfall allocates actual
  // QuickBooks received money across the customer's deals chronologically.
  const displayTotalPaid = financials?.paid != null ? financials.paid : (deal.total_paid || 0);
  const displayBalanceDue = financials?.balance != null
    ? financials.balance
    : (deal.balance_due != null ? deal.balance_due : Math.max(0, displayContractAmount - displayTotalPaid));
  const waterfallError = financials?.waterfallError;
  
  // Payment status label
  const getPaymentStatus = () => {
    if (displayContractAmount === 0) return "—";
    if (displayTotalPaid >= displayContractAmount) return "Paid in Full";
    if (displayTotalPaid > 0) return "Partial";
    return "Unpaid";
  };

  return (
    // ONE Deal = ONE row (same principle as Active Leads). Desktop (lg+):
    // fixed-width internal regions in a single flex row — Identity gets
    // breathing room, Project is tight and column-aligned between rows,
    // and Financial is pinned via ml-auto with right-aligned numeric
    // values so Value/Paid/Remaining line up vertically down the list.
    // Below lg, regions stack into a clean single-column card.
    <Link
      to={`/deals/${deal.id}`}
      className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all duration-200 p-3.5 group block"
    >
      <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:gap-4">
        {/* Identity — avatar, customer, stage, project type, phone/email */}
        <div className="flex items-center gap-3 lg:w-[250px] lg:flex-shrink-0 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-orange-500 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
            {deal.customer_name?.[0]?.toUpperCase() || '?'}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="text-sm font-bold text-slate-900 truncate">{deal.customer_name || "—"}</h3>
            </div>
            {deal.stage && (
              <span className={`inline-flex items-center h-5 mt-0.5 px-1.5 rounded text-[10px] font-semibold whitespace-nowrap ${
                deal.stage === 'Job Completed' || deal.stage === 'Completed' ? 'bg-green-100 text-green-700' :
                deal.stage === 'Sold / Estimate Approved' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'
              }`}>
                {deal.stage}
              </span>
            )}
            {deal.project_type && <p className="text-[11px] text-slate-500 mt-0.5 truncate">{deal.project_type}</p>}
          </div>
        </div>

        <div className="hidden lg:block w-px h-9 bg-slate-100 flex-shrink-0" />

        {/* Project — city, owner, sold date, plus phone/email if useful */}
        <div className="lg:w-[190px] lg:flex-shrink-0 min-w-0 space-y-0.5 text-[11px] text-slate-500">
          {deal.city && (
            <div className="truncate"><span className="text-slate-400">City</span> <span className="text-slate-800 font-medium">{deal.city}</span></div>
          )}
          {deal.assigned_rep && (
            <div className="truncate"><span className="text-slate-400">Owner</span> <span className="text-slate-800 font-medium">{deal.assigned_rep}</span></div>
          )}
          {formatDate(deal.sold_date) && (
            <div><span className="text-slate-400">Sold</span> <span className="text-slate-800 font-medium">{formatDate(deal.sold_date)}</span></div>
          )}
          {(deal.phone || deal.email) && (
            <div className="truncate text-slate-400">
              {deal.phone && <span>{formatPhone(deal.phone)}</span>}
              {deal.phone && deal.email && ' · '}
              {deal.email && <span title={deal.email}>{deal.email}</span>}
            </div>
          )}
        </div>

        <div className="hidden lg:block w-px h-9 bg-slate-100 flex-shrink-0" />

        {/* Financial — Value/Paid/Remaining, right-aligned numbers that
            line up vertically between rows since every row uses the same
            label+value grid. Never re-derived — same waterfall values.
            Sits directly beside Project (not pushed to the far right) so
            it reads as part of the same record, not floating on its own —
            the trailing arrow absorbs any leftover row width instead. */}
        <div className="lg:w-[210px] lg:flex-shrink-0">
          {displayContractAmount > 0 ? (
            <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 justify-end text-[11px]">
              <span className="text-slate-400 text-right">Value</span>
              <span className="text-slate-900 font-bold text-right tabular-nums">{fmtMoney(displayContractAmount)}</span>
              <span className="text-slate-400 text-right">Paid</span>
              <span className="text-emerald-700 font-bold text-right tabular-nums">{fmtMoney(displayTotalPaid)}</span>
              <span className="text-slate-400 text-right">{getPaymentStatus() === 'Paid in Full' ? 'Status' : 'Remaining'}</span>
              {getPaymentStatus() === 'Paid in Full' ? (
                <span className="text-right"><span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Paid in Full</span></span>
              ) : (
                <span className={`text-right font-bold tabular-nums ${getPaymentStatus() === 'Partial' ? 'text-amber-700' : 'text-slate-600'}`}>{fmtMoney(displayBalanceDue)}</span>
              )}
              {waterfallError && (
                <div className="col-span-2 flex items-center gap-1 justify-end pt-0.5 text-[10px] text-amber-600 font-semibold">
                  <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                  QB waterfall unavailable
                </div>
              )}
            </div>
          ) : (
            <span className="text-[11px] text-slate-400">—</span>
          )}
        </div>

        {/* Action */}
        <ArrowRight className="hidden lg:block w-4 h-4 text-slate-300 group-hover:text-amber-500 flex-shrink-0 transition-colors lg:ml-auto" />
      </div>
    </Link>
  );
}

export default function Deals() {
  const [allItems, setAllItems] = useState([]);
  const [financialsMap, setFinancialsMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [queryError, setQueryError] = useState(null);
  const [filterOwner, setFilterOwner] = useState("");
  const [filterJobType, setFilterJobType] = useState("");
  const [filterStage, setFilterStage] = useState("");
  const [sortBy, setSortBy] = useState("sold_date_desc");

  const loadDeals = useCallback(async () => {
    try {
      // Fetch deals + leads from Railway API in parallel, then join client-side
      // to enrich deals with lead data (customer_name, phone, email, city).
      // Railway RBAC handles owner-scoping server-side (no $in cross-entity issue).
      const [dealsRes, leadsRes] = await Promise.all([
        railwayDeals.list({ sort: '-sold_date', limit: 2000 }),
        railwayLeads.list({ limit: 2000 }),
      ]);
      const deals = dealsRes.items || [];
      const leads = leadsRes.items || [];
      const leadMap = new Map(leads.map(l => [l.id, l]));
      const items = deals.map(d => {
        const lead = leadMap.get(d.lead_id) || {};
        return {
          ...d,
          customer_name: lead.full_name || `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || d.name || '—',
          phone: lead.phone || '',
          email: lead.email || '',
          city: lead.city || '',
          project_type: d.project_type || lead.project_type || '',
          assigned_rep: d.assigned_rep || lead.assigned_rep || '',
          sort_date: d.sold_date || d.created_date,
          contract_amount: d.contract_amount || d.amount || 0,
          total_paid: d.total_paid || 0,
          balance_due: d.balance_due != null ? d.balance_due : Math.max(0, (d.contract_amount || 0) - (d.total_paid || 0)),
        };
      });
      setAllItems(sortDealsBySoldDate(items));
      setQueryError(null);
    } catch (e) {
      setQueryError('Failed to load deals: ' + (e.message || String(e)));
      setAllItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDeals(); }, [loadDeals]);

  // Fetch waterfall financials for all loaded deals (concurrency-limited).
  // This is the authoritative QB-derived payment state — deal.total_paid is
  // a stale stored field that doesn't reflect actual QuickBooks received money.
  useEffect(() => {
    if (allItems.length === 0) return;
    let cancelled = false;
    const dealIds = allItems.map(d => d.id);
    const saleTotals = {};
    allItems.forEach(d => { saleTotals[d.id] = d.contract_amount || d.amount || 0; });
    (async () => {
      const results = {};
      const concurrency = 5;
      let index = 0;
      async function worker() {
        while (index < dealIds.length) {
          if (cancelled) return;
          const i = index++;
          const dealId = dealIds[i];
          try {
            const fin = await railwayDealFinancials.getFinancials(dealId, saleTotals[dealId] || 0);
            results[dealId] = fin;
          } catch (e) {
            results[dealId] = { error: e.message };
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, dealIds.length) }, worker));
      if (!cancelled) setFinancialsMap(results);
    })();
    return () => { cancelled = true; };
  }, [allItems]);

  const { pulling, refreshing, pullDistance } = usePullToRefresh(loadDeals);

  const filtered = allItems.filter(d => {
    const matchesSearch = !search || 
      d.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
      d.project_type?.toLowerCase().includes(search.toLowerCase()) ||
      d.name?.toLowerCase().includes(search.toLowerCase());
    
    const matchesOwner = !filterOwner || d.assigned_rep?.toLowerCase() === filterOwner.toLowerCase();
    
    const matchesJobType = !filterJobType || (d.project_type || "").toLowerCase().includes(filterJobType.toLowerCase());
    
    const matchesStage = !filterStage || d.stage === filterStage;
    
    return matchesSearch && matchesOwner && matchesJobType && matchesStage;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "sold_date_desc": {
        const aT = a.sold_date ? new Date(a.sold_date).getTime() : null;
        const bT = b.sold_date ? new Date(b.sold_date).getTime() : null;
        if (aT !== null && bT !== null) return bT - aT;
        if (aT !== null) return -1;
        if (bT !== null) return 1;
        return 0;
      }
      case "sold_date_asc": {
        const aT = a.sold_date ? new Date(a.sold_date).getTime() : null;
        const bT = b.sold_date ? new Date(b.sold_date).getTime() : null;
        if (aT !== null && bT !== null) return aT - bT;
        if (aT !== null) return 1;
        if (bT !== null) return -1;
        return 0;
      }
      case "amount_desc":
        return (b.contract_amount || b.sale_amount || 0) - (a.contract_amount || a.sale_amount || 0);
      case "amount_asc":
        return (a.contract_amount || a.sale_amount || 0) - (b.contract_amount || b.sale_amount || 0);
      case "balance_desc":
        return (b.balance_due || 0) - (a.balance_due || 0);
      case "owner_asc":
        return (a.assigned_rep || "").localeCompare(b.assigned_rep || "");
      default:
        return 0;
    }
  });

  // Extract unique owners and job types for filters
  const uniqueOwners = [...new Set(allItems.filter(d => d.assigned_rep).map(d => d.assigned_rep))].sort();
  const uniqueJobTypes = [...new Set(allItems.filter(d => d.project_type).map(d => d.project_type.split(',')[0].trim()))].sort();

  // ── CANONICAL METRICS ──────────────────────────────────────────────────
  // ONE source of truth: computeDealMetrics from dashboardMetrics.js.
  // Same function used by Dashboard (FollowUpsWidget), Deal Detail, and
  // financial summary components — all screens return the same number.
  // Merge waterfall financials into deal objects for authoritative KPI metrics.
  // computeDealMetrics uses deal.total_paid and deal.balance_due — without this
  // merge, the KPI cards (Total Revenue, Open Balance) would use stale stored fields
  // that don't reflect actual QuickBooks received money.
  const enrichedSorted = sorted.map(d => {
    const fin = financialsMap[d.id];
    if (fin && !fin.error && fin.paid != null) {
      return {
        ...d,
        total_paid: fin.paid,
        balance_due: fin.balance != null ? fin.balance : d.balance_due,
      };
    }
    return d;
  });
  const metrics = computeDealMetrics(enrichedSorted);
  const totalValue        = metrics.totalRevenue;
  const revenueThisMonth  = metrics.revenueThisMonth;
  const revenueThisYear   = metrics.revenueThisYear;
  const soldThisMonth     = metrics.soldThisMonth;
  const openBalance       = metrics.openBalance;
  const avgDealSize       = metrics.avgDealSize;
  const inProgress        = metrics.inProgress;
  
  // Removed contractSignedThisMonth — replaced by soldThisMonth (uses same shared helper)

  return (
    <div className="min-h-screen bg-background">
      <PullToRefreshIndicator pullDistance={pullDistance} refreshing={refreshing} />
      {/* Sticky Header */}
      <div className="sticky top-0 z-40 bg-card border-b border-border">
        <div className="max-w-[1600px] mx-auto px-6 py-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="typography-page-title">Deals</h1>
              <p className="typography-helper-text mt-1">
                {filtered.length} deal{filtered.length !== 1 ? 's' : ''} · {fmtMoney(totalValue) || "$0"} total
              </p>
            </div>
            <Link
              to="/capture?returnToCRM=true"
              className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors active:scale-95 shadow-sm"
            >
              <Plus className="w-4 h-4" />
              New Lead
            </Link>
          </div>

          {/* Search + Filters — single compact toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                type="text"
                placeholder="Search customer, project…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 bg-white w-52"
              />
            </div>
            <SelectDialog value={filterOwner} onChange={setFilterOwner} placeholder="Owner" options={[{ value: "", label: "All Owners" }, ...uniqueOwners.map(o => ({ value: o, label: o }))]} compact />
            <SelectDialog value={filterJobType} onChange={setFilterJobType} placeholder="Job Type" options={[{ value: "", label: "All Job Types" }, ...uniqueJobTypes.map(t => ({ value: t, label: t }))]} compact />
            <SelectDialog value={filterStage} onChange={setFilterStage} placeholder="Stage" options={[{ value: "", label: "All Stages" }, ...PIPELINE_STAGES.map(s => ({ value: s, label: s }))]} compact />
            <SelectDialog value={sortBy} onChange={setSortBy} placeholder="Sort" compact options={[
              { value: "sold_date_desc", label: "Newest Sold" },
              { value: "sold_date_asc", label: "Oldest Sold" },
              { value: "amount_desc", label: "Highest Amount" },
              { value: "amount_asc", label: "Lowest Amount" },
              { value: "balance_desc", label: "Highest Balance Due" },
              { value: "owner_asc", label: "Owner A→Z" },
            ]} />
            {(search || filterOwner || filterJobType || filterStage) && (
              <button onClick={() => { setSearch(""); setFilterOwner(""); setFilterJobType(""); setFilterStage(""); }}
                className="text-xs text-slate-400 hover:text-red-500 font-semibold px-2 py-1.5 btn-compact">✕ Clear</button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-[1600px] mx-auto px-6 py-6">
        {queryError && (
          <div className="bg-red-50 border border-red-300 rounded-lg p-4 mb-4">
            <p className="text-sm text-red-800"><strong>Query Error:</strong> {queryError}</p>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin"></div>
          </div>
        ) : allItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
              <TrendingUp className="w-8 h-8 text-slate-300" />
            </div>
            <p className="text-base font-semibold text-slate-600 mb-1">{search ? "No deals match your search" : "No deals yet"}</p>
            <p className="text-sm text-slate-400">Deals are created from a contact's detail page.</p>
          </div>
        ) : (
          <>
            {/* KPI Cards — 4 per row, two rows */}
            {!search && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                <SummaryCard label="Total Revenue" value={fmtMoney(totalValue)} color="bg-emerald-50" textColor="text-emerald-700" />
                <SummaryCard label="This Month" value={fmtMoney(revenueThisMonth)} color="bg-blue-50" textColor="text-blue-700" />
                <SummaryCard label="This Year" value={fmtMoney(revenueThisYear)} color="bg-purple-50" textColor="text-purple-700" />
                <SummaryCard label="Total Deals" value={filtered.length} color="bg-slate-50" textColor="text-slate-700" />
                <SummaryCard label="Avg Deal Size" value={fmtMoney(avgDealSize)} color="bg-amber-50" textColor="text-amber-700" />
                <SummaryCard label="Open Balance" value={fmtMoney(openBalance)} color="bg-orange-50" textColor="text-orange-700" />
                <SummaryCard label="Sold This Month" value={soldThisMonth} color="bg-green-50" textColor="text-green-700" />
                <SummaryCard label="In Progress" value={inProgress} color="bg-indigo-50" textColor="text-indigo-700" />
              </div>
            )}

            {/* Deals List */}
            {sorted.length === 0 && (search || filterOwner || filterJobType || filterStage) ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-base font-semibold text-slate-600">No deals match your filters</p>
              </div>
            ) : (
              // ONE Deal = ONE row (same principle as Active Leads) — the
              // wide desktop space is used INSIDE each row via DealCard's
              // own internal grid of regions, not via a multi-column card
              // grid across the screen.
              <div className="grid grid-cols-1 gap-2.5">
                {sorted.map(item => (
                  <DealCard key={item.id} deal={item} financials={financialsMap[item.id]} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}