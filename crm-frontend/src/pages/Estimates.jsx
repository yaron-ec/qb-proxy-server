import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { Plus, ArrowRight, FileText } from "lucide-react";

const STATUS_COLOR = {
  "Draft": "bg-muted text-muted-foreground",
  "Sent": "bg-blueprint text-white",
  "Viewed": "bg-blueprint/60 text-white",
  "Accepted": "bg-emerald-600 text-white",
  "Declined": "bg-destructive text-white",
};

export default function Estimates() {
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiCall('/api/v1/handoff-estimates', { method: 'GET' }).then(res => {
      const data = Array.isArray(res) ? res : (res?.items || []);
      setEstimates(data);
      setLoading(false);
    });
  }, []);

  const totalAccepted = estimates
    .filter(e => e.status === "Accepted")
    .reduce((s, e) => s + (e.total || 0), 0);

  return (
    <div className="p-8 min-h-full">
      <div className="mb-8 border-b border-border pb-6 flex items-end justify-between">
        <div>
          <div className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground uppercase mb-1">CRM — ESTIMATION ENGINE</div>
          <h1 className="text-4xl font-black text-midnight tracking-tight uppercase">Estimates</h1>
        </div>
        <Link
          to="/estimates/new"
          className="flex items-center gap-2 bg-orange text-white px-5 py-3 text-xs font-bold tracking-widest uppercase hover:bg-orange/90 transition-colors"
        >
          <Plus className="w-3 h-3" /> New Estimate
        </Link>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: "Total Estimates", value: estimates.length },
          { label: "Accepted", value: estimates.filter(e => e.status === "Accepted").length },
          { label: "Accepted Value", value: `$${(totalAccepted / 1000).toFixed(0)}K` },
        ].map(s => (
          <div key={s.label} className="bg-white border border-border p-5">
            <div className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground mb-1">{s.label}</div>
            <div className="text-2xl font-black text-midnight">{s.value}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-muted border-t-orange rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-white border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-concrete border-b border-border">
                {["Title", "Status", "Total", "Deposit", "Valid Until", ""].map(h => (
                  <th key={h} className="text-left px-4 py-3 text-[10px] font-bold tracking-widest uppercase font-mono text-muted-foreground">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {estimates.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-16 text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                    No estimates yet
                  </td>
                </tr>
              ) : estimates.map((e, i) => (
                <tr key={e.id} className={`border-b border-border last:border-0 hover:bg-concrete/60 transition-colors ${i % 2 === 0 ? '' : 'bg-concrete/20'}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FileText className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      <span className="font-bold text-sm text-midnight">{e.title}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 text-[10px] font-bold tracking-widest uppercase font-mono rounded-sm ${STATUS_COLOR[e.status] || "bg-muted text-muted-foreground"}`}>
                      {e.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm font-black text-midnight">
                    {e.total ? `$${e.total.toLocaleString()}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                    {e.deposit_amount ? `$${e.deposit_amount.toLocaleString()}` : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                    {e.valid_until || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/estimates/${e.id}`} className="flex items-center gap-1 text-orange text-xs font-bold uppercase tracking-wider hover:underline">
                      View <ArrowRight className="w-3 h-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}