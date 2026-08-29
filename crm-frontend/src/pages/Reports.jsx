import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/AuthContext";
import * as railwayLeads from "@/api/railway/leads";
import * as railwayDeals from "@/api/railway/deals";
import { useNavigate } from "react-router-dom";
import {
  Users, TrendingUp, DollarSign,
  MapPin, Briefcase, RefreshCw
} from "lucide-react";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";
import { formatDashboardCurrency } from "@/lib/dashboardMetrics";

const STATUS_COLORS = {
  "New": "#3b82f6",
  "Appointment scheduled": "#10b981",
  "Answered, no appointment set": "#6b7280",
  "No answer": "#94a3b8",
  "Proposal Sent": "#f97316",
  "No show": "#f59e0b",
  "Sold": "#22c55e",
  "Lost": "#ef4444",
  "DNQ": "#9ca3af",
};

const PIE_COLORS = ["#D4A017", "#3b82f6", "#10b981", "#f97316", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];

// Use shared currency formatter from dashboardMetrics for consistency across all dashboard components
const fmt$ = formatDashboardCurrency;

function StatCard({ label, value, sub, color = "slate", icon: Icon, onClick, clickable = false }) {
  const colorMap = {
    blue: "border-l-blue-500 bg-blue-50",
    green: "border-l-green-500 bg-green-50",
    amber: "border-l-amber-500 bg-amber-50",
    red: "border-l-red-500 bg-red-50",
    purple: "border-l-purple-500 bg-purple-50",
    slate: "border-l-slate-400 bg-white",
  };
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border border-slate-200 border-l-4 shadow-sm p-4 ${colorMap[color]} ${clickable ? "cursor-pointer hover:shadow-md hover:scale-[1.02] transition-all duration-150 active:scale-[0.98]" : ""}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">{label}</p>
          <p className="text-2xl font-black text-slate-900">{value}</p>
          {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
        </div>
        <div className="flex flex-col items-end gap-1">
          {Icon && <Icon className="w-5 h-5 text-slate-300 flex-shrink-0" />}
          {clickable && <span className="text-[10px] text-slate-400 font-medium">View →</span>}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, icon: Icon }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      {Icon && <Icon className="w-4 h-4 text-amber-500" />}
      <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wide">{title}</h2>
      <div className="flex-1 h-px bg-slate-200 ml-2" />
    </div>
  );
}

