/**
 * HandoffEstimatesPanel
 * Shows QB estimates linked to this lead.
 * - Real-time subscription: banner when a new estimate arrives
 * - Correct empty state based on handoff_estimate_status
 * - QB is the production source of truth; no Handoff API tokens needed
 */
import { useState, useEffect, useRef } from "react";
import { handoffEstimates as railwayHandoffEstimates } from "@/api/railway";
import { syncLeadEstimates, diagnoseLeadEstimates, fetchEstimatePdf, normalizeIntegrationError } from "@/lib/railwayClient";
import {
  FileText, ExternalLink, RefreshCw, Loader2, CheckCircle, AlertTriangle, Clock,
  Download, ShieldCheck, Zap, Search, ChevronDown, ChevronRight, Bell
} from "lucide-react";
import RightPanelEmptyState from "@/components/RightPanelEmptyState";
import RightPanelInfoNotice from "@/components/RightPanelInfoNotice";

const fmt = (d) => d
  ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  : "Ã¢ÂÂ";

const fmtMoney = (v) => v != null && v > 0
  ? `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
  : null;

const STATUS_COLOR = {
  sent:     "bg-blue-50 text-blue-600",
  approved: "bg-emerald-50 text-emerald-600",
  accepted: "bg-emerald-50 text-emerald-600",
  declined: "bg-red-50 text-red-500",
  pending:  "bg-amber-50 text-amber-600",
  draft:    "bg-slate-50 text-slate-500",
};

const AUTO_SYNC_COOLDOWN_MS = 30 * 60 * 1000;

export default function HandoffEstimatesPanel({ lead, onLeadUpdate }) {
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [pdfLoading, setPdfLoading] = useState({});
  const [newEstimateBanner, setNewEstimateBanner] = useState(null); // { count, names }
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagData, setDiagData] = useState(null);
  const [diagExpanded, setDiagExpanded] = useState(false);

  // Track known estimate IDs to detect truly new arrivals from the subscription
  const knownIdsRef = useRef(new Set());
  const initialLoadDoneRef = useRef(false);

  useEffect(() => {
    load().then(() => {
      initialLoadDoneRef.current = true;
      triggerAutoSync();
    });

    // Real-time subscription removed Ã¢ÂÂ Railway has no client-side subscribe.
    // The auto-sync on load + manual refresh button cover the same use case.
  }, [lead.id]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await railwayHandoffEstimates.list({ lead_id: lead.railway_id });
      const data = res.items || [];

      // Dedup by stable identifier (qb_estimate_id, fallback handoff_estimate_id, then id).
      // A race between concurrent sync functions can create duplicate records for the same
      // QB estimate. Keep the best one: matched > needs_review > unmatched, then newest updated.
      const dedupKey = (e) => e.qb_estimate_id || e.handoff_estimate_id || e.id;
      const matchRank = (s) => s === 'matched' ? 2 : s === 'needs_review' ? 1 : 0;
      const byKey = new Map();
      for (const e of data) {
        const k = dedupKey(e);
        const prev = byKey.get(k);
        if (!prev) { byKey.set(k, e); continue; }
        const eRank = matchRank(e.match_status);
        const pRank = matchRank(prev.match_status);
        const better = eRank > pRank ||
          (eRank === pRank && new Date(e.updated_date || e.created_date) > new Date(prev.updated_date || prev.created_date));
        if (better) byKey.set(k, e);
      }
      const deduped = [...byKey.values()];

      const sorted = deduped.sort((a, b) => new Date(b.estimate_date || b.created_date) - new Date(a.estimate_date || a.created_date));
      setEstimates(sorted);
      knownIdsRef.current = new Set(sorted.map(e => e.id));
      const lastSync = sorted.reduce((latest, e) => {
        const t = e.last_synced_at ? new Date(e.last_synced_at).getTime() : 0;
        return t > latest ? t : latest;
      }, 0);
      if (lastSync) setLastSyncedAt(new Date(lastSync));
    } finally {
      setLoading(false);
    }
  };

  const triggerAutoSync = async () => {
    const key = `qb_auto_sync_${lead.id}`;
    const lastRun = parseInt(sessionStorage.getItem(key) || '0', 10);
    if (Date.now() - lastRun < AUTO_SYNC_COOLDOWN_MS) return;
    setAutoSyncing(true);
    try {
      const data = await syncLeadEstimates(lead.id);
      sessionStorage.setItem(key, String(Date.now()));
      if (data?.success) {
        setLastSyncedAt(new Date());
        await load();
      }
    } catch {
      // Silently skip on error Ã¢ÂÂ never surface to the user here
    } finally {
      setAutoSyncing(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    setDiagData(null);
    setNewEstimateBanner(null);
    try {
      const data = await syncLeadEstimates(lead.id);
      sessionStorage.setItem(`qb_auto_sync_${lead.id}`, String(Date.now()));
      if (data?.success) {
        setSyncMsg({ type: 'success', text: data.message || 'Synced successfully' });
        setLastSyncedAt(new Date());
        await load();
      } else {
        setSyncMsg({ type: 'info', text: data?.message || `No QB estimates found yet (scanned ${data?.stats?.total_scanned ?? '?'} records)` });
      }
    } catch (e) {
      setSyncMsg({ type: 'error', text: normalizeIntegrationError(e) });
    } finally {
      setSyncing(false);
    }
  };

  const handleDiagnose = async () => {
    setDiagnosing(true);
    setSyncMsg(null);
    setDiagData(null);
    try {
      const data = await diagnoseLeadEstimates(lead.id);
      setDiagData(data);
      setDiagExpanded(true);
    } catch (e) {
      setSyncMsg({ type: 'error', text: 'Diagnose failed: ' + normalizeIntegrationError(e) });
    } finally {
      setDiagnosing(false);
    }
  };

  const handleSavePdf = async (est) => {
    setPdfLoading(prev => ({ ...prev, [est.id]: true }));
    setSyncMsg(null);
    try {
      const data = await fetchEstimatePdf(est.id);
      if (data?.ok) {
        setSyncMsg({ type: 'success', text: 'PDF saved to Deal & Attachments' });
        await load();
      } else {
        setSyncMsg({ type: 'error', text: data?.error || 'PDF fetch failed' });
      }
    } catch (e) {
      setSyncMsg({ type: 'error', text: normalizeIntegrationError(e) });
    } finally {
      setPdfLoading(prev => ({ ...prev, [est.id]: false }));
    }
  };

  const getSourceLabel = (est) => {
    if (est.handoff_estimate_number || est.sync_source === 'Handoff' || est.source === 'Handoff') return 'Handoff';
    if (est.sync_source === 'Handoff via QuickBooks') return 'Handoff via QB';
    return est.sync_source || 'QuickBooks';
  };

  const getSourceBadgeColor = (label) => {
    if (label === 'Handoff' || label === 'Handoff via QB') return 'bg-purple-50/60 border-purple-100 text-purple-600';
    return 'bg-blue-50/60 border-blue-100 text-blue-600';
  };

  const fmtRelTime = (d) => {
    if (!d) return null;
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  };

  // Determine correct empty state
  const isAwaitingQB = lead.handoff_estimate_status === 'awaiting_qb';
  const hasHandoffProject = isAwaitingQB || !!lead.handoff_project_number || !!lead.handoff_project_id;

  return (
    <div>
      {/* Slim action toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          {lastSyncedAt && !autoSyncing && (
            <span className="text-[10px] text-slate-400" title={lastSyncedAt.toLocaleString()}>{fmtRelTime(lastSyncedAt)}</span>
          )}
          {autoSyncing && (
            <span className="flex items-center gap-1 text-[10px] text-blue-500">
              <Loader2 className="w-2.5 h-2.5 animate-spin" /> syncingÃ¢ÂÂ¦
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleDiagnose} disabled={diagnosing || syncing || autoSyncing}
            className="text-slate-300 hover:text-blue-500 transition-colors disabled:opacity-40 btn-compact" title="Diagnose QB match">
            {diagnosing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          </button>
          <button onClick={handleSync} disabled={syncing || loading || autoSyncing}
            className="text-slate-300 hover:text-slate-600 transition-colors disabled:opacity-40 btn-compact" title="Sync from QuickBooks">
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div>
        {/* Ã¢ÂÂÃ¢ÂÂ NEW ESTIMATE ARRIVAL BANNER Ã¢ÂÂÃ¢ÂÂ */}
        {newEstimateBanner && (
          <div className="mx-3 mt-2 mb-1 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-50 border border-emerald-300 text-xs font-semibold text-emerald-800">
            <Bell className="w-3.5 h-3.5 flex-shrink-0 text-emerald-600" />
            <span>New estimate synced from QuickBooks: <span className="font-bold">{newEstimateBanner.label}</span></span>
            <button onClick={() => setNewEstimateBanner(null)} className="ml-auto text-emerald-500 hover:text-emerald-700 btn-compact text-lg leading-none">ÃÂ</button>
          </div>
        )}

        {/* Ã¢ÂÂÃ¢ÂÂ SYNC MESSAGE Ã¢ÂÂÃ¢ÂÂ */}
        {syncMsg && (
          <div className={`mx-3 mb-2 mt-2 px-3 py-2 rounded-lg text-xs font-semibold ${
            syncMsg.type === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
            syncMsg.type === 'info'    ? 'bg-blue-50 text-blue-700 border border-blue-200' :
            'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {syncMsg.text}
          </div>
        )}

        {/* Ã¢ÂÂÃ¢ÂÂ DIAGNOSTICS PANEL Ã¢ÂÂÃ¢ÂÂ */}
        {diagData && (
          <div className="mx-3 mb-2 border border-blue-200 rounded-lg bg-blue-50 overflow-hidden">
            <button
              onClick={() => setDiagExpanded(e => !e)}
              className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold text-blue-800"
            >
              <span className="flex items-center gap-1.5">
                <Search className="w-3 h-3" />
                QB Estimate Diagnostics
                {(diagData.matchedEstimates + (diagData.matchedInvoicesCount || 0)) > 0
                  ? <span className="bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">Ã¢ÂÂ {diagData.matchedEstimates} estimates ÃÂ· {diagData.matchedInvoicesCount || 0} invoices</span>
                  : <span className="bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">Ã¢ÂÂ nothing found in QB yet</span>
                }
              </span>
              {diagExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
            {diagExpanded && (
              <div className="px-3 pb-3 space-y-2 text-[9px]">
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  <div><span className="text-blue-500 uppercase tracking-wide">CRM Name</span><div className="font-bold text-blue-900">{diagData.crmDealName}</div></div>
                  <div><span className="text-blue-500 uppercase tracking-wide">CRM Phone</span><div className="font-semibold text-blue-900">{diagData.crmPhone || 'Ã¢ÂÂ'}</div></div>
                  <div><span className="text-blue-500 uppercase tracking-wide">QB Estimates</span><div className="font-bold text-blue-900">{diagData.totalEstimatesInQB} total ÃÂ· {diagData.matchedEstimates} matched</div></div>
                  <div><span className="text-blue-500 uppercase tracking-wide">QB Invoices</span><div className="font-bold text-blue-900">{diagData.totalInvoicesInQB} total ÃÂ· {diagData.matchedInvoicesCount || 0} matched</div></div>
                </div>
                {diagData.matchedEstimates > 0 && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded p-2">
                    <div className="font-bold text-emerald-800 mb-1">QB Estimates found:</div>
                    {diagData.matchedEstimateDetails?.map((d, i) => (
                      <div key={i} className="text-emerald-700">#{d.docNumber} Ã¢ÂÂ ${d.amount} Ã¢ÂÂ {d.status} Ã¢ÂÂ via {d.matchMethod}</div>
                    ))}
                  </div>
                )}
                {diagData.matchedEstimates === 0 && (diagData.matchedInvoicesCount || 0) === 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded p-2">
                    <div className="font-bold text-amber-800 mb-1">Not in QB yet. QB estimate names (first 15):</div>
                    {diagData.allEstimatesSample?.slice(0, 15).map((e, i) => (
                      <div key={i} className="text-amber-700">#{e.docNumber}: "{e.customerRefName}"</div>
                    ))}
                  </div>
                )}
                {(diagData.matchedEstimates + (diagData.matchedInvoicesCount || 0)) > 0 && (
                  <button onClick={handleSync} disabled={syncing}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-emerald-400 bg-white text-emerald-700 hover:bg-emerald-100 transition-colors">
                    {syncing ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
                    Import & Sync Now
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {loading && estimates.length === 0 && (
          <div className="flex items-center gap-2 py-3 typography-helper-text px-4">
            <Loader2 className="w-3 h-3 animate-spin" /> LoadingÃ¢ÂÂ¦
          </div>
        )}

        {/* Ã¢ÂÂÃ¢ÂÂ EMPTY STATE Ã¢ÂÂ context-aware Ã¢ÂÂÃ¢ÂÂ */}
        {!loading && estimates.length === 0 && (
          hasHandoffProject ? (
            // Project exists in Handoff but not yet invoiced in QB
            <div className="mx-3 my-3 flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200">
              <Clock className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-amber-800">
                  Project exists in Handoff Ã¢ÂÂ awaiting QuickBooks estimate
                </p>
                <p className="text-[11px] text-amber-700 mt-0.5">
                  {lead.handoff_project_number ? `Project ${lead.handoff_project_number} has` : 'This project has'} been estimated in Handoff but the estimate has not yet been created in QuickBooks.
                  Once it's added to QB, it will automatically sync here within 15 minutes.
                </p>
              </div>
            </div>
          ) : (
            <RightPanelEmptyState
              icon={FileText}
              title={autoSyncing ? 'Checking QuickBooksÃ¢ÂÂ¦' : 'No QB estimates yet'}
              description={autoSyncing ? 'Scanning QuickBooks recordsÃ¢ÂÂ¦' : 'Estimates will appear here automatically once created in QuickBooks.'}
            />
          )
        )}

        {/* Ã¢ÂÂÃ¢ÂÂ ESTIMATE CARDS Ã¢ÂÂÃ¢ÂÂ */}
        {estimates.length > 0 && (
          <div className="space-y-2 px-3 pb-2 pt-2">
            {estimates.map(est => {
              const sourceLabel = getSourceLabel(est);
              const hasPdf = est.pdf_status === 'ready' && !!est.pdf_url;
              const pdfPending = est.pdf_status === 'syncing' || est.pdf_status === 'pending';
              const pdfFailed = est.pdf_status === 'failed';
              const isLoadingPdf = pdfLoading[est.id];
              const customerDisplayName = est.customer_name
                ? (est.customer_name.includes(':') ? est.customer_name.split(':')[0].trim() : est.customer_name)
                : null;
              const isNew = newEstimateBanner && est === estimates[0];

              return (
                <div key={est.id} className={`border rounded-lg p-3 transition-all ${
                  isNew ? 'border-emerald-300 bg-emerald-50/30 ring-1 ring-emerald-200' :
                  est.match_status === "unmatched"    ? "border-red-200/60 bg-red-50/20" :
                  est.match_status === "needs_review" ? "border-amber-200/60 bg-amber-50/20" :
                  hasPdf ? "border-emerald-200/60 bg-emerald-50/10" :
                  "border-slate-200/80 bg-white"
                }`}>
                  {/* Header: title + amount (amount prominent, right-aligned) */}
                  <div className="flex items-start justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <FileText className="w-3.5 h-3.5 text-orange flex-shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold text-slate-800 leading-tight truncate" title={est.document_title || `Estimate ${est.qb_estimate_number || est.id}`}>
                          {est.document_title || `Estimate ${est.qb_estimate_number || est.id}`}
                        </p>
                        {customerDisplayName && (
                          <p className="text-[10px] text-slate-500 leading-tight truncate mt-0.5">{customerDisplayName}</p>
                        )}
                      </div>
                    </div>
                    {fmtMoney(est.estimate_amount) && (
                      <span className="text-sm font-bold text-slate-900 flex-shrink-0 tabular-nums">{fmtMoney(est.estimate_amount)}</span>
                    )}
                  </div>

                  {/* Details: Estimate #, Handoff #, Date \u2014 clean rows, no awkward breaks */}
                  <div className="space-y-1 mb-2.5">
                    {est.qb_estimate_number && (
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="text-slate-400 uppercase tracking-wide flex-shrink-0">Estimate #</span>
                        <span className="font-bold text-blue-600 truncate" title={est.qb_estimate_number}>{est.qb_estimate_number}</span>
                      </div>
                    )}
                    {est.handoff_estimate_number && (
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="text-slate-400 uppercase tracking-wide flex-shrink-0">Handoff #</span>
                        <span className="font-bold text-purple-600 truncate" title={est.handoff_estimate_number}>{est.handoff_estimate_number}</span>
                      </div>
                    )}
                    {est.estimate_date && (
                      <div className="flex items-center justify-between gap-2 text-[10px]">
                        <span className="text-slate-400 uppercase tracking-wide flex-shrink-0">Date</span>
                        <span className="font-semibold text-slate-600 flex-shrink-0">{fmt(est.estimate_date)}</span>
                      </div>
                    )}
                  </div>

                  {/* Status + source in a single compact row */}
                  <div className="flex items-center gap-1 flex-wrap mb-2.5">
                    {est.estimate_status && (
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${STATUS_COLOR[est.estimate_status?.toLowerCase()] || "bg-slate-100 text-slate-600"}`}>
                        {est.estimate_status}
                      </span>
                    )}
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${getSourceBadgeColor(sourceLabel)}`}>
                      {sourceLabel}
                    </span>
                    {hasPdf && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50/60 border border-emerald-100 text-emerald-600 flex items-center gap-0.5">
                        <ShieldCheck className="w-2.5 h-2.5" /> PDF
                      </span>
                    )}
                  </div>

                  {/* Action buttons \u2014 aligned consistently */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {hasPdf && est.qb_app_url && (
                      <a href={est.qb_app_url} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-emerald-200/60 bg-emerald-50/60 text-emerald-600 hover:bg-emerald-50 transition-colors">
                        <Download className="w-2.5 h-2.5" /> View PDF
                      </a>
                    )}
                    {!hasPdf && !pdfPending && est.qb_estimate_id && (
                      <button onClick={() => handleSavePdf(est)} disabled={isLoadingPdf}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-orange/30 bg-orange/5 text-orange hover:bg-orange/10 transition-colors disabled:opacity-50">
                        {isLoadingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Zap className="w-2.5 h-2.5" />}
                        {isLoadingPdf ? 'Saving\u2026' : 'Save PDF'}
                      </button>
                    )}
                    {pdfFailed && !isLoadingPdf && est.qb_estimate_id && (
                      <button onClick={() => handleSavePdf(est)}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 transition-colors">
                        <AlertTriangle className="w-2.5 h-2.5" /> Retry PDF
                      </button>
                    )}
                    {(pdfPending || isLoadingPdf) && !hasPdf && (
                      <span className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-blue-200 bg-blue-50 text-blue-600">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" /> Saving PDF\u2026
                      </span>
                    )}
                    {!est.pdf_url && est.document_url && !pdfPending && (
                      <a href={est.document_url} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors">
                        <ExternalLink className="w-2.5 h-2.5" /> View doc
                      </a>
                    )}
                    {est.qb_app_url && (
                      <a href={est.qb_app_url} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 transition-colors ml-auto">
                        <ExternalLink className="w-2.5 h-2.5" /> Open in QB
                      </a>
                    )}
                  </div>

                  {est.match_status === "needs_review" && (
                    <div className="mt-2">
                      <RightPanelInfoNotice title="Multiple leads found" description="This estimate needs manual review to match the correct lead" type="warning" />
                    </div>
                  )}
                  {est.match_status === "unmatched" && (
                    <div className="mt-2">
                      <RightPanelInfoNotice title="No matching lead" description="See the unmatched estimates queue to manually assign this" type="error" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}