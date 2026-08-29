/**
 * EstimateSyncDiagnostics — Show sync status for each estimate
 * Displays: Handoff → QB → Base44 flow for every estimate
 */

import { useState, useEffect } from "react";
import * as railwayHandoffEstimates from "@/api/railway/handoffEstimates";
import { CheckCircle, AlertCircle, Loader2, ChevronDown, ChevronRight, Eye } from "lucide-react";

const StatusIcon = ({ exists, status }) => {
  if (status === 'loading') return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />;
  if (exists) return <CheckCircle className="w-4 h-4 text-emerald-500" />;
  return <AlertCircle className="w-4 h-4 text-red-500" />;
};

export default function EstimateSyncDiagnostics() {
  const [estimates, setEstimates] = useState([]);
  const [diagnostics, setDiagnostics] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});

  useEffect(() => {
    loadDiagnostics();
    // Auto-refresh every 30 seconds
    const timer = setInterval(loadDiagnostics, 30000);
    return () => clearInterval(timer);
  }, []);

  const loadDiagnostics = async () => {
    try {
      // Fetch all HandoffEstimates
      const result = await railwayHandoffEstimates.list();
      const handoffEsts = result.items || [];
      setEstimates(handoffEsts);

      // For each estimate, check QB status
      const diags = {};
      for (const est of handoffEsts) {
        diags[est.id] = {
          handoff_id: est.handoff_estimate_id,
          handoff_exists: !!est.handoff_estimate_id,
          qb_exists: !!est.qb_estimate_id,
          qb_estimate_id: est.qb_estimate_id,
          qb_estimate_number: est.qb_estimate_number,
          base44_imported: !!est.lead_id,
          matched_lead_id: est.lead_id,
          matched: est.match_status === 'matched',
          match_status: est.match_status,
          match_method: est.match_method,
          reason: est.match_status === 'unmatched' ? 'No confident match found' : est.match_status === 'needs_review' ? 'Multiple potential matches' : 'Matched',
          amount: est.estimate_amount,
          status: est.estimate_status,
          date: est.estimate_date,
          customer_name: est.customer_name,
        };
      }
      setDiagnostics(diags);
      setLoading(false);
    } catch (e) {
      console.error('[EstimateSyncDiagnostics] Load failed:', e.message);
      setLoading(false);
    }
  };

  const toggleExpanded = (estId) => {
    setExpanded(prev => ({ ...prev, [estId]: !prev[estId] }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-6">
        <Loader2 className="w-5 h-5 animate-spin text-blue-500 mr-2" />
        <span className="text-sm text-slate-600">Loading diagnostics...</span>
      </div>
    );
  }

  if (estimates.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-slate-500">
        No estimates synced yet. When Handoff sends an estimate, it will appear here.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {estimates.map(est => {
        const diag = diagnostics[est.id];
        if (!diag) return null;

        const isExpanded = expanded[est.id];
        const isMatched = diag.matched;
        const color = isMatched ? 'border-emerald-200 bg-emerald-50' : diag.match_status === 'needs_review' ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50';

        return (
          <div key={est.id} className={`border rounded-lg ${color} overflow-hidden`}>
            {/* Header */}
            <button
              onClick={() => toggleExpanded(est.id)}
              className="w-full flex items-center gap-3 p-3 hover:opacity-90 transition-opacity text-left"
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
              )}

              {/* Estimate Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold text-sm">
                    {diag.customer_name} · ${diag.amount?.toLocaleString() || '—'}
                  </span>
                  {isMatched && (
                    <span className="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-semibold">
                      ✓ Matched
                    </span>
                  )}
                  {diag.match_status === 'needs_review' && (
                    <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded font-semibold">
                      ⚠ Needs Review
                    </span>
                  )}
                  {!isMatched && diag.match_status !== 'needs_review' && (
                    <span className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded font-semibold">
                      ✗ Unmatched
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-600">
                  Est: {diag.qb_estimate_number || est.qb_estimate_number || 'N/A'} · {diag.status || 'Draft'} · {diag.date ? new Date(diag.date).toLocaleDateString() : '—'}
                </div>
              </div>

              {/* Status Flow */}
              <div className="flex items-center gap-2 text-xs flex-shrink-0">
                <div className="flex items-center gap-1">
                  <StatusIcon exists={diag.handoff_exists} />
                  <span className="text-[10px]">Handoff</span>
                </div>
                <span className="text-slate-400">→</span>
                <div className="flex items-center gap-1">
                  <StatusIcon exists={diag.qb_exists} />
                  <span className="text-[10px]">QB</span>
                </div>
                <span className="text-slate-400">→</span>
                <div className="flex items-center gap-1">
                  <StatusIcon exists={diag.base44_imported} />
                  <span className="text-[10px]">Base44</span>
                </div>
              </div>
            </button>

            {/* Details */}
            {isExpanded && (
              <div className="border-t border-current border-opacity-20 p-3 space-y-2 bg-white/50 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="font-semibold text-slate-700">Handoff ID</div>
                    <div className="text-slate-600 font-mono text-[10px] break-all">{diag.handoff_id || '—'}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-700">QB Estimate ID</div>
                    <div className="text-slate-600 font-mono text-[10px] break-all">{diag.qb_estimate_id || '—'}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-700">QB Doc Number</div>
                    <div className="text-slate-600 font-mono">{diag.qb_estimate_number || '—'}</div>
                  </div>
                  <div>
                    <div className="font-semibold text-slate-700">Matched Lead</div>
                    <div className="text-slate-600 font-mono">{diag.matched_lead_id ? diag.matched_lead_id.slice(0, 8) + '…' : '—'}</div>
                  </div>
                </div>

                <div className={`rounded p-2 ${isMatched ? 'bg-emerald-100 text-emerald-800' : diag.match_status === 'needs_review' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'}`}>
                  <div className="font-semibold">Match Status</div>
                  <div className="text-[11px] mt-1">{diag.reason}</div>
                  {diag.match_method && (
                    <div className="text-[10px] mt-1">Method: <span className="font-semibold">{diag.match_method}</span></div>
                  )}
                </div>

                <div>
                  <div className="font-semibold text-slate-700">Customer Info</div>
                  <div className="text-slate-600 text-[10px] space-y-0.5 mt-1">
                    <div>📧 {est.customer_email || '—'}</div>
                    <div>📱 {est.customer_phone || '—'}</div>
                  </div>
                </div>

                {est.document_url && (
                  <div>
                    <a
                      href={est.document_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline font-semibold"
                    >
                      <Eye className="w-3 h-3" /> View PDF
                    </a>
                  </div>
                )}

                <div className="text-[9px] text-slate-500 border-t border-current border-opacity-20 pt-2">
                  Last synced: {est.last_synced_at ? new Date(est.last_synced_at).toLocaleString() : '—'}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}