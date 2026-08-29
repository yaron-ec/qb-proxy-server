/**
 * HandoffReview — Shows unmatched and needs-review Handoff estimates.
 * Admins can manually attach an estimate to a lead from here.
 */
import { useState, useEffect } from "react";
import { apiCall } from "@/api/railway/client";
import { Link } from "react-router-dom";
import { ArrowLeft, AlertTriangle, Search, CheckCircle, Loader2, FileText, ExternalLink } from "lucide-react";

const fmt = (d) => d
  ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  : "—";

const fmtMoney = (v) => v != null && v > 0
  ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0 })}`
  : "—";

const TAB_LABELS = { needs_review: "Needs Review", unmatched: "Unmatched" };

export default function HandoffReview() {
  const [tab, setTab] = useState("needs_review");
  const [estimates, setEstimates] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [attaching, setAttaching] = useState(null);
  const [search, setSearch] = useState("");
  const [selectedLead, setSelectedLead] = useState({});

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    setLoading(true);
    const [ests, ls] = await Promise.all([
      apiCall('/api/v1/handoff-estimates?limit=200', { method: 'GET' }).then(r => Array.isArray(r) ? r : (r?.items || [])),
      apiCall('/api/v1/leads?limit=500', { method: 'GET' }).then(r => Array.isArray(r) ? r : (r?.items || [])),
    ]);
    setEstimates(ests);
    setLeads(ls);
    setLoading(false);
  };

  const filtered = estimates.filter(e => e.match_status === tab);
  const searched = search.trim()
    ? filtered.filter(e =>
        e.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
        e.customer_email?.toLowerCase().includes(search.toLowerCase()) ||
        e.customer_phone?.includes(search)
      )
    : filtered;

  const handleAttach = async (estimate) => {
    const leadId = selectedLead[estimate.id];
    if (!leadId) return alert("Please select a lead first.");
    setAttaching(estimate.id);

    const lead = leads.find(l => l.id === leadId);
    if (lead) {
      // Attach PDF to lead documents
      if (estimate.document_url) {
        const urls = lead.photo_urls || [];
        if (!urls.includes(estimate.document_url)) {
          await apiCall(`/api/v1/leads/${leadId}`, {
            method: 'PUT',
            body: { photo_urls: [...urls, estimate.document_url] },
          });
        }
      }
    }

    // Mark as matched
    await apiCall(`/api/v1/handoff-estimates/${estimate.id}`, {
      method: 'PUT',
      body: { match_status: "matched", match_method: "manual", lead_id: leadId },
    });

    await load();
    setAttaching(null);
  };

  const needsReviewCount = estimates.filter(e => e.match_status === "needs_review").length;
  const unmatchedCount = estimates.filter(e => e.match_status === "unmatched").length;

  return (
    <div className="flex flex-col h-full bg-[#f5f8fa]">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-4 flex-shrink-0">
        <Link to="/leads" className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-3.5 h-3.5" /> Contacts
        </Link>
        <span className="text-slate-300">/</span>
        <h1 className="text-xs font-black tracking-widest uppercase text-slate-700">Handoff Estimates — Review Queue</h1>
      </div>

      <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto w-full space-y-5">

        {/* Tabs */}
        <div className="flex gap-1 bg-white border border-slate-200 rounded p-1 w-fit">
          {["needs_review", "unmatched"].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-xs font-bold rounded transition-colors flex items-center gap-1.5 ${
                tab === t ? "bg-orange text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t === "needs_review" && <AlertTriangle className="w-3 h-3" />}
              {TAB_LABELS[t]}
              <span className={`px-1.5 py-0.5 rounded text-[9px] font-black ${tab === t ? "bg-white/20" : "bg-slate-100 text-slate-500"}`}>
                {t === "needs_review" ? needsReviewCount : unmatchedCount}
              </span>
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            type="text"
            placeholder="Search by name, email, phone…"
            className="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 rounded bg-white focus:outline-none focus:border-blue-400"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Info box */}
        {tab === "needs_review" && (
          <div className="bg-amber-50 border border-amber-200 rounded p-4 text-sm text-amber-700">
            <strong>Multiple leads matched</strong> — these estimates could not be auto-attached. Select the correct lead and click "Attach".
          </div>
        )}
        {tab === "unmatched" && (
          <div className="bg-slate-50 border border-slate-200 rounded p-4 text-sm text-slate-600">
            No matching lead was found by name + phone or name + email. Select a lead manually to attach.
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-3 py-8 text-slate-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        )}

        {!loading && searched.length === 0 && (
          <div className="py-12 text-center text-slate-400 text-sm">
            <CheckCircle className="w-8 h-8 text-emerald-300 mx-auto mb-2" />
            {tab === "needs_review" ? "No estimates need review" : "No unmatched estimates"}
          </div>
        )}

        <div className="space-y-4">
          {searched.map(est => (
            <div key={est.id} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
              {/* Estimate info */}
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <FileText className="w-5 h-5 text-orange flex-shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-bold text-slate-800">{est.document_title || est.customer_name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {est.customer_phone && <span className="mr-2">📞 {est.customer_phone}</span>}
                      {est.customer_email && <span>✉️ {est.customer_email}</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-600">
                      <span className="font-semibold text-slate-800">{fmtMoney(est.estimate_amount)}</span>
                      <span>{fmt(est.estimate_date)}</span>
                      {est.estimate_status && (
                        <span className="uppercase text-[10px] font-bold text-slate-500">{est.estimate_status}</span>
                      )}
                    </div>
                  </div>
                </div>
                {est.document_url && (
                  <a
                    href={est.document_url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-orange hover:underline flex-shrink-0"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> View PDF
                  </a>
                )}
              </div>

              {/* Lead selector */}
              <div className="flex items-center gap-3">
                <select
                  className="flex-1 border border-slate-200 rounded px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:border-blue-400"
                  value={selectedLead[est.id] || ""}
                  onChange={e => setSelectedLead(p => ({ ...p, [est.id]: e.target.value }))}
                >
                  <option value="">— Select a lead to attach —</option>
                  {leads
                    .filter(l => {
                      // For needs_review: show all; for unmatched: show name-similar first
                      return true;
                    })
                    .map(l => (
                      <option key={l.id} value={l.id}>
                        {l.first_name} {l.last_name}
                        {l.phone ? ` · ${l.phone}` : ""}
                        {l.email ? ` · ${l.email}` : ""}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => handleAttach(est)}
                  disabled={!selectedLead[est.id] || attaching === est.id}
                  className="flex items-center gap-1.5 bg-orange text-white px-4 py-2 text-xs font-bold rounded hover:bg-orange/90 transition-colors disabled:opacity-50"
                >
                  {attaching === est.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                  Attach
                </button>
              </div>

              <div className="text-[9px] text-slate-400">
                Synced {fmt(est.last_synced_at)} · ID: {est.handoff_estimate_id}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}