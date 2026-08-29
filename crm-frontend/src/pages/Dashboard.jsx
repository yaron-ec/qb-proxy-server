import { useState, useEffect, useMemo } from "react";
import { useAuth } from "@/lib/AuthContext";
import * as railwayLeads from "@/api/railway/leads";
import * as railwayDeals from "@/api/railway/deals";
import { Link } from "react-router-dom";
import LeadCharts from "../components/dashboard/LeadCharts";
import FollowUpsWidget from "../components/FollowUpsWidget";
import { Search, ChevronDown, ChevronUp, MapPin, TrendingUp, Calendar } from "lucide-react";
import { buildRegionAnalytics } from "@/lib/leadRegionAnalytics";
import { CARD, CARD_PADDED, INPUT, SPINNER, MUTED, statusBadgeClass } from "@/lib/design-system";
import { toTitleCase } from "@/lib/formatters";
import { openGmailCompose } from "@/lib/gmailCompose";
import { countActiveSalesLeads } from "@/lib/activeLeadFilter";

const DATE_RANGE_OPTIONS = [
  { label: 'Next 7 Days', value: 'next7', days: 7, direction: 'future' },
  { label: 'Last 7 Days', value: 'last7', days: 7, direction: 'past' },
  { label: 'Last 14 Days', value: 'last14', days: 14, direction: 'past' },
  { label: 'Last 21 Days', value: 'last21', days: 21, direction: 'past' },
];

