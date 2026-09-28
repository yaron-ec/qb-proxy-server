import { useState, useEffect } from "react";
import * as railwaySystemInfo from "@/api/railway/systemInfo";
import { useAuth } from "@/lib/AuthContext";
import { Activity, CheckCircle2, AlertTriangle, XCircle, Circle, RefreshCw } from "lucide-react";

/**
 * SystemHealth — Admin-only System Health page (PRODUCTIZATION PHASE 2,
 * Section 8), backed by GET /api/v1/system/info. Never renders a secret
 * value — the endpoint itself never returns one.
 */

const STATE_STYLE = {
  CONNECTED:           { icon: CheckCircle2, cls: "text-emerald-600 bg-emerald-50 border-emerald-200", label: "Connected" },
  CONFIGURED:          { icon: Circle,       cls: "text-blue-600 bg-blue-50 border-blue-200",         label: "Configured" },
  NOT_CONFIGURED:      { icon: Circle,       cls: "text-slate-400 bg-slate-50 border-slate-200",       label: "Not Configured" },
  DISABLED:            { icon: Circle,       cls: "text-slate-400 bg-slate-50 border-slate-200",       label: "Disabled" },
  RECONNECT_REQUIRED:  { icon: AlertTriangle,cls: "text-amber-600 bg-amber-50 border-amber-200",       label: "Reconnect Required" },
  ERROR:               { icon: XCircle,      cls: "text-red-600 bg-red-50 border-red-200",             label: "Error" },
};

function StateBadge({ state }) {
  const s = STATE_STYLE[state] || STATE_STYLE.NOT_CONFIGURED;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${s.cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {s.label}
    </span>
  );
}

const MODULE_LABELS = {
  quickbooks: "QuickBooks", gmail: "Gmail", google_calendar: "Google Calendar",
  google_contacts: "Google Contacts", signnow: "SignNow", handoff: "Handoff",
  meta: "Meta / Facebook Lead Ads", sms: "SMS (Twilio)", website_intake: "Website Lead Intake",
};

export default function SystemHealth() {
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError(null);
    railwaySystemInfo.get()
      .then((res) => setInfo(res))
      .catch((e) => setError(e?.message || "Failed to load system info"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (user && user.role !== "admin") {
    return (
      <div className="p-8 max-w-2xl mx-auto text-center">
        <h1 className="text-xl font-bold text-slate-800 mb-2">System Health</h1>
        <p className="text-slate-500">This page is available to admins only.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-slate-500" />
          <h1 className="text-xl font-bold text-slate-800">System Health</h1>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3">{error}</div>
      )}

      {info && (
        <>
          {/* Installation identity */}
          <section className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-sm font-bold text-slate-700 mb-3">Installation</h2>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-500">Company</dt>
              <dd className="text-slate-800 font-medium">{info.installation?.company_name || "—"}</dd>
              <dt className="text-slate-500">Installation ID</dt>
              <dd className="text-slate-800 font-mono text-xs">{info.installation?.installation_id || "—"}</dd>
              <dt className="text-slate-500">Product version</dt>
              <dd className="text-slate-800">{info.product_version || "—"}</dd>
              <dt className="text-slate-500">Build commit</dt>
              <dd className="text-slate-800 font-mono text-xs">{info.build_commit ? info.build_commit.slice(0, 12) : "unknown"}</dd>
              <dt className="text-slate-500">Migrations applied</dt>
              <dd className="text-slate-800">{info.schema?.migrations_applied ?? "—"}</dd>
              <dt className="text-slate-500">Last migration</dt>
              <dd className="text-slate-800">{info.schema?.last_migration_applied_at ? new Date(info.schema.last_migration_applied_at).toLocaleString() : "—"}</dd>
            </dl>
          </section>

          {/* Integrations */}
          <section className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="text-sm font-bold text-slate-700 mb-3">Integrations</h2>
            <div className="divide-y divide-slate-100">
              {Object.entries(info.integrations || {}).map(([key, val]) => (
                <div key={key} className="flex items-center justify-between py-2.5">
                  <div>
                    <div className="text-sm font-medium text-slate-800">{MODULE_LABELS[key] || key}</div>
                    {!val.module_enabled ? (
                      <div className="text-xs text-slate-400">Not enabled for this installation</div>
                    ) : !val.env_configured ? (
                      <div className="text-xs text-slate-400">Missing: {(val.missing_env || []).join(", ") || "—"}</div>
                    ) : val.connection?.last_used_at ? (
                      <div className="text-xs text-slate-400">Last used {new Date(val.connection.last_used_at).toLocaleString()}</div>
                    ) : null}
                  </div>
                  <StateBadge state={val.connection?.state} />
                </div>
              ))}
            </div>
          </section>

          <p className="text-xs text-slate-400 text-center">
            Generated {info.generated_at ? new Date(info.generated_at).toLocaleString() : "—"} — no secret values are ever shown here.
          </p>
        </>
      )}
    </div>
  );
}
