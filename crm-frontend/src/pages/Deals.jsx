import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import * as railwayDeals from "@/api/railway/deals";
import * as railwayLeads from "@/api/railway/leads";
import { TrendingUp, Search, ArrowRight, Calendar, MapPin, User, DollarSign, AlertCircle, Plus } from "lucide-react";
import { formatPhone } from "@/lib/formatters";
import SelectDialog from "@/components/SelectDialog";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import PullToRefreshIndicator from "@/components/PullToRefreshIndicator";
import { computeDealMetrics } from "@/lib/dashboardMetrics";

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
    const getValidDate = (d) => {
      const dateStr = d.sold_date || d.contract_signed_date || d.signed_date || d.created_date;
      if (!dateStr) return new Date(0);
      try {
        return new Date(dateStr);
      } catch {
        return new Date(0);
      }
    };
    return getValidDate(b) - getValidDate(a);
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
function DealCard({ deal }) {
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
  // total_paid is already computed by getSoldDeals with full fallback chain
  const displayTotalPaid = deal.total_paid || 0;
  const displayBalanceDue = deal.balance_due != null ? deal.balance_due : Math.max(0, displayContractAmount - displayTotalPaid);
  
  // Payment status label
  const getPaymentStatus = () => {
    if (displayContractAmount === 0) return "—";
    if (displayTotalPaid >= displayContractAmount) return "Paid in Full";
    if (displayTotalPaid > 0) return "Partial";
    return "Unpaid";
  };

  return (
    <Link
      to={`/deals/${deal.id}`}
      className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition-all duration-200 p-4 group block"
    >
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className="w-10 h-10 rounded-lg bg-orange-500 flex items-center justify-center text-white font-bold text-sm flex-shrink-0 mt-0.5">
          {deal.customer_name?.[0]?.toUpperCase() || '?'}
        </div>

        {/* Main Info */}
        <div className="flex-1 min-w-0">
          {/* Name + Stage Badge */}
          <div className="flex items-center gap-2 mb-2.5 flex-wrap">
            <h3 className="text-sm font-semibold text-slate-900">{deal.customer_name || "—"}</h3>
            {deal.stage && (
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${
                deal.stage === 'Job Completed' || deal.stage === 'Completed' ? 'bg-green-100 text-green-700' :
                deal.stage === 'Sold / Estimate Approved' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'
              }`}>
                {deal.stage}
              </span>
            )}
            {displayContractAmount > 0 && (
              <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                {fmtMoney(displayContractAmount)}
              </span>
            )}
          </div>

          {/* Contact row - Phone, Email, City, Owner, Sold Date */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 mb-2 text-[11px]">
            {deal.phone && (
              <div className="flex items-center gap-1 text-slate-600">
                <span className="text-slate-400 font-semibold">Phone:</span>
                <span className="text-slate-900 font-medium">{formatPhone(deal.phone)}</span>
              </div>
            )}
            {deal.email && (
              <div className="flex items-center gap-1 text-slate-600 max-w-[180px]">
                <span className="text-slate-400 font-semibold">Email:</span>
                <span className="text-slate-900 font-medium truncate">{deal.email}</span>
              </div>
            )}
            {deal.city && (
              <div className="flex items-center gap-1 text-slate-600">
                <span className="text-slate-400 font-semibold">City:</span>
                <span className="text-slate-900 font-medium">{deal.city}</span>
              </div>
            )}
            {deal.assigned_rep && (
              <div className="flex items-center gap-1 text-slate-600">
                <span className="text-slate-400 font-semibold">Owner:</span>
                <span className="text-slate-900 font-medium">{deal.assigned_rep}</span>
              </div>
            )}
            {formatDate(deal.sold_date) && (
              <div className="flex items-center gap-1 text-slate-600">
                <span className="text-slate-400 font-semibold">Sold:</span>
                <span className="text-slate-900 font-medium">{formatDate(deal.sold_date)}</span>
              </div>
            )}
          </div>

          {/* Project + Financial row */}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
            {deal.project_type && (
              <div className="flex items-center gap-1 text-slate-600">
                <span className="text-slate-400 font-semibold">Project:</span>
                <span className="text-slate-900 font-medium">{deal.project_type}</span>
              </div>
            )}
            {displayContractAmount > 0 && (
              <>
                <div className="flex items-center gap-1 text-slate-600">
                  <span className="text-slate-400 font-semibold">Paid:</span>
                  <span className="text-slate-900 font-bold text-emerald-700">{fmtMoney(displayTotalPaid)}</span>
                </div>
                <div className="flex items-center gap-1 text-slate-600">
                  <span className="text-slate-400 font-semibold">Total:</span>
                  <span className="text-slate-900 font-bold">{fmtMoney(displayContractAmount)}</span>
                </div>
              </>
            )}
            {displayContractAmount > 0 && (
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                getPaymentStatus() === 'Paid in Full' ? 'bg-emerald-100 text-emerald-700' :
                getPaymentStatus() === 'Partial' ? 'bg-amber-100 text-amber-700' :
                'bg-slate-100 text-slate-600'
              }`}>
                {getPaymentStatus()}
              </span>
            )}
          </div>
        </div>

        {/* Arrow */}
        <ArrowRight className="w-4 h-4 text-slate-300 group-hover:text-amber-500 flex-shrink-0 transition-colors mt-1" />
      </div>
    </Link>
  );
}

export default function Deals() {
  const [allItems, setAllItems] = useState([]);
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
          sold_date: d.sold_date || d.created_date,
          actual_sold_date: d.sold_date || null,
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
      case "sold_date_desc":
        return new Date(b.sold_date || 0) - new Date(a.sold_date || 0);
      case "sold_date_asc":
        return new Date(a.sold_date || 0) - new Date(b.sold_date || 0);
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
  const metrics = computeDealMetrics(sorted);
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
        <div className="max-w-7xl mx-auto px-6 py-6">
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
      <div className="max-w-7xl mx-auto px-6 py-6">
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
              <div className="grid gap-3">
                {sorted.map(item => (
                  <DealCard key={item.id} deal={item} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}