export default function Dashboard() {
  const [leads, setLeads] = useState([]);
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [regionData, setRegionData] = useState(null);
  const [debugInfo, setDebugInfo] = useState(null);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [filterBudget, setFilterBudget] = useState("");
  const [selectedYear, setSelectedYear] = useState(null);
  const [expandedMonth, setExpandedMonth] = useState(null);
  const { user: currentUser } = useAuth();
  const [dateRange, setDateRange] = useState('next7');

  useEffect(() => {
    const loadData = async () => {
      try {
        // Load via Railway API — no Base44 SDK, no credits
        const [leadsRes, dealsRes] = await Promise.all([
          railwayLeads.list({ sort: '-updated_date', limit: 2000 }),
          railwayDeals.list({ sort: '-sold_date', limit: 2000 }).catch(() => ({ items: [] })),
        ]);
        const allLeads = leadsRes.items || [];
        const allDeals = dealsRes.items || [];
        const filtered = allLeads.filter(lead =>
          !lead.first_name?.toLowerCase().includes('unknown') &&
          !lead.last_name?.toLowerCase().includes('unknown')
        );

        setLeads(filtered);
        setDeals(allDeals);

        // Only show region analytics for admin/manager
        if (currentUser?.role === 'admin' || currentUser?.role === 'manager') {
          const analyticsResult = await buildRegionAnalytics();
          setRegionData(analyticsResult.data);
          setDebugInfo(analyticsResult.debug);
          const years = Object.keys(analyticsResult.data).sort().reverse();
          if (years.length > 0) setSelectedYear(years[0]);
        }

        setLoading(false);
      } catch (e) {
        console.error('[Dashboard] Error loading data:', e);
        setLoading(false);
      }
    };

    loadData();

    // Polling refresh every 60s (replaces Base44 realtime subscription)
    const pollTimer = setInterval(loadData, 60000);
    return () => clearInterval(pollTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    return leads.filter(l => {
      const name = `${l.first_name} ${l.last_name}`.toLowerCase();
      const searchOk = !search ||
        name.includes(search.toLowerCase()) ||
        (l.email || "").toLowerCase().includes(search.toLowerCase()) ||
        (l.phone || "").includes(search) ||
        (l.city || "").toLowerCase().includes(search.toLowerCase());
      const statusOk = !filterStatus || l.status === filterStatus;
      const sourceOk = !filterSource || l.source === filterSource;
      const budgetOk = !filterBudget || l.budget_range === filterBudget;
      return searchOk && statusOk && sourceOk && budgetOk;
    });
  }, [leads, search, filterStatus, filterSource, filterBudget]);

  const showResults = search || filterStatus || filterSource || filterBudget;

  // Filter leads for the FollowUpsWidget based on the selected date range
  const dateRangeLeads = useMemo(() => {
    const opt = DATE_RANGE_OPTIONS.find(o => o.value === dateRange);
    if (!opt) return leads;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const rangeStart = new Date(today);
    const rangeEnd = new Date(today);
    if (opt.direction === 'future') {
      rangeEnd.setDate(rangeEnd.getDate() + opt.days);
    } else {
      rangeStart.setDate(rangeStart.getDate() - opt.days);
    }
    return leads.filter(l => {
      const dateStr = l.follow_up_date || l.appointment_date;
      if (!dateStr) return false;
      const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return false;
      const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
      return d >= rangeStart && d <= rangeEnd;
    });
  }, [leads, dateRange]);
  const years = regionData ? Object.keys(regionData).sort().reverse() : [];
  const currentYearData = selectedYear && regionData ? regionData[selectedYear] : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className={SPINNER} />
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">

        {/* Page Header */}
        <div>
          <h1 className="typography-page-title">Dashboard</h1>
          <p className="typography-helper-text mt-1">Lead performance overview · Northern & Southern California</p>
        </div>

      {/* Date Range Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <Calendar className="w-4 h-4 text-slate-400 flex-shrink-0" />
        <span className="text-xs font-semibold text-slate-500 mr-1">Show:</span>
        {DATE_RANGE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setDateRange(opt.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              dateRange === opt.value
                ? 'bg-amber-600 text-white shadow-sm'
                : 'bg-white border border-slate-200 text-slate-600 hover:border-amber-400 hover:text-amber-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Follow-ups Widget */}
      <FollowUpsWidget
        leads={dateRangeLeads}
        allLeads={leads}
        deals={deals}
        dateRangeMode={DATE_RANGE_OPTIONS.find(o => o.value === dateRange)}
      />

      {/* Region Summary Cards */}
      {currentYearData && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Northern CA */}
          <div className="bg-card rounded-lg border border-border shadow-sm p-5 border-l-4 border-l-blue-500">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <MapPin className="w-4 h-4 text-blue-500" />
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Northern California</h3>
                </div>
                <p className="text-xs text-slate-400">Fresno, Bakersfield & north</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-blue-600">{currentYearData['Northern California']?.total || 0}</div>
                <div className="text-xs text-slate-400">leads</div>
              </div>
            </div>
            <div className="space-y-1.5">
              {Object.entries(currentYearData['Northern California']?.cities || {})
                .sort(([, a], [, b]) => b.total - a.total)
                .slice(0, 5)
                .map(([city, data]) => (
                  <div key={city} className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">{city}</span>
                    <span className="text-sm font-bold text-blue-600">{data.total}</span>
                  </div>
                ))}
            </div>
          </div>

          {/* Southern CA */}
          <div className="bg-card rounded-lg border border-border shadow-sm p-5 border-l-4 border-l-amber-500">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <MapPin className="w-4 h-4 text-amber-500" />
                  <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Southern California</h3>
                </div>
                <p className="text-xs text-slate-400">South of Bakersfield</p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-amber-600">{currentYearData['Southern California']?.total || 0}</div>
                <div className="text-xs text-slate-400">leads</div>
              </div>
            </div>
            <div className="space-y-1.5">
              {Object.entries(currentYearData['Southern California']?.cities || {})
                .sort(([, a], [, b]) => b.total - a.total)
                .slice(0, 5)
                .map(([city, data]) => (
                  <div key={city} className="flex items-center justify-between">
                    <span className="text-sm text-slate-600">{city}</span>
                    <span className="text-sm font-bold text-amber-600">{data.total}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* Year Selector + Monthly Breakdown */}
      <div className={CARD_PADDED}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide">Monthly Breakdown</h2>
          <div className="flex gap-2">
            {years.map(year => (
              <button
                key={year}
                onClick={() => setSelectedYear(year)}
                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  selectedYear === year
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {year}
              </button>
            ))}
          </div>
        </div>

        {debugInfo && (
          <div className="text-xs text-slate-400 mb-4 bg-slate-50 border border-slate-100 px-3 py-2 rounded-lg font-mono">
            Total: {debugInfo.totalLeads} · 2024: {debugInfo.yearCounts['2024'] || 0} · 2025: {debugInfo.yearCounts['2025'] || 0} · 2026: {debugInfo.yearCounts['2026'] || 0}
            {debugInfo.unknownCity > 0 && ` · No City/Region: ${debugInfo.unknownCity}`}
          </div>
        )}

        {currentYearData && (
          <div className="space-y-2">
            {Object.entries(currentYearData['Northern California']?.months || {}).map(([monthName, monthData]) => {
              const southMonthData = currentYearData['Southern California']?.months?.[monthName];
              const isExpanded = expandedMonth === monthName;
              const total = (monthData.total || 0) + (southMonthData?.total || 0);

              return (
                <div key={monthName} className="border border-slate-200 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setExpandedMonth(isExpanded ? null : monthName)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-semibold text-slate-800">{monthName}</span>
                      <span className="text-xs font-medium text-slate-400 bg-slate-200 px-2 py-0.5 rounded-full">{total} leads</span>
                    </div>
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                  </button>

                  {isExpanded && (
                    <div className="p-4 bg-white grid md:grid-cols-2 gap-4">
                      <div>
                        <h5 className="text-xs font-bold text-blue-700 uppercase tracking-wide mb-2">Northern CA ({monthData.total || 0})</h5>
                        <div className="space-y-1">
                          {Object.entries(monthData.cities || {}).sort(([, a], [, b]) => b.total - a.total).map(([city, data]) => (
                            <div key={city} className="flex items-center justify-between px-3 py-1.5 bg-blue-50 rounded-lg">
                              <span className="text-xs text-slate-700">{city}</span>
                              <span className="text-xs font-bold text-blue-600">{data.total}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {southMonthData && (
                        <div>
                          <h5 className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-2">Southern CA ({southMonthData.total || 0})</h5>
                          <div className="space-y-1">
                            {Object.entries(southMonthData.cities || {}).sort(([, a], [, b]) => b.total - a.total).map(([city, data]) => (
                              <div key={city} className="flex items-center justify-between px-3 py-1.5 bg-amber-50 rounded-lg">
                                <span className="text-xs text-slate-700">{city}</span>
                                <span className="text-xs font-bold text-amber-600">{data.total}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick Lead Search */}
      <div className={CARD_PADDED}>
        <h2 className="text-sm font-bold text-slate-700 uppercase tracking-wide mb-4">Quick Lead Search</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
             className={INPUT}
             placeholder="Name, email, phone..."
             value={search}
             onChange={e => setSearch(e.target.value)}
            />
          </div>
          {[
            { value: filterStatus, setter: setFilterStatus, options: ["New","Appointment scheduled","Answered, no appointment set","No answer","Proposal Sent","No show","DNQ","Sold","Lost"], placeholder: "All Statuses" },
            { value: filterSource, setter: setFilterSource, options: ["Google Search","Google Maps / reviews","Referral","Instagram / Facebook","YouTube","Repeat customer","Other"], placeholder: "All Sources" },
            { value: filterBudget, setter: setFilterBudget, options: ["Under $25,000","$25,000–$75,000","$75,000–$150,000","$150,000–$300,000","$300,000+"], placeholder: "All Budgets" },
          ].map(({ value, setter, options, placeholder }, i) => (
            <select
              key={i}
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500 transition-all"
              value={value}
              onChange={e => setter(e.target.value)}
            >
              <option value="">{placeholder}</option>
              {options.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          ))}
          {showResults && (
            <button
              onClick={() => { setSearch(""); setFilterStatus(""); setFilterSource(""); setFilterBudget(""); }}
              className="text-xs text-red-500 hover:text-red-700 font-semibold px-2 py-1"
            >
              ✕ Clear
            </button>
          )}
          {showResults && (
            <span className="text-xs text-slate-500 font-medium">{filtered.length} results</span>
          )}
        </div>

        {showResults && (
          <div className="mt-4 border border-slate-200 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-400">No leads found</div>
            ) : filtered.slice(0, 20).map(lead => (
              <Link key={lead.id} to={`/leads/${lead.id}`}
                className="flex items-center justify-between px-4 py-3 border-b border-slate-50 hover:bg-amber-50 transition-all cursor-pointer last:border-0"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-xs font-bold text-slate-600 flex-shrink-0">
                    {(lead.first_name?.[0] || "")}{(lead.last_name?.[0] || "")}
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{toTitleCase(lead.first_name)} {toTitleCase(lead.last_name)}</div>
                    <div className="text-xs text-slate-400">
                      {lead.email ? (
                        <a href="#" onClick={e => openGmailCompose(lead.email, e)} className="text-blue-600 hover:underline">
                          {lead.email}
                        </a>
                      ) : null}
                      {lead.email && lead.city ? ' · ' : ''}
                      {lead.city}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {lead.budget_range && <span className="text-xs text-slate-400">{lead.budget_range}</span>}
                  <span className={statusBadgeClass(lead.status)}>
                    {lead.status || "New"}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

        {/* Charts */}
        <LeadCharts leads={leads} />
      </div>
    </div>
  );
}