import { useState } from "react";
import { railwayRequest, normalizeIntegrationError } from "@/lib/railwayClient";
import { CheckCircle, AlertTriangle, XCircle, RefreshCw, ClipboardList, ChevronDown, ChevronRight, Wrench } from "lucide-react";

const STATUS_COLORS = {
  ok:       "text-green-600 bg-green-50 border-green-200",
  repaired: "text-blue-600 bg-blue-50 border-blue-200",
  issues:   "text-red-600 bg-red-50 border-red-200",
};

const STATUS_ICONS = {
  ok:       <CheckCircle className="w-4 h-4 text-green-500" />,
  repaired: <Wrench className="w-4 h-4 text-blue-500" />,
  issues:   <XCircle className="w-4 h-4 text-red-500" />,
};

function StatCard({ label, value, color = "slate" }) {
  const colors = {
    green:  "bg-green-50 border-green-200 text-green-700",
    red:    "bg-red-50 border-red-200 text-red-700",
    amber:  "bg-amber-50 border-amber-200 text-amber-700",
    blue:   "bg-blue-50 border-blue-200 text-blue-700",
    slate:  "bg-slate-50 border-slate-200 text-slate-700",
  };
  return (
    <div className={`border rounded-lg px-3 py-2 text-center ${colors[color]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-semibold mt-0.5 whitespace-nowrap">{label}</div>
    </div>
  );
}

function RecordRow({ rec }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`border rounded-lg mb-2 text-xs ${STATUS_COLORS[rec.status] || STATUS_COLORS.issues}`}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen(o => !o)}
      >
        {STATUS_ICONS[rec.status] || STATUS_ICONS.issues}
        <span className="font-semibold flex-1">{rec.name}</span>
        <span className="text-slate-500">{rec.date} {rec.crm_time}</span>
        <span className="text-slate-400 ml-1">{rec.owner || "—"}</span>
        {open ? <ChevronDown className="w-3 h-3 ml-1" /> : <ChevronRight className="w-3 h-3 ml-1" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1">
          {rec.issues.length > 0 && (
            <div>
              <div className="font-semibold text-red-600 mb-0.5">Issues:</div>
              {rec.issues.map((issue, i) => <div key={i} className="text-red-700 ml-2">• {issue}</div>)}
            </div>
          )}
          {rec.repairs.length > 0 && (
            <div>
              <div className="font-semibold text-blue-600 mb-0.5">Repairs:</div>
              {rec.repairs.map((r, i) => <div key={i} className="text-blue-700 ml-2">• {r}</div>)}
            </div>
          )}
          <div className="text-slate-500 mt-1">Lead ID: {rec.lead_id} | Owner Email: {rec.owner_email || "—"}</div>
        </div>
      )}
    </div>
  );
}

export default function CalendarAuditPanel() {
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [dryRun, setDryRun] = useState(false);

  const runAudit = async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const data = await railwayRequest('/calendar/full-audit', { dry_run: dryRun });
      setReport(data.report);
    } catch (e) {
      setError(normalizeIntegrationError(e) || "Audit failed");
    } finally {
      setRunning(false);
    }
  };

  const filteredRecords = report?.records?.filter(r => {
    if (filter === "all") return true;
    if (filter === "ok") return r.status === "ok";
    if (filter === "repaired") return r.status === "repaired";
    if (filter === "issues") return r.status === "issues";
    return true;
  }) || [];

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-amber-600" />
          <h2 className="text-sm font-bold text-slate-900">Full Calendar Audit</h2>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={e => setDryRun(e.target.checked)}
              className="rounded"
            />
            Dry Run (no repairs)
          </label>
          <button
            onClick={runAudit}
            disabled={running}
            className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${running ? "animate-spin" : ""}`} />
            {running ? "Auditing…" : "Run Audit"}
          </button>
        </div>
      </div>

      {running && (
        <div className="text-center py-8">
          <div className="w-8 h-8 border-4 border-slate-200 border-t-amber-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">Checking all future meetings against Google Calendar…</p>
          <p className="text-xs text-slate-400 mt-1">This may take 1–3 minutes depending on meeting count.</p>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {report && !running && (
        <>
          {/* Stats Grid */}
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 mb-4">
            <StatCard label="Total" value={report.total_future_meetings} color="slate" />
            <StatCard label="✓ Synced" value={report.correctly_synced} color="green" />
            <StatCard label="Repaired" value={report.repaired} color="blue" />
            <StatCard label="Failed" value={report.failed} color={report.failed > 0 ? "red" : "slate"} />
            <StatCard label="No Owner" value={report.missing_owner} color={report.missing_owner > 0 ? "amber" : "slate"} />
            <StatCard label="No Owner Cal" value={report.missing_owner_calendar} color={report.missing_owner_calendar > 0 ? "red" : "slate"} />
            <StatCard label="No Michelle" value={report.missing_michelle_calendar} color={report.missing_michelle_calendar > 0 ? "amber" : "slate"} />
            <StatCard label="No Buffer" value={report.missing_travel_buffer} color={report.missing_travel_buffer > 0 ? "red" : "slate"} />
            <StatCard label="Wrong Time" value={report.wrong_time} color={report.wrong_time > 0 ? "red" : "slate"} />
            <StatCard label="Duplicates" value={report.duplicates_found} color={report.duplicates_found > 0 ? "amber" : "slate"} />
          </div>

          {report.quota_hit && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2 text-xs text-amber-700 mb-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Google Calendar quota was hit — some meetings were not fully checked. Run again to continue.
            </div>
          )}

          <div className="text-xs text-slate-400 mb-3">
            Generated: {new Date(report.generated_at).toLocaleString()} {report.dry_run ? "· DRY RUN" : "· Repairs applied"}
          </div>

          {/* Filter Tabs */}
          <div className="flex gap-1 border-b border-slate-200 mb-3">
            {["all", "issues", "repaired", "ok"].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs font-semibold border-b-2 capitalize transition-colors ${
                  filter === f ? "border-amber-600 text-amber-700" : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
              >
                {f === "all" ? `All (${report.records.length})` : f === "issues" ? `Issues (${report.records.filter(r => r.status === "issues").length})` : f === "repaired" ? `Repaired (${report.records.filter(r => r.status === "repaired").length})` : `OK (${report.records.filter(r => r.status === "ok").length})`}
              </button>
            ))}
          </div>

          {/* Records */}
          <div className="max-h-[500px] overflow-y-auto pr-1">
            {filteredRecords.length === 0 ? (
              <div className="text-center py-8 text-sm text-slate-400">No records match this filter.</div>
            ) : (
              filteredRecords.map(rec => <RecordRow key={rec.lead_id} rec={rec} />)
            )}
          </div>
        </>
      )}

      {!report && !running && !error && (
        <div className="text-center py-10 text-slate-400">
          <ClipboardList className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Click "Run Audit" to check all future meetings.</p>
        </div>
      )}
    </div>
  );
}