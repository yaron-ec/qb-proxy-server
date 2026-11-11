/**
 * EstimateFollowUps — admin/manager-only global oversight page for the
 * automated 14-day estimate follow-up email sequence: state counts across
 * every lead, a dry-run eligibility report, and the versioned template
 * editor for the 6 email steps.
 *
 * Client-side role gating here is a UX courtesy only — every call this page
 * makes is independently enforced server-side (requireRole('admin'|'manager'),
 * requireRole('admin') for template saves) via routes/estimateFollowups.js.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2, RefreshCw, Save, Eye } from "lucide-react";
import * as railwayApi from "@/lib/railwayApi";
import * as api from "@/api/railway/estimateFollowups";

const STATUS_LABEL = { active: "Active", paused: "Paused", completed: "Completed", stopped: "Stopped" };

function OverviewTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.getAdminOverview()
      .then((res) => { setData(res); setLoading(false); })
      .catch((e) => { setError(e.data?.message || e.message || "Failed to load"); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>;
  if (error) return <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-3">
          {Object.entries(STATUS_LABEL).map(([key, label]) => (
            <div key={key} className="bg-white border border-slate-200 rounded-lg px-4 py-3 text-center min-w-[90px]">
              <div className="text-2xl font-bold text-slate-800">{data.counts[key] || 0}</div>
              <div className="text-[10px] font-semibold text-slate-400 uppercase">{label}</div>
            </div>
          ))}
        </div>
        <button onClick={load} className="flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-semibold">Lead</th>
              <th className="text-left px-3 py-2 font-semibold">Status</th>
              <th className="text-left px-3 py-2 font-semibold">Recipient</th>
              <th className="text-left px-3 py-2 font-semibold">Sales Rep</th>
              <th className="text-left px-3 py-2 font-semibold">Sent</th>
              <th className="text-left px-3 py-2 font-semibold">Failed</th>
              <th className="text-left px-3 py-2 font-semibold">Enrolled</th>
            </tr>
          </thead>
          <tbody>
            {data.sequences.map((s) => (
              <tr key={s.leadId} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2"><Link to={`/leads/${s.leadId}`} className="text-blue-600 hover:underline">{s.leadName || s.leadId}</Link></td>
                <td className="px-3 py-2">{STATUS_LABEL[s.status] || s.status}</td>
                <td className="px-3 py-2">{s.recipientEmail}</td>
                <td className="px-3 py-2">{s.salesRepName || "—"}</td>
                <td className="px-3 py-2">{s.sentCount}</td>
                <td className="px-3 py-2">{s.failedCount > 0 ? <span className="text-red-600 font-semibold">{s.failedCount}</span> : 0}</td>
                <td className="px-3 py-2 text-slate-400">{new Date(s.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {data.sequences.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">No estimate follow-up sequences yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DryRunReportTab() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const run = () => {
    setLoading(true);
    setError(null);
    api.getDryRunReport()
      .then((res) => { setReport(res); setLoading(false); })
      .catch((e) => { setError(e.data?.message || e.message || "Failed to load"); setLoading(false); });
  };

  return (
    <div>
      <p className="text-xs text-slate-500 mb-3">
        Read-only report: every lead with a Pending QuickBooks estimate, and whether it would be eligible to
        enroll in the estimate follow-up sequence today. Never sends anything.
      </p>
      <button onClick={run} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700 disabled:opacity-50 mb-3">
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />} Run Report
      </button>
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}
      {report && (
        <>
          <div className="flex gap-3 mb-3">
            {Object.entries(report.by_state).map(([state, count]) => (
              <div key={state} className="bg-white border border-slate-200 rounded-lg px-4 py-2 text-center">
                <div className="text-xl font-bold text-slate-800">{count}</div>
                <div className="text-[10px] font-semibold text-slate-400 uppercase">{state.replace(/_/g, " ")}</div>
              </div>
            ))}
          </div>
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden max-h-[500px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Lead</th>
                  <th className="text-left px-3 py-2 font-semibold">Estimate #</th>
                  <th className="text-left px-3 py-2 font-semibold">State</th>
                  <th className="text-left px-3 py-2 font-semibold">Reasons</th>
                </tr>
              </thead>
              <tbody>
                {report.leads.map((l) => (
                  <tr key={`${l.lead_id}-${l.estimate_id}`} className="border-t border-slate-100">
                    <td className="px-3 py-2"><Link to={`/leads/${l.lead_id}`} className="text-blue-600 hover:underline">{l.lead_id.slice(0, 8)}</Link></td>
                    <td className="px-3 py-2">{l.qb_estimate_number || "—"}</td>
                    <td className="px-3 py-2">{l.state.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2 text-slate-500">{(l.reasons || []).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[10px] text-slate-400 mt-2">Generated: {new Date(report.generated_at).toLocaleString()}</div>
        </>
      )}
    </div>
  );
}

function AutomationStatusTab() {
  const [status, setStatus] = useState(null);
  const [ambiguous, setAmbiguous] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [resolving, setResolving] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([api.getAutomationStatus(), api.getAmbiguousReplies()])
      .then(([statusRes, ambiguousRes]) => {
        setStatus(statusRes.replyMonitoring);
        setAmbiguous(ambiguousRes.ambiguousReplies);
        setLoading(false);
      })
      .catch((e) => { setError(e.data?.message || e.message || "Failed to load"); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const resolve = async (id) => {
    setResolving(id);
    try {
      await api.resolveAmbiguousReply(id);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || "Failed to resolve");
    } finally {
      setResolving(null);
    }
  };

  if (loading) return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>;
  if (error) return <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>;

  const healthy = status.enabled && status.healthyForSending;

  return (
    <div>
      <div className={`mb-4 p-3 rounded-lg border text-sm ${healthy ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
        <div className="font-bold mb-1">
          Reply monitoring: {status.enabled ? (healthy ? "Healthy" : `Enabled but ${status.status || "unhealthy"}`) : "Disabled"}
        </div>
        <div className="text-xs">
          {!healthy && "Per the fail-closed safety rule, EVERY estimate follow-up send across EVERY lead is currently held until this recovers."}
          {healthy && "Automated estimate follow-up emails may send normally — reply detection is active and polling Gmail successfully."}
        </div>
        {status.lastSuccessAt && (
          <div className="text-[11px] mt-1 opacity-75">Last successful poll: {new Date(status.lastSuccessAt).toLocaleString()}</div>
        )}
        {status.lastError && (
          <div className="text-[11px] mt-1 opacity-75">Last error: {status.lastError}</div>
        )}
      </div>

      <h3 className="text-sm font-bold text-slate-700 mb-2">Ambiguous Replies — Manual Triage</h3>
      <p className="text-xs text-slate-500 mb-3">
        An inbound reply that could not be matched to exactly one active/paused sequence (zero or multiple
        candidates) is recorded here rather than guessed. Resolve once reviewed.
      </p>
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 font-semibold">From</th>
              <th className="text-left px-3 py-2 font-semibold">Reason</th>
              <th className="text-left px-3 py-2 font-semibold">Candidates</th>
              <th className="text-left px-3 py-2 font-semibold">Received</th>
              <th className="text-left px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {ambiguous.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{r.from_address}</td>
                <td className="px-3 py-2 text-slate-500">{r.reason.replace(/_/g, " ")}</td>
                <td className="px-3 py-2">{(r.candidate_sequence_ids || []).length}</td>
                <td className="px-3 py-2 text-slate-400">{r.received_at ? new Date(r.received_at).toLocaleString() : "—"}</td>
                <td className="px-3 py-2">{r.resolved ? <span className="text-emerald-600">Resolved</span> : <span className="text-amber-600">Needs review</span>}</td>
                <td className="px-3 py-2">
                  {!r.resolved && (
                    <button disabled={resolving === r.id} onClick={() => resolve(r.id)} className="text-blue-600 hover:underline disabled:opacity-50">
                      Mark Resolved
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {ambiguous.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No ambiguous replies.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TemplateEditorTab({ isAdmin }) {
  const [templates, setTemplates] = useState(null);
  const [selected, setSelected] = useState(null);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = () => {
    api.listTemplates()
      .then((res) => {
        setTemplates(res.templates);
        if (res.templates.length) selectTemplate(res.templates[0]);
      })
      .catch((e) => setError(e.data?.message || e.message || "Failed to load templates"));
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  const selectTemplate = (t) => {
    setSelected(t);
    setSubject(t.template?.subject || "");
    setBodyHtml(t.template?.body_html || "");
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveTemplate(selected.templateKey, { subject, bodyHtml });
      setSaved(true);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!templates) return <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>;

  return (
    <div className="flex gap-4">
      <div className="w-48 flex-shrink-0">
        {templates.map((t) => (
          <button
            key={t.templateKey}
            onClick={() => selectTemplate(t)}
            className={`w-full text-left px-3 py-2 text-xs rounded mb-1 ${selected?.templateKey === t.templateKey ? "bg-blue-50 text-blue-700 font-semibold" : "text-slate-600 hover:bg-slate-50"}`}
          >
            Day {t.dayOffset} — Step {t.stepNumber}
            <div className="text-[10px] text-slate-400">v{t.template?.version || 1}</div>
          </button>
        ))}
      </div>
      <div className="flex-1">
        {error && <div className="mb-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>}
        {saved && <div className="mb-2 p-2 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-700">Saved as a new version.</div>}
        <label className="text-[10px] font-bold text-slate-500 uppercase">Subject</label>
        <input
          type="text" value={subject} onChange={(e) => { setSubject(e.target.value); setSaved(false); }}
          disabled={!isAdmin}
          className="w-full mb-3 text-sm border border-slate-200 rounded px-2 py-1.5 disabled:bg-slate-50"
        />
        <label className="text-[10px] font-bold text-slate-500 uppercase">Body (HTML, supports {"{{first_name}}"} / {"{{sales_rep_name}}"})</label>
        <textarea
          value={bodyHtml} onChange={(e) => { setBodyHtml(e.target.value); setSaved(false); }}
          disabled={!isAdmin}
          rows={12}
          className="w-full text-sm border border-slate-200 rounded px-2 py-1.5 font-mono disabled:bg-slate-50"
        />
        {isAdmin ? (
          <button onClick={save} disabled={saving} className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded hover:bg-blue-700 disabled:opacity-50">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save as New Version
          </button>
        ) : (
          <p className="mt-2 text-[11px] text-slate-400">Template editing is admin-only.</p>
        )}
      </div>
    </div>
  );
}

export default function EstimateFollowUps() {
  const [currentUser, setCurrentUser] = useState(null);
  const [tab, setTab] = useState("overview");

  useEffect(() => { railwayApi.me().then((r) => setCurrentUser(r.user)).catch(() => {}); }, []);

  const isAdminOrManager = currentUser && (currentUser.role === "admin" || currentUser.role === "manager");

  // Wait for the role to be known before rendering any tab — otherwise the
  // default Overview tab's own effect would optimistically call the
  // admin-only API before we know whether this user is actually allowed to
  // see it (server-side 403 is the real enforcement either way, but there's
  // no reason to fire the call at all for someone we're about to turn away).
  if (!currentUser) return null;

  if (!isAdminOrManager) {
    return (
      <div className="max-w-xl mx-auto mt-10 bg-white border border-slate-200 rounded-lg p-8 text-center">
        <h2 className="text-lg font-bold text-slate-800 mb-2">Admins and Managers Only</h2>
        <p className="text-sm text-slate-500">This page requires admin or manager access.</p>
        <Link to="/" className="inline-block mt-4 text-sm text-blue-600 hover:underline">← Back to Dashboard</Link>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <Link to="/settings" className="text-slate-400 hover:text-slate-600"><ArrowLeft className="w-5 h-5" /></Link>
        <h1 className="text-xl font-bold text-slate-800">Estimate Follow-Up Automation</h1>
      </div>

      <div className="flex gap-1 mb-4 border-b border-slate-200">
        {[["overview", "Overview"], ["automation", "Automation Status"], ["dry-run", "Dry-Run Report"], ["templates", "Templates"]].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px ${tab === key ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "automation" && <AutomationStatusTab />}
      {tab === "dry-run" && <DryRunReportTab />}
      {tab === "templates" && <TemplateEditorTab isAdmin={currentUser?.role === "admin"} />}
    </div>
  );
}