export default function Reports() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch leads + deals from Railway API, compute reports client-side
      const [leadsRes, dealsRes] = await Promise.all([
        railwayLeads.list({ limit: 2000 }),
        railwayDeals.list({ sort: '-sold_date', limit: 2000 }),
      ]);
      const leads = leadsRes.items || [];
      const deals = dealsRes.items || [];
      const isAdmin = currentUser?.role === 'admin' || currentUser?.role === 'manager';

      // Build lead map for deal enrichment
      const leadMap = new Map(leads.map(l => [l.id, l]));

      // Summary + status counts
      const statusCounts = {};
      const sources = {};
      const projectTypesAll = {};
      const ownerBreakdown = {};
      for (const l of leads) {
        const st = l.status || 'New';
        statusCounts[st] = (statusCounts[st] || 0) + 1;
        if (l.source) sources[l.source] = (sources[l.source] || 0) + 1;
        if (l.project_type) projectTypesAll[l.project_type] = (projectTypesAll[l.project_type] || 0) + 1;
        const owner = l.assigned_rep || 'Unassigned';
        if (!ownerBreakdown[owner]) ownerBreakdown[owner] = { total: 0, statuses: {} };
        ownerBreakdown[owner].total++;
        ownerBreakdown[owner].statuses[st] = (ownerBreakdown[owner].statuses[st] || 0) + 1;
      }

      // Sales metrics
      const now = new Date();
      const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      let soldThisMonth = 0, revenueThisMonth = 0, totalSold = 0, totalRevenue = 0;
      const salesByRep = {};
      const projectTypesSold = {};
      for (const d of deals) {
        const amt = d.contract_amount || d.amount || 0;
        totalSold++;
        totalRevenue += amt;
        const rep = d.assigned_rep || 'Unassigned';
        if (!salesByRep[rep]) salesByRep[rep] = { count: 0, revenue: 0 };
        salesByRep[rep].count++;
        salesByRep[rep].revenue += amt;
        const lead = leadMap.get(d.lead_id) || {};
        const pt = d.project_type || lead.project_type || '';
        if (pt) projectTypesSold[pt] = (projectTypesSold[pt] || 0) + 1;
        if (d.sold_date) {
          const dateStr = String(d.sold_date).includes('T') ? d.sold_date : d.sold_date + 'T00:00:00';
          const sd = new Date(dateStr);
          if (sd >= thisMonth) { soldThisMonth++; revenueThisMonth += amt; }
        }
      }

      setData({
        summary: { total: leads.length, active: leads.filter(l => !['DNQ', 'Lost'].includes(l.status)).length, statusCounts },
        ownerBreakdown,
        sales: {
          soldThisMonth, revenueThisMonth, totalSold, totalRevenue,
          avgDealSize: totalSold > 0 ? totalRevenue / totalSold : 0,
          salesByRep,
        },
        sources,
        projectTypes: { all: projectTypesAll, sold: projectTypesSold },
        isAdmin,
        myName: currentUser?.full_name || currentUser?.email || '',
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="w-7 h-7 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin" />
    </div>
  );

  if (error) return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="text-center text-sm text-red-600">{error}</div>
    </div>
  );

  if (!data) return null;

  const { summary, ownerBreakdown, sales, sources, projectTypes, isAdmin, myName } = data;

  const goToLeads = (status) => navigate(status ? `/leads?status=${encodeURIComponent(status)}` : '/leads');

  // Build status bar chart data
  const statusChartData = Object.entries(summary.statusCounts || {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Owner table rows
  const ownerRows = Object.entries(ownerBreakdown || {})
    .sort((a, b) => b[1].total - a[1].total);

  // Source pie data
  const sourcePieData = Object.entries(sources || {})
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // Project type chart data
  const projectChartData = Object.entries(projectTypes.all || {})
    .map(([name, value]) => ({ name, sold: projectTypes.sold?.[name] || 0, total: value }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Sales by rep chart
  const salesRepData = Object.entries(sales.salesByRep || {})
    .map(([name, d]) => ({ name: name.split(' ')[0], count: d.count, revenue: d.revenue }))
    .sort((a, b) => b.revenue - a.revenue);

  const KEY_STATUSES = ["New", "Appointment scheduled", "Proposal Sent", "Sold", "Lost", "DNQ"];

  return (
    <div className="min-h-full bg-background" style={{ paddingTop: 'max(env(safe-area-inset-top), 1.5rem)' }}>
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-10">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="typography-page-title">Reports & Overview</h1>
            <p className="typography-helper-text mt-1">
              {isAdmin ? "All leads · Full CRM overview" : `Your leads only · ${myName}`}
            </p>
          </div>
          <button onClick={load} className="flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-800 border border-slate-200 bg-white px-3 py-2 rounded-lg transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {/* ── 1. Lead Summary ── */}
        <section>
          <SectionHeader title="Lead Summary" icon={Users} />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-3">
            <StatCard label="Total Leads" value={summary.total} color="slate" icon={Users} clickable onClick={() => goToLeads(null)} />
            <StatCard label="Active" value={summary.active} color="blue" icon={TrendingUp} clickable onClick={() => goToLeads(null)} />
            <StatCard label="New" value={summary.statusCounts?.["New"] || 0} color="blue" clickable onClick={() => goToLeads("New")} />
            <StatCard label="Appt Scheduled" value={summary.statusCounts?.["Appointment scheduled"] || 0} color="green" clickable onClick={() => goToLeads("Appointment scheduled")} />
            <StatCard label="Proposal Sent" value={summary.statusCounts?.["Proposal Sent"] || 0} color="amber" clickable onClick={() => goToLeads("Proposal Sent")} />
            <StatCard label="Sold" value={summary.statusCounts?.["Sold"] || 0} color="green" icon={DollarSign} clickable onClick={() => goToLeads("Sold")} />
            <StatCard label="Lost" value={summary.statusCounts?.["Lost"] || 0} color="red" clickable onClick={() => goToLeads("Lost")} />
            <StatCard label="DNQ" value={summary.statusCounts?.["DNQ"] || 0} color="slate" clickable onClick={() => goToLeads("DNQ")} />
          </div>
        </section>

        {/* ── Status Chart ── */}
        {statusChartData.length > 0 && (
          <div className="bg-white border border-border rounded-xl p-5 shadow-sm">
            <p className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-4">Leads by Status</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={statusChartData} layout="vertical" margin={{ top: 0, right: 16, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11, border: "1px solid #e2e8f0" }} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {statusChartData.map((entry, i) => (
                    <Cell key={i} fill={STATUS_COLORS[entry.name] || "#94a3b8"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── 2. Leads by Owner ── */}
        {isAdmin && ownerRows.length > 0 && (
          <section>
            <SectionHeader title="Leads by Owner / Sales Rep" icon={Users} />
            <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="text-left px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Owner</th>
                      <th className="text-right px-3 py-3 font-bold text-slate-600 uppercase tracking-wide">Total</th>
                      {KEY_STATUSES.map(s => (
                        <th key={s} className="text-right px-3 py-3 font-bold uppercase tracking-wide" style={{ color: STATUS_COLORS[s] || "#64748b" }}>
                          {s === "Appointment scheduled" ? "Appt" : s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {ownerRows.map(([owner, d]) => (
                      <tr key={owner} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 font-semibold text-slate-800">{owner}</td>
                        <td className="px-3 py-3 text-right font-black text-slate-900">{d.total}</td>
                        {KEY_STATUSES.map(s => (
                          <td key={s} className="px-3 py-3 text-right text-slate-600">
                            {d.statuses?.[s] || 0}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* ── 4. Sales / Deals ── */}
        <section>
          <SectionHeader title="Sales & Deals" icon={DollarSign} />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
            <StatCard label="Sold This Month" value={sales.soldThisMonth} color="green" icon={TrendingUp} />
            <StatCard label="Revenue This Month" value={fmt$(sales.revenueThisMonth)} color="green" icon={DollarSign} />
            <StatCard label="Total Sold" value={sales.totalSold} color="amber" />
            <StatCard label="Total Revenue" value={fmt$(sales.totalRevenue)} color="amber" icon={DollarSign} />
            <StatCard label="Avg Deal Size" value={fmt$(sales.avgDealSize)} color="slate" />
          </div>

          {salesRepData.length > 0 && (
            <div className="bg-white border border-border rounded-xl p-5 shadow-sm">
              <p className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-4">Sales by Rep</p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={salesRepData} margin={{ top: 0, right: 8, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ fontSize: 11, border: "1px solid #e2e8f0" }} formatter={(v, n) => n === "revenue" ? fmt$(v) : v} />
                  <Legend iconSize={8} formatter={v => <span style={{ fontSize: 10 }}>{v}</span>} />
                  <Bar dataKey="count" name="Deals Closed" fill="#22c55e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {isAdmin && Object.keys(sales.salesByRep || {}).length > 0 && (
            <div className="mt-3 bg-white border border-border rounded-xl shadow-sm overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Rep</th>
                    <th className="text-right px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Deals Closed</th>
                    <th className="text-right px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {Object.entries(sales.salesByRep).sort((a, b) => b[1].revenue - a[1].revenue).map(([rep, d]) => (
                    <tr key={rep} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-semibold text-slate-800">{rep}</td>
                      <td className="px-4 py-3 text-right text-slate-700">{d.count}</td>
                      <td className="px-4 py-3 text-right font-bold text-emerald-700">{fmt$(d.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── 5. Lead Sources ── */}
        <section>
          <SectionHeader title="Lead Sources" icon={MapPin} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-white border border-border rounded-xl p-5 shadow-sm">
              <p className="text-xs font-bold text-slate-600 uppercase tracking-wider mb-4">Source Breakdown</p>
              {sourcePieData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={sourcePieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value">
                      {sourcePieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ fontSize: 11, border: "1px solid #e2e8f0" }} />
                    <Legend iconType="circle" iconSize={8} formatter={v => <span style={{ fontSize: 10 }}>{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <p className="text-xs text-slate-400 text-center py-8">No source data</p>}
            </div>
            <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Source</th>
                    <th className="text-right px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Leads</th>
                    <th className="text-right px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {sourcePieData.map(({ name, value }) => (
                    <tr key={name} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-700">{name}</td>
                      <td className="px-4 py-3 text-right font-bold text-slate-900">{value}</td>
                      <td className="px-4 py-3 text-right text-slate-400">
                        {summary.total > 0 ? Math.round((value / summary.total) * 100) : 0}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── 6. Project Types ── */}
        <section>
          <SectionHeader title="Project Types" icon={Briefcase} />
          <div className="bg-white border border-border rounded-xl p-5 shadow-sm">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={projectChartData} margin={{ top: 0, right: 8, left: -10, bottom: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} angle={-35} textAnchor="end" interval={0} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11, border: "1px solid #e2e8f0" }} />
                <Legend iconSize={8} formatter={v => <span style={{ fontSize: 10 }}>{v}</span>} />
                <Bar dataKey="total" name="Total Leads" fill="#D4A017" radius={[4, 4, 0, 0]} />
                <Bar dataKey="sold" name="Sold" fill="#22c55e" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 bg-white border border-border rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="text-left px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Project Type</th>
                  <th className="text-right px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Total</th>
                  <th className="text-right px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Sold</th>
                  <th className="text-right px-4 py-3 font-bold text-slate-600 uppercase tracking-wide">Close Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {projectChartData.map(({ name, total, sold }) => (
                  <tr key={name} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-700 font-medium">{name}</td>
                    <td className="px-4 py-3 text-right text-slate-900 font-bold">{total}</td>
                    <td className="px-4 py-3 text-right text-emerald-700 font-bold">{sold}</td>
                    <td className="px-4 py-3 text-right text-slate-500">
                      {total > 0 ? Math.round((sold / total) * 100) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </div>
  );
}