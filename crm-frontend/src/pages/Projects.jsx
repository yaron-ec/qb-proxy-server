import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { Plus, ArrowRight, CheckCircle, Clock, AlertCircle, XCircle, Download } from "lucide-react";

const STATUS_ICON = {
  "Pre-Construction": <Clock className="w-3 h-3 text-blueprint" />,
  "In Progress": <CheckCircle className="w-3 h-3 text-emerald-600" />,
  "On Hold": <AlertCircle className="w-3 h-3 text-orange" />,
  "Completed": <CheckCircle className="w-3 h-3 text-muted-foreground" />,
  "Cancelled": <XCircle className="w-3 h-3 text-destructive" />,
};

const STATUS_COLOR = {
  "Pre-Construction": "border-l-blueprint",
  "In Progress": "border-l-emerald-600",
  "On Hold": "border-l-orange",
  "Completed": "border-l-muted",
  "Cancelled": "border-l-destructive",
};

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("All");

  useEffect(() => {
    apiCall('/api/v1/deals', { method: 'GET' }).then(res => {
      const data = Array.isArray(res) ? res : (res?.items || []);
      setProjects(data);
      setLoading(false);
    });
  }, []);

  const statuses = ["All", "Pre-Construction", "In Progress", "On Hold", "Completed", "Cancelled"];
  const filtered = statusFilter === "All" ? projects : projects.filter(p => p.status === statusFilter);

  const handleExport = async () => {
    const response = await apiCall('/api/v1/leads?limit=5000', { method: 'GET' });
    const url = window.URL.createObjectURL(new Blob([JSON.stringify(response)]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `backup_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    link.parentNode.removeChild(link);
  };

  return (
    <div className="p-8 min-h-full">
      <div className="mb-8 border-b border-border pb-6 flex items-end justify-between">
        <div>
          <div className="text-[10px] font-mono font-bold tracking-widest text-muted-foreground uppercase mb-1">CRM — PROJECT REGISTRY</div>
          <h1 className="text-4xl font-black text-midnight tracking-tight uppercase">Projects</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 bg-white border border-border text-midnight px-5 py-3 text-xs font-bold tracking-widest uppercase hover:bg-slate-50 transition-colors"
          >
            <Download className="w-3 h-3" /> Export
          </button>
          <Link
            to="/projects/new"
            className="flex items-center gap-2 bg-orange text-white px-5 py-3 text-xs font-bold tracking-widest uppercase hover:bg-orange/90 transition-colors"
          >
            <Plus className="w-3 h-3" /> New Project
          </Link>
        </div>
      </div>

      {/* Status filters */}
      <div className="flex gap-2 flex-wrap mb-6">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 text-[10px] font-bold tracking-widest uppercase font-mono transition-colors border
              ${statusFilter === s ? "bg-midnight text-white border-midnight" : "bg-white text-muted-foreground border-border hover:border-midnight hover:text-midnight"}`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="text-[10px] font-mono text-muted-foreground tracking-wider uppercase mb-4">
        {filtered.length} project{filtered.length !== 1 ? "s" : ""}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-muted border-t-orange rounded-full animate-spin" />
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.length === 0 ? (
            <div className="col-span-3 bg-white border border-border p-12 text-center text-[10px] font-mono text-muted-foreground tracking-widest uppercase">
              No projects found
            </div>
          ) : filtered.map(p => (
            <Link key={p.id} to={`/projects/${p.id}`}>
              <div className={`bg-white border border-border border-l-4 p-5 hover:shadow-lg hover:-translate-y-0.5 transition-all duration-150 h-full ${STATUS_COLOR[p.status] || ""}`}>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {STATUS_ICON[p.status]}
                    <span className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground">{p.status}</span>
                  </div>
                  <ArrowRight className="w-3 h-3 text-muted-foreground" />
                </div>
                <h3 className="font-black text-midnight text-sm uppercase tracking-tight mb-1">{p.name}</h3>
                <div className="text-[11px] font-mono text-muted-foreground mb-3">{p.property_address || "—"}</div>
                {p.project_type && (
                  <div className="text-[10px] font-mono font-bold text-blueprint uppercase tracking-wider">{p.project_type}</div>
                )}
                {p.contract_value && (
                  <div className="text-sm font-black text-orange mt-2">${p.contract_value.toLocaleString()}</div>
                )}
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                  <div className="text-[10px] font-mono text-muted-foreground">
                    {p.start_date ? new Date(p.start_date).toLocaleDateString() : "No start date"}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    PM: {p.assigned_pm ? p.assigned_pm.split("@")[0] : "Unassigned"}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}