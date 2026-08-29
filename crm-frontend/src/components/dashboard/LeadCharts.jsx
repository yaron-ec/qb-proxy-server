import { useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";
import { format, subMonths, startOfMonth, parseISO, isAfter } from "date-fns";

const STATUS_COLORS = {
  "New": "#3b82f6",
  "Contacted": "#8b5cf6",
  "Answered, no appointment set": "#6b7280",
  "Appointment scheduled": "#10b981",
  "Qualified": "#06b6d4",
  "Estimate Sent": "#f59e0b",
  "Proposal Sent": "#f97316",
  "Close won": "#22c55e",
  "Closed Lost": "#ef4444",
  "Unqualified": "#9ca3af",
};

const SOURCE_COLORS = ["#D4A017", "#3b82f6", "#10b981", "#f97316", "#8b5cf6", "#ef4444", "#06b6d4"];

export default function LeadCharts({ leads }) {
  // Lead Volume Over Time (last 12 months)
  const volumeData = useMemo(() => {
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const monthStart = startOfMonth(subMonths(new Date(), i));
      const label = format(monthStart, "MMM yy");
      const count = leads.filter(l => {
        if (!l.created_date) return false;
        const d = new Date(l.created_date);
        return d.getMonth() === monthStart.getMonth() && d.getFullYear() === monthStart.getFullYear();
      }).length;
      months.push({ month: label, leads: count });
    }
    return months;
  }, [leads]);

  // Leads by Status
  const statusData = useMemo(() => {
    const counts = {};
    for (const lead of leads) {
      const s = lead.status || "New";
      counts[s] = (counts[s] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [leads]);

  // Leads by Source
  const sourceData = useMemo(() => {
    const counts = {};
    for (const lead of leads) {
      const s = lead.source || "Other";
      counts[s] = (counts[s] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [leads]);

  return (
    <div className="space-y-6 mt-8">
      {/* Lead Volume Over Time */}
      <div className="bg-white border border-border p-6">
        <h2 className="text-sm font-black tracking-widest uppercase text-slate-700 mb-1">Lead Volume Over Time</h2>
        <p className="text-xs text-muted-foreground font-mono mb-5">Last 12 months</p>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={volumeData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="leadGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#D4A017" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#D4A017" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="month" tick={{ fontSize: 10, fontFamily: "monospace" }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 10, fontFamily: "monospace" }} />
            <Tooltip
              contentStyle={{ fontSize: 12, fontFamily: "monospace", border: "1px solid #e2e8f0" }}
              formatter={(v) => [v, "Leads"]}
            />
            <Area type="monotone" dataKey="leads" stroke="#D4A017" strokeWidth={2} fill="url(#leadGrad)" dot={{ r: 3, fill: "#D4A017" }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Leads by Status */}
        <div className="bg-white border border-border p-6">
          <h2 className="text-sm font-black tracking-widest uppercase text-slate-700 mb-1">Leads by Status</h2>
          <p className="text-xs text-muted-foreground font-mono mb-5">Current pipeline breakdown</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={statusData} layout="vertical" margin={{ top: 0, right: 16, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fontFamily: "monospace" }} />
              <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 9, fontFamily: "monospace" }} />
              <Tooltip
                contentStyle={{ fontSize: 12, fontFamily: "monospace", border: "1px solid #e2e8f0" }}
                formatter={(v) => [v, "Leads"]}
              />
              <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                {statusData.map((entry, i) => (
                  <Cell key={i} fill={STATUS_COLORS[entry.name] || "#94a3b8"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Lead Sources */}
        <div className="bg-white border border-border p-6">
          <h2 className="text-sm font-black tracking-widest uppercase text-slate-700 mb-1">Lead Sources</h2>
          <p className="text-xs text-muted-foreground font-mono mb-5">Where your leads come from</p>
          {sourceData.length === 0 ? (
            <div className="flex items-center justify-center h-[220px] text-xs text-muted-foreground font-mono">No source data</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={sourceData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {sourceData.map((_, i) => (
                    <Cell key={i} fill={SOURCE_COLORS[i % SOURCE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ fontSize: 12, fontFamily: "monospace", border: "1px solid #e2e8f0" }}
                  formatter={(v, n) => [v, n]}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  formatter={(v) => <span style={{ fontSize: 10, fontFamily: "monospace" }}>{v}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}