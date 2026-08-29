import { useState } from "react";
import * as railwayLeads from "@/api/railway/leads";
import * as railwayDeals from "@/api/railway/deals";
import { Download, Loader2, CheckCircle, Users, TrendingUp, FileText } from "lucide-react";

function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return s.includes(",") || s.includes("\n") || s.includes('"') ? `"${s}"` : s;
  };
  return [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\n");
}

function downloadCSV(filename, csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const EXPORTS = [
  {
    key: "leads",
    label: "Leads",
    description: "All contacts — name, email, phone, address, status, source, assigned rep, dates",
    icon: Users,
    color: "blue",
    fetch: async () => { const res = await railwayLeads.list({ sort: '-created_date', limit: 5000 }); return res.items || []; },
    map: (l) => ({
      id: l.id,
      first_name: l.first_name,
      last_name: l.last_name,
      email: l.email || "",
      phone: l.phone || "",
      property_address: l.property_address || "",
      city: l.city || "",
      status: l.status || "",
      lead_score: l.lead_score || 0,
      source: l.source || "",
      assigned_rep: l.assigned_rep || "",
      project_type: l.project_type || "",
      budget_range: l.budget_range || "",
      appointment_date: l.appointment_date || "",
      follow_up_date: l.follow_up_date || "",
      notes: l.notes || "",
      created_date: l.created_date ? new Date(l.created_date).toLocaleDateString() : "",
    }),
    filename: () => `leads_${new Date().toISOString().slice(0,10)}.csv`,
  },
  {
    key: "deals",
    label: "Deals",
    description: "All deals — name, stage, amount, payment milestones, dates",
    icon: TrendingUp,
    color: "amber",
    fetch: async () => { const res = await railwayDeals.list({ sort: '-created_date', limit: 5000 }); return res.items || []; },
    map: (d) => ({
      id: d.id,
      lead_id: d.lead_id || "",
      name: d.name || "",
      stage: d.stage || "",
      amount: d.amount || 0,
      pipeline: d.pipeline || "",
      close_date: d.close_date || "",
      work_start_date: d.work_start_date || "",
      work_end_date: d.work_end_date || "",
      deposit_amount: d.deposit_amount || 0,
      deposit_paid: d.deposit_paid || 0,
      deposit_paid_date: d.deposit_paid_date || "",
      progress_payment_amount: d.progress_payment_amount || 0,
      progress_payment_paid: d.progress_payment_paid || 0,
      final_payment_amount: d.final_payment_amount || 0,
      final_payment_paid: d.final_payment_paid || 0,
      created_date: d.created_date ? new Date(d.created_date).toLocaleDateString() : "",
    }),
    filename: () => `deals_${new Date().toISOString().slice(0,10)}.csv`,
  },
  {
    key: "estimates",
    label: "Estimates",
    description: "All estimates — title, status, total, QB info, lead/project links",
    icon: FileText,
    color: "emerald",
    fetch: async () => { return []; },
    map: (e) => ({
      id: e.id,
      lead_id: e.lead_id || "",
      project_id: e.project_id || "",
      title: e.title || "",
      status: e.status || "",
      subtotal: e.subtotal || 0,
      markup_pct: e.markup_pct || 0,
      total: e.total || 0,
      deposit_amount: e.deposit_amount || 0,
      valid_until: e.valid_until || "",
      qb_estimate_id: e.qb_estimate_id || "",
      qb_estimate_number: e.qb_estimate_number || "",
      qb_status: e.qb_status || "",
      notes: e.notes || "",
      created_date: e.created_date ? new Date(e.created_date).toLocaleDateString() : "",
    }),
    filename: () => `estimates_${new Date().toISOString().slice(0,10)}.csv`,
  },
];

const COLOR_MAP = {
  blue:    { bg: "bg-blue-50",    border: "border-blue-200",    icon: "bg-blue-100 text-blue-600",    btn: "bg-blue-600 hover:bg-blue-700" },
  amber:   { bg: "bg-amber-50",   border: "border-amber-200",   icon: "bg-amber-100 text-amber-600",   btn: "bg-amber-600 hover:bg-amber-700" },
  emerald: { bg: "bg-emerald-50", border: "border-emerald-200", icon: "bg-emerald-100 text-emerald-600", btn: "bg-emerald-600 hover:bg-emerald-700" },
};

export default function ExportTab() {
  const [loadingKey, setLoadingKey] = useState(null);
  const [doneKey, setDoneKey] = useState(null);

  const handleExport = async (exp) => {
    setLoadingKey(exp.key);
    setDoneKey(null);
    const data = await exp.fetch();
    const rows = data.map(exp.map);
    const csv = toCSV(rows);
    downloadCSV(exp.filename(), csv);
    setLoadingKey(null);
    setDoneKey(exp.key);
    setTimeout(() => setDoneKey(null), 3000);
  };

  const handleExportAll = async () => {
    setLoadingKey("all");
    setDoneKey(null);
    const [leads, deals, estimates] = await Promise.all(EXPORTS.map(e => e.fetch()));
    const datasets = [
      { name: "Leads", rows: leads.map(EXPORTS[0].map) },
      { name: "Deals", rows: deals.map(EXPORTS[1].map) },
      { name: "Estimates", rows: estimates.map(EXPORTS[2].map) },
    ];
    // Build a combined CSV with section headers
    const sections = datasets.map(({ name, rows }) => {
      if (!rows.length) return `# ${name}\n(no data)\n`;
      return `# ${name}\n${toCSV(rows)}\n`;
    });
    downloadCSV(`crm_export_${new Date().toISOString().slice(0,10)}.csv`, sections.join("\n"));
    setLoadingKey(null);
    setDoneKey("all");
    setTimeout(() => setDoneKey(null), 3000);
  };

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Export All */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-slate-800">Export Everything</p>
          <p className="text-xs text-slate-500 mt-0.5">Downloads leads, deals & estimates in a single CSV file</p>
        </div>
        <button
          onClick={handleExportAll}
          disabled={!!loadingKey}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap"
        >
          {loadingKey === "all"
            ? <Loader2 className="w-4 h-4 animate-spin" />
            : doneKey === "all"
            ? <CheckCircle className="w-4 h-4" />
            : <Download className="w-4 h-4" />}
          {loadingKey === "all" ? "Exporting..." : doneKey === "all" ? "Downloaded!" : "Export All"}
        </button>
      </div>

      <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 px-1">Or export individually</p>

      {/* Individual exports */}
      <div className="space-y-3">
        {EXPORTS.map((exp) => {
          const c = COLOR_MAP[exp.color];
          const Icon = exp.icon;
          const isLoading = loadingKey === exp.key;
          const isDone = doneKey === exp.key;
          return (
            <div key={exp.key} className={`${c.bg} border ${c.border} rounded-xl p-4 flex items-center justify-between gap-4`}>
              <div className="flex items-center gap-3">
                <div className={`w-9 h-9 rounded-lg ${c.icon} flex items-center justify-center flex-shrink-0`}>
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-800">{exp.label}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{exp.description}</p>
                </div>
              </div>
              <button
                onClick={() => handleExport(exp)}
                disabled={!!loadingKey}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-white ${c.btn} disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap`}
              >
                {isLoading
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : isDone
                  ? <CheckCircle className="w-3.5 h-3.5" />
                  : <Download className="w-3.5 h-3.5" />}
                {isLoading ? "Exporting..." : isDone ? "Downloaded!" : "Export CSV"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